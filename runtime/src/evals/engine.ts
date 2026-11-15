import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { selectedTeam } from '../integrations/team-loader.js';
import { Telemetry } from '../diagnostics/telemetry.js';
import { NativeGuidance } from '../integrations/native-guidance.js';
import type { EvalEngine } from './service.js';
import {
  aggregate,
  assertEvaluationSandbox,
  runTask,
  type Arm,
  type Scenario,
  type EvaluationResult,
} from './runner.js';
import {
  copyGuidance,
  EVAL_MODEL,
  FIXTURE_REVISION,
  hash,
  resolveEvaluationContext,
  snapshotWorkspace,
  resourceIdentity,
  type EvaluationContext,
} from './setup.js';

const SCENARIOS: Scenario[] = ['read-only', 'no-op', 'targeted-fix'];
const ENDPOINT = 'http://127.0.0.1:11434';
type EngineOptions = {
  resources: string;
  appRoot?: string;
  nodeExecutable?: string;
  python?: string;
  teamSelection?: string;
  context?: EvaluationContext;
  endpoint?: string;
};

/** One engine shared by CLI and Paseo; setup preparation never selects a separate execution path. */
export function createEvalEngine(options: EngineOptions): EvalEngine {
  return async ({ preset, setup, staticOnly, workspaceRoot, runDirectory, signal, progress }) => {
    const context =
      options.context ??
      resolveEvaluationContext({
        python: options.python ?? process.env.LTCOOK_PYTHON ?? '',
        setup,
        workspaceRoot,
        teamSelection: options.teamSelection ?? process.env.LTCOOK_TEAM ?? 'default-minimal',
      });
    const team = await selectedTeam(context.teamSelection);
    const appRoot = options.appRoot ?? path.resolve(options.resources, '../..');
    const endpoint = options.endpoint ?? ENDPOINT;
    const metadata = {
      teamSelection: context.teamSelection,
      model: EVAL_MODEL,
      fixtureRevision: FIXTURE_REVISION,
      limitations: [
        ...context.limitations,
        'Interactive Plan approval is outside evaluation coverage.',
        setup === 'current'
          ? 'Current Setup evaluates the selected configuration under local Spark; results do not describe another model.'
          : 'Synthetic Setup uses the packaged fixture under local Spark.',
        'Filesystem confinement preserves configured network behavior and does not prevent network side effects.',
        'User executable Pi extensions and authenticated integrations are not exercised.',
        'The snapshot has an independent Git index without original history, remotes or hooks.',
        'Nested repositories/submodules and symbolic links are excluded from snapshots.',
      ],
      provenance: {} as Record<string, unknown>,
    };
    const temporary = await mkdtemp(path.join(runDirectory, '.execution-'));
    const source = path.join(temporary, 'source');
    const guidance = path.join(temporary, 'guidance');
    const results: Record<string, unknown> = {};
    const traceEvents: unknown[] = [];
    let completed = 0;
    const total = staticOnly
      ? 1
      : preset === 'quick'
        ? 2
        : preset === 'audit'
          ? 2
          : preset === 'behavior'
            ? 6
            : preset === 'bottlenecks'
              ? 18
              : 26;
    try {
      signal.throwIfAborted();
      const files = await snapshotWorkspace(
        setup === 'current' ? workspaceRoot : undefined,
        source,
      );
      const guidanceFiles = await copyGuidance(
        setup === 'current' ? context.guidanceDirectory : '',
        guidance,
      );
      metadata.provenance = {
        workspace:
          setup === 'synthetic'
            ? 'packaged-fixture'
            : workspaceRoot
              ? 'registered-workspace-snapshot'
              : 'global-configuration',
        files,
        guidanceFiles,
        configurationSha256: hash(
          JSON.stringify({
            team: context.teamSelection,
            web: context.webConfiguration,
            model: EVAL_MODEL,
            limits: { timeoutMs: 120000, toolCalls: 64 },
          }),
        ),
        fixtureRevision: FIXTURE_REVISION,
      };
      progress({ event: 'suite.started', suite: 'preparation', completed, total, metadata });
      if (['audit', 'full', 'quick'].includes(preset)) {
        progress({ event: 'suite.started', suite: 'instruction-static', completed, total });
        results.static = await staticAudit({
          team,
          workspace: source,
          guidance,
          resources: options.resources,
        });
        completed++;
        progress({
          event: 'case.completed',
          suite: 'instruction-static',
          case: 'loaded resource inventory',
          completed,
          total,
        });
      }
      if (staticOnly) return { result: { preset, setup, results }, trace: null, metadata };
      const health = await fetch(`${endpoint}/api/tags`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) as NonNullable<
          Parameters<typeof fetch>[1]
        >['signal'],
      });
      if (!health.ok)
        throw new Error('Local Ollama is unavailable; start the configured local service.');
      const catalog = (await health.json()) as { models?: Array<{ name?: string }> };
      if (!catalog.models?.some(({ name }) => name === EVAL_MODEL))
        throw new Error(
          `Local Spark model ${EVAL_MODEL} is not installed; no fallback was attempted.`,
        );
      assertEvaluationSandbox();
      const nodeExecutable =
        options.nodeExecutable ??
        process.env.LTCOOK_NODE_EXECUTABLE ??
        spawnSync('node', ['-p', 'process.execPath'], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH },
          timeout: 5000,
        }).stdout?.trim();
      if (!nodeExecutable)
        throw new Error('The native Node executable is unavailable for evaluation.');
      const run = async (
        scenario: Scenario,
        arm: Arm,
        repetition: number,
        thinking: 'off' | 'low',
      ): Promise<Omit<EvaluationResult, 'trace'>> => {
        signal.throwIfAborted();
        const started = performance.now();
        const directory = await mkdtemp(path.join(temporary, 'case-'));
        await cp(source, path.join(directory, 'workspace'), { recursive: true });
        await cp(guidance, path.join(directory, 'guidance'), { recursive: true });
        const git = (args: string[]) =>
          spawnSync('git', ['-C', path.join(directory, 'workspace'), ...args], {
            encoding: 'utf8',
            env: {
              PATH: process.env.PATH,
              HOME: directory,
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
            },
          });
        git(['init', '-q']);
        git(['add', '.']);
        const value = await runTask(
          {
            directory,
            appRoot,
            nodeExecutable,
            teamSelection: context.teamSelection,
            arm,
            scenario,
            thinking,
            endpoint,
            timeoutMs: 120000,
            webConfiguration: context.webConfiguration,
          },
          signal,
        );
        traceEvents.push(...value.trace.traceEvents);
        const { trace: _trace, ...attempt } = value;
        return { ...attempt, elapsedMs: performance.now() - started };
      };
      if (preset === 'audit' || preset === 'full') {
        progress({ event: 'suite.started', suite: 'instruction-semantic', completed, total });
        const sample = await run('read-only', 'complete', 0, 'off');
        const effectivePrompt = sample.instructions.effectivePrompt;
        if (!effectivePrompt)
          throw new Error('Native Pi did not expose an effective prompt for semantic audit.');
        const chunks = effectivePrompt.match(/[\s\S]{1,12000}/g) ?? [];
        const findings: unknown[] = [];
        const semanticTrace = path.join(temporary, 'semantic.trace.json');
        const semanticTelemetry = new Telemetry(
          path.join(temporary, 'semantic.jsonl'),
          semanticTrace,
        );
        for (const [index, chunk] of chunks.entries()) {
          const span = semanticTelemetry.begin('model.semantic-audit');
          try {
            const response = await fetch(`${endpoint}/api/chat`, {
              method: 'POST',
              signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) as NonNullable<
                Parameters<typeof fetch>[1]
              >['signal'],
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                model: EVAL_MODEL,
                stream: false,
                think: false,
                options: { num_ctx: 8192 },
                format: 'json',
                messages: [
                  {
                    role: 'user',
                    content: `Inspect these effective native Pi instructions for ambiguity, overlap and unnecessary work. Return JSON {findings:[{issue,suggestion}]}. Findings are suggestions requiring review.\n\n${chunk}`,
                  },
                ],
              }),
            });
            if (!response.ok)
              throw new Error(
                `Local semantic audit failed (${response.status}); no fallback was attempted.`,
              );
            const content = (await response.json()) as { message?: { content?: string } };
            const generated = JSON.parse(content.message?.content ?? '{}') as {
              findings?: unknown[];
            };
            if (!Array.isArray(generated.findings))
              throw new Error('Semantic audit returned invalid findings');
            findings.push(
              ...generated.findings.map((finding) => ({ suggestion: finding, chunk: index + 1 })),
            );
          } finally {
            span.end();
          }
        }
        await semanticTelemetry.exportTrace();
        traceEvents.push(
          ...(JSON.parse(await readFile(semanticTrace, 'utf8')) as { traceEvents: unknown[] })
            .traceEvents,
        );
        results.semantic = {
          findings,
          chunkCount: chunks.length,
          classification: 'suggestions-requiring-review',
          promptSha256: hash(effectivePrompt),
          coverageComplete: false,
          coverageNote:
            'Effective prompts of agents participating in the runtime capture; inactive members and interactive Plan approval are not covered.',
        };
        completed++;
        progress({
          event: 'case.completed',
          suite: 'instruction-semantic',
          case: 'effective native Pi prompt',
          completed,
          total,
        });
      }
      const runSuite = async (
        suite: string,
        scenarios: Scenario[],
        repetitions: number,
        arms: Arm[],
        retryFailed: boolean,
      ) => {
        const tasks = [];
        for (const scenario of scenarios)
          for (let repetition = 0; repetition < repetitions; repetition++) {
            for (const arm of repetition % 2 ? [...arms].reverse() : arms) {
              progress({
                event: 'case.started',
                suite,
                case: `${scenario} · ${arm} · ${repetition + 1}/${repetitions}`,
                completed,
                total,
              });
              const attempts = [await run(scenario, arm, repetition, 'off')];
              if (!attempts[0]!.success && retryFailed)
                attempts.push(await run(scenario, arm, repetition, 'low'));
              const latest = attempts.at(-1)!;
              tasks.push({
                arm,
                scenario,
                repetition,
                attempts,
                success: latest.success,
                initialSuccess: attempts[0]!.success,
                elapsedMs: attempts.reduce((sum, attempt) => sum + attempt.elapsedMs, 0),
              });
              completed++;
              progress({
                event: latest.success ? 'case.completed' : 'case.failed',
                suite,
                case: `${scenario} · ${arm}`,
                completed,
                total,
                message: latest.failure,
              });
            }
          }
        return { tasks, aggregates: aggregate(tasks) };
      };
      if (preset === 'quick')
        results.behavior = await runSuite('behavior', ['targeted-fix'], 1, ['complete'], true);
      if (preset === 'behavior' || preset === 'full')
        results.behavior = await runSuite('behavior', SCENARIOS, 1, ['minimal', 'complete'], true);
      if (preset === 'bottlenecks' || preset === 'full')
        results.bottlenecks = await runSuite(
          'bottlenecks',
          SCENARIOS,
          3,
          ['minimal', 'complete'],
          false,
        );
      return {
        result: { preset, setup, model: EVAL_MODEL, results },
        trace: { traceEvents },
        metadata,
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
}

/** Native resource parsing and guidance composition without a model or executable extensions. */
async function staticAudit(input: {
  team: Awaited<ReturnType<typeof selectedTeam>>;
  workspace: string;
  guidance: string;
  resources: string;
}) {
  const resources = [];
  const findings: Array<Record<string, unknown>> = [];
  for (const member of input.team.definition.members) {
    let guidance: NativeGuidance;
    try {
      guidance = new NativeGuidance(input.team, member.key, input.guidance, input.resources);
    } catch (error) {
      findings.push({
        kind: 'resource-load-error',
        member: member.key,
        reason: (error instanceof Error ? error.message : 'Native resource loading failed')
          .replaceAll(input.resources, '<core>')
          .replaceAll(input.guidance, '<user>')
          .replaceAll(input.workspace, '<project>'),
      });
      continue;
    }
    const loader = new DefaultResourceLoader({
      cwd: input.workspace,
      agentDir: input.guidance,
      settingsManager: SettingsManager.inMemory({}),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: guidance.skillPaths,
      skillsOverride: guidance.skillsOverride,
      agentsFilesOverride: guidance.agentsFilesOverride,
    });
    try {
      await loader.reload();
    } catch (error) {
      findings.push({
        kind: 'resource-load-error',
        member: member.key,
        reason: error instanceof Error ? error.message : 'Native resource loading failed',
      });
    }
    for (const resource of guidance.inspection.resources) {
      if (resource.loaded) {
        const words = (await readFile(resource.path, 'utf8')).split(/\s+/).length;
        if (words > 3000)
          findings.push({
            kind: 'large_resource',
            member: member.key,
            source: resourceIdentity(resource, input.workspace, input.guidance),
            words,
          });
      }
      resources.push({
        member: member.key,
        ...resource,
        name: path.isAbsolute(resource.name) ? path.basename(resource.name) : resource.name,
        path: resourceIdentity(resource, input.workspace, input.guidance),
        ...(resource.loaded ? { sha256: hash(await readFile(resource.path)) } : {}),
      });
    }
  }
  const seen = new Map<string, string>();
  for (const resource of resources)
    if (resource.sha256) {
      const prior = seen.get(resource.sha256);
      if (prior && prior !== resource.path)
        findings.push({ kind: 'duplicate', sources: [prior, resource.path] });
      seen.set(resource.sha256, resource.path);
    }
  return {
    resources,
    resourceCount: resources.length,
    loadedResourceCount: resources.filter((resource) => resource.loaded).length,
    uniqueContentCount: seen.size,
    findings,
    coverageComplete: false,
    coverageNote:
      'Production guidance and Pi resource loaders; executable extension-generated instructions require semantic runtime capture.',
  };
}

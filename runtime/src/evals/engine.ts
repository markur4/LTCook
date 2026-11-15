import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { loadTeam } from '../integrations/team-loader.js';
import { Telemetry } from '../diagnostics/telemetry.js';
import { NativeGuidance } from '../integrations/native-guidance.js';
import type { EvalBudget, EvalEngine } from './service.js';
import { evaluationCaseCount } from './contracts.js';
import { AgentRuntimeCommandInputSchema } from '../workflow-api/commands.js';
import {
  assertEvaluationSandbox,
  runTask,
  type Scenario,
  type EvaluationResult,
} from './runner.js';
import {
  copyGuidance,
  EVAL_MODEL,
  EVAL_COMPACTION,
  EVAL_MODEL_COMPAT,
  EVAL_MAX_OUTPUT_TOKENS,
  EVALUATION_EXECUTION_CONTEXT,
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

type EvaluationAttempt = Omit<EvaluationResult, 'trace'> & {
  failureCategory?: string;
  thinking: 'off' | 'low';
  budget: EvalBudget;
};

/** One engine shared by CLI and Paseo; setup preparation never selects a separate execution path. */
export function createEvalEngine(options: EngineOptions): EvalEngine {
  return async ({
    preset,
    setup,
    staticOnly,
    workspaceRoot,
    teamSelection,
    limitations = [],
    runDirectory,
    signal,
    progress,
    repetitions = 1,
    scenario: selectedScenario,
    checkpoint,
    budget,
    learned,
    timingHardware,
  }) => {
    const context =
      options.context ??
      resolveEvaluationContext({
        python: options.python ?? process.env.LTCOOK_PYTHON ?? '',
        setup,
        workspaceRoot,
        teamSelection:
          teamSelection ?? options.teamSelection ?? process.env.LTCOOK_TEAM ?? 'default-minimal',
      });
    const team = await loadTeam(context.teamSelection);
    const appRoot = options.appRoot ?? path.resolve(options.resources, '../..');
    const endpoint = options.endpoint ?? ENDPOINT;
    const metadata = {
      teamSelection: context.teamSelection,
      model: EVAL_MODEL,
      fixtureRevision: FIXTURE_REVISION,
      limitations: [
        ...limitations,
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
    const total = evaluationCaseCount({
      preset,
      setup,
      staticOnly,
      repetitions,
      scenario: selectedScenario,
    });
    const flush = async () =>
      checkpoint?.({
        result: { preset, setup, repetitions, results },
        trace: { traceEvents },
        metadata,
      });
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
        evaluationExecutionContextSha256: hash(EVALUATION_EXECUTION_CONTEXT),
        configurationSha256: hash(
          JSON.stringify({
            team: context.teamSelection,
            web: context.webConfiguration,
            model: EVAL_MODEL,
            limits: { timeoutMs: 120000, toolCalls: 64 },
            compaction: EVAL_COMPACTION,
            modelCompat: EVAL_MODEL_COMPAT,
            maxOutputTokens: EVAL_MAX_OUTPUT_TOKENS,
          }),
        ),
        fixtureRevision: FIXTURE_REVISION,
      };
      progress({ event: 'suite.started', suite: 'preparation', completed, total, metadata });
      const inventory = await staticAudit({
        team,
        workspace: source,
        guidance,
        resources: options.resources,
      });
      if (['audit', 'full', 'quick'].includes(preset)) {
        progress({ event: 'suite.started', suite: 'instruction-static', completed, total });
        results.static = inventory;
        completed++;
        progress({
          event: 'case.completed',
          suite: 'instruction-static',
          case: 'loaded resource inventory',
          completed,
          total,
        });
      }
      await flush();
      if (staticOnly) return { result: { preset, setup, results }, trace: null, metadata };
      const health = await fetch(`${endpoint}/api/tags`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) as NonNullable<
          Parameters<typeof fetch>[1]
        >['signal'],
      });
      if (!health.ok)
        throw new Error('Local Ollama is unavailable; start the configured local service.');
      const catalog = (await health.json()) as {
        models?: Array<{ name?: string; digest?: string }>;
      };
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
      const modelDigest = catalog.models?.find(({ name }) => name === EVAL_MODEL)?.digest;
      const provenanceKey = `${timingHardware && modelDigest ? '' : 'unverified:'}${hash(
        JSON.stringify({
          setup,
          team: team.definition,
          configuration: metadata.provenance,
          resources: inventory.resources,
          modelDigest: modelDigest ?? null,
          toolSchema: AgentRuntimeCommandInputSchema,
          hardware: timingHardware ?? null,
        }),
      )}`;
      Object.assign(metadata.provenance, {
        modelDigest: modelDigest ?? null,
        timingHardware: timingHardware ?? 'unverified',
        timingProvenanceKey: provenanceKey,
      });
      if (!timingHardware)
        metadata.limitations.push(
          'Inference hardware is unverified; successful history from another run is not reused.',
        );
      const run = async (
        scenario: Scenario,
        thinking: 'off' | 'low',
        onMeasured: (attempt: EvaluationAttempt) => Promise<void>,
      ): Promise<EvaluationAttempt> => {
        signal.throwIfAborted();
        const identity = { scenario, thinking, provenanceKey };
        const allowance = budget?.(identity) ?? {
          timeoutMs: 120000,
          referenceRuns: [],
          expectedMs: null,
        };
        const attemptSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.ceil(allowance.timeoutMs)),
        ]);
        const started = performance.now();
        const directory = await mkdtemp(path.join(temporary, 'case-'));
        let value: EvaluationResult & { failureCategory?: string };
        try {
          // > Reflinks preserve independent writes and fall back to copying when unsupported.
          const copyOptions = { recursive: true, mode: constants.COPYFILE_FICLONE };
          await cp(source, path.join(directory, 'workspace'), copyOptions);
          await cp(guidance, path.join(directory, 'guidance'), copyOptions);
          attemptSignal.throwIfAborted();
          const git = (args: string[]) =>
            spawnSync('git', ['-C', path.join(directory, 'workspace'), ...args], {
              encoding: 'utf8',
              timeout: Math.max(1, Math.ceil(allowance.timeoutMs - (performance.now() - started))),
              env: {
                PATH: process.env.PATH,
                HOME: directory,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
              },
            });
          for (const args of [
            ['init', '-q'],
            ['add', '.'],
          ]) {
            const result = git(args);
            if (result.status !== 0) throw new Error('Evaluation workspace Git preparation failed');
          }
          attemptSignal.throwIfAborted();
          value = await runTask(
            {
              directory,
              appRoot,
              nodeExecutable,
              teamSelection: context.teamSelection,
              arm: 'complete',
              scenario,
              thinking,
              endpoint,
              timeoutMs: Math.max(1, allowance.timeoutMs - (performance.now() - started)),
              webConfiguration: context.webConfiguration,
            },
            attemptSignal,
          );
          if (attemptSignal.aborted && !signal.aborted) {
            value = {
              ...value,
              success: false,
              failureCategory: 'limits',
              failure: 'Case exceeded its history-based safeguard',
            };
          }
        } catch (error) {
          value = {
            success: false,
            failureCategory: signal.aborted
              ? 'cancelled'
              : attemptSignal.aborted
                ? 'limits'
                : 'runtime',
            failure: error instanceof Error ? error.message : 'Evaluation execution failed',
            elapsedMs: 0,
            toolCalls: 0,
            instructions: { resources: [] },
            trace: { traceEvents: [] },
          };
        }
        traceEvents.push(...value.trace.traceEvents);
        const { trace: _trace, ...measured } = value;
        const attempt = {
          ...measured,
          elapsedMs: performance.now() - started,
          thinking,
          budget: allowance,
        };
        try {
          await onMeasured(attempt);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
        attempt.elapsedMs = performance.now() - started;
        if (attemptSignal.aborted) {
          attempt.success = false;
          attempt.failureCategory = signal.aborted ? 'cancelled' : 'limits';
          attempt.failure = signal.aborted
            ? 'Evaluation cancelled'
            : 'Case exceeded its history-based safeguard';
        }
        await learned?.(identity, { elapsedMs: attempt.elapsedMs, success: attempt.success });
        return attempt;
      };
      const auditPrompt = async (sample: Awaited<ReturnType<typeof run>>) => {
        progress({ event: 'suite.started', suite: 'instruction-semantic', completed, total });
        results.semantic = {
          capture: sample,
          findings: [],
          classification: 'suggestions-requiring-review',
        };
        await flush();
        signal.throwIfAborted();
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
        const attempts: Array<{
          chunk: number;
          thinking: 'off';
          elapsedMs: number;
          success: boolean;
          failure?: string;
          budget: { timeoutMs: number; referenceRuns: string[]; expectedMs: number | null };
        }> = [];
        let exportedEvents = 0;
        for (const [index, chunk] of chunks.entries()) {
          signal.throwIfAborted();
          const identity = {
            scenario: `instruction-semantic:${index + 1}`,
            thinking: 'off' as const,
            provenanceKey,
          };
          const allowance = budget?.(identity) ?? {
            timeoutMs: 120000,
            referenceRuns: [],
            expectedMs: null,
          };
          const attempt: (typeof attempts)[number] = {
            chunk: index + 1,
            thinking: 'off',
            elapsedMs: 0,
            success: false,
            budget: allowance,
          };
          attempts.push(attempt);
          const started = performance.now();
          const span = semanticTelemetry.begin('model.semantic-audit');
          try {
            const response = await fetch(`${endpoint}/api/chat`, {
              method: 'POST',
              signal: AbortSignal.any([
                signal,
                AbortSignal.timeout(Math.ceil(allowance.timeoutMs)),
              ]) as NonNullable<Parameters<typeof fetch>[1]>['signal'],
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
            if (!response.ok) {
              const payload: unknown = await response.json().catch(() => null);
              const detail =
                payload &&
                typeof payload === 'object' &&
                'error' in payload &&
                typeof payload.error === 'string'
                  ? payload.error.slice(0, 500)
                  : response.statusText;
              throw new Error(`Local semantic audit failed (${response.status}): ${detail}`);
            }
            const content = (await response.json()) as { message?: { content?: string } };
            const generated = JSON.parse(content.message?.content ?? '{}') as {
              findings?: unknown[];
            };
            if (!Array.isArray(generated.findings))
              throw new Error('Semantic audit returned invalid findings');
            findings.push(
              ...generated.findings.map((finding) => ({ suggestion: finding, chunk: index + 1 })),
            );
            attempt.success = true;
          } catch (error) {
            attempt.failure = error instanceof Error ? error.message : 'Semantic audit failed';
            throw error;
          } finally {
            span.end();
            attempt.elapsedMs = performance.now() - started;
            await learned?.(identity, { elapsedMs: attempt.elapsedMs, success: attempt.success });
            await semanticTelemetry.exportTrace();
            const events = (
              JSON.parse(await readFile(semanticTrace, 'utf8')) as { traceEvents: unknown[] }
            ).traceEvents;
            traceEvents.push(...events.slice(exportedEvents));
            exportedEvents = events.length;
            results.semantic = {
              capture: sample,
              attempts,
              findings,
              chunkCount: chunks.length,
              classification: 'suggestions-requiring-review',
              promptSha256: hash(effectivePrompt),
            };
            await flush();
          }
        }
        results.semantic = {
          capture: sample,
          attempts,
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
      };
      if (preset === 'audit') {
        const sample = await run('read-only', 'off', async (capture) => {
          results.semantic = {
            capture,
            findings: [],
            classification: 'suggestions-requiring-review',
          };
          await flush();
        });
        await auditPrompt(sample);
      }
      const tasks: Array<{
        arm: 'complete';
        scenario: Scenario;
        repetition: number;
        attempts: Array<Awaited<ReturnType<typeof run>>>;
        success: boolean;
        initialSuccess: boolean;
        elapsedMs: number;
        pending: boolean;
      }> = [];
      const refreshResults = () => {
        results.behavior = { tasks };
        results.bottlenecks = {
          source: 'behavior',
          totalElapsedMs: tasks.reduce((sum, task) => sum + task.elapsedMs, 0),
          cases: tasks.map(({ scenario, repetition, elapsedMs, pending }) => ({
            scenario,
            repetition,
            elapsedMs,
            pending,
          })),
          timings: attributeEvaluationTrace(traceEvents),
          note: 'Timings use the same executions as Behavior Evaluation. Trace categories can overlap; do not sum them as independent task time.',
        };
      };
      if (preset !== 'audit') {
        const scenarios = selectedScenario
          ? [selectedScenario]
          : preset === 'quick'
            ? ['targeted-fix' as const]
            : SCENARIOS;
        for (let repetition = 0; repetition < repetitions; repetition++) {
          for (const scenario of scenarios) {
            progress({
              event: 'case.started',
              suite: 'behavior',
              case: `${scenario} · ${repetition + 1}/${repetitions}`,
              completed,
              total,
            });
            const task = {
              arm: 'complete' as const,
              scenario,
              repetition,
              attempts: [] as Array<Awaited<ReturnType<typeof run>>>,
              success: false,
              initialSuccess: false,
              elapsedMs: 0,
              pending: true,
            };
            tasks.push(task);
            for (const thinking of ['off', 'low'] as const) {
              const attempt = await run(scenario, thinking, async (partial) => {
                task.attempts.push(partial);
                task.elapsedMs = task.attempts.reduce((sum, value) => sum + value.elapsedMs, 0);
                task.success = partial.success;
                if (thinking === 'off') task.initialSuccess = partial.success;
                refreshResults();
                await flush();
              });
              task.elapsedMs = task.attempts.reduce((sum, value) => sum + value.elapsedMs, 0);
              task.success = attempt.success;
              if (thinking === 'off') task.initialSuccess = attempt.success;
              task.pending =
                !attempt.success &&
                thinking === 'off' &&
                !signal.aborted &&
                attempt.failureCategory !== 'runtime';
              refreshResults();
              await flush();
              signal.throwIfAborted();
              if (attempt.failureCategory === 'runtime') {
                completed++;
                progress({
                  event: 'case.failed',
                  suite: 'behavior',
                  case: scenario,
                  completed,
                  total,
                  message: attempt.failure,
                });
                await flush();
                throw new Error(
                  `${scenario} execution failed: ${attempt.failure ?? 'Runtime prerequisite failed'}`,
                );
              }
              if (attempt.success) break;
            }
            task.pending = false;
            completed++;
            progress({
              event: task.success ? 'case.completed' : 'case.failed',
              suite: 'behavior',
              case: scenario,
              completed,
              total,
              message: task.attempts.at(-1)?.failure,
            });
            refreshResults();
            await flush();
            if (!task.success)
              throw new Error(
                `${scenario} failed after its low-reasoning fallback: ${task.attempts.at(-1)?.failure ?? 'Objective checks failed'}`,
              );
          }
        }
      }
      if (preset === 'full') {
        const sample = tasks[0]?.attempts.at(-1);
        if (!sample)
          throw new Error(
            'Behavior Evaluation did not capture an effective prompt for Instruction Audit',
          );
        await auditPrompt(sample);
      }
      await flush();
      return {
        result: { preset, setup, repetitions, model: EVAL_MODEL, results },
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
  team: Awaited<ReturnType<typeof loadTeam>>;
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

/** Union intervals within each category; separate categories can overlap. */
export function attributeEvaluationTrace(events: unknown[]) {
  const categories = ['model', 'tool', 'scheduler', 'wait', 'delegation'] as const;
  const intervals = new Map<string, Array<[number, number]>>(categories.map((name) => [name, []]));
  const starts = new Map<string, { category: string; start: number }>();
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as Record<string, unknown>;
    if (typeof event.name !== 'string' || typeof event.ts !== 'number') continue;
    const category = categories.find(
      (name) => event.name === name || (event.name as string).startsWith(`${name}.`),
    );
    if (!category) continue;
    const args =
      event.args && typeof event.args === 'object' ? (event.args as Record<string, unknown>) : {};
    const key = JSON.stringify([event.pid, args.correlationId, event.name, event.tid]);
    if (event.ph === 'B') starts.set(key, { category, start: event.ts });
    if (event.ph === 'E') {
      const start = starts.get(key);
      if (start && event.ts >= start.start) intervals.get(category)!.push([start.start, event.ts]);
      starts.delete(key);
    }
    if (event.ph === 'X' && typeof event.dur === 'number' && event.dur >= 0)
      intervals.get(category)!.push([event.ts, event.ts + event.dur]);
  }
  return Object.fromEntries(
    [...intervals].map(([category, values]) => {
      values.sort((a, b) => a[0] - b[0]);
      let elapsed = 0;
      let active: [number, number] | undefined;
      for (const interval of values) {
        if (!active) active = [...interval];
        else if (interval[0] > active[1]) {
          elapsed += active[1] - active[0];
          active = [...interval];
        } else active[1] = Math.max(active[1], interval[1]);
      }
      return [category, (elapsed + (active ? active[1] - active[0] : 0)) / 1000];
    }),
  );
}

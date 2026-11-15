import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { aggregate, runTask, type Scenario } from './runner.js';
import { selectedTeam } from '../integrations/team-loader.js';
import { Telemetry } from '../diagnostics/telemetry.js';
import type { EvalEngine } from './service.js';

const MODEL = 'ltcook-spark-x2.6-4b-q8_0-ctx8192:latest';
const BASE_MODEL = 'SparkLLM/Spark-X2.6-4B:q8_0';
const ENDPOINT = 'http://127.0.0.1:11434';
const SCENARIOS: Scenario[] = ['read-only', 'no-op', 'targeted-fix'];

export function createEvalEngine(input: { piHome: string; resources: string }): EvalEngine {
  return async ({ preset, signal, progress }) => {
    const health = await fetch(`${ENDPOINT}/api/tags`);
    if (!health.ok)
      throw new Error('Local Ollama is unavailable; start it with `ltcook services start`.');
    const catalog = (await health.json()) as { models?: Array<{ name?: string }> };
    if (!catalog.models?.some(({ name }) => name === MODEL))
      throw new Error(`Local Spark model ${MODEL} is not installed.`);
    const auth = mkdtempSync(path.join(tmpdir(), 'ltcook-evals-auth-'));
    const traceDir = mkdtempSync(path.join(tmpdir(), 'ltcook-evals-trace-'));
    const tracePath = path.join(traceDir, 'trace.json');
    const telemetry = new Telemetry('/dev/null', tracePath);
    try {
      const modelRuntime = await ModelRuntime.create({
        modelsPath: path.join(input.piHome, 'models.json'),
        authPath: path.join(auth, 'auth.json'),
        allowModelNetwork: false,
      });
      const configured = modelRuntime.getModel('ollama', MODEL);
      if (
        !configured ||
        !['localhost', '127.0.0.1', '[::1]'].includes(new URL(configured.baseUrl).hostname)
      )
        throw new Error(
          'The configured local Spark model is unavailable; run `ltcook app doctor`.',
        );
      const team = await selectedTeam('default-minimal');
      const results: Record<string, unknown> = {};
      let completed = 0;
      const total =
        preset === 'quick'
          ? 2
          : preset === 'audit'
            ? 2
            : preset === 'behavior'
              ? 6
              : preset === 'bottlenecks'
                ? 18
                : 26;
      const runBehavior = async (
        suite: string,
        scenario: Scenario,
        repetitions: number,
        arms: ('minimal' | 'complete')[],
        retryFailed: boolean,
      ) => {
        const tasks = [];
        for (let repetition = 0; repetition < repetitions; repetition++) {
          const order = repetition % 2 ? ([...arms].reverse() as typeof arms) : arms;
          for (const arm of order) {
            signal.throwIfAborted();
            progress({
              event: 'case.started',
              suite,
              case: `${scenario} · ${arm} · ${repetition + 1}/${repetitions}`,
              completed,
              total,
            });
            const task = await runTask({
              arm,
              scenario,
              repetition,
              team,
              modelRuntime,
              provider: 'ollama',
              model: MODEL,
              timeoutMs: 120_000,
              initialThinking: 'off',
              retryFailed,
              telemetry,
              signal,
            });
            tasks.push(task);
            completed++;
            progress({
              event: task.success ? 'case.completed' : 'case.failed',
              suite,
              case: `${scenario} · ${arm}`,
              completed,
              total,
              message: task.attempts.at(-1)?.failure,
            });
          }
        }
        return tasks;
      };
      if (['quick', 'audit', 'full'].includes(preset)) {
        progress({ event: 'suite.started', suite: 'instruction-static', completed, total });
        results.static = staticAudit(input.resources);
        completed++;
        progress({
          event: 'case.completed',
          suite: 'instruction-static',
          case: 'resource inventory',
          completed,
          total,
        });
      }
      if (preset === 'audit' || preset === 'full') {
        progress({ event: 'suite.started', suite: 'instruction-semantic', completed, total });
        results.semantic = await semanticAudit({
          modelRuntime,
          team,
          signal,
          telemetry,
          resources: input.resources,
        });
        completed++;
        progress({
          event: 'case.completed',
          suite: 'instruction-semantic',
          case: 'isolated Pi prompt',
          completed,
          total,
        });
      }
      if (preset === 'quick') {
        results.behavior = await runBehavior('behavior', 'targeted-fix', 1, ['complete'], true);
      } else if (preset === 'behavior' || preset === 'full') {
        const tasks = [];
        for (const scenario of SCENARIOS)
          tasks.push(
            ...(await runBehavior('behavior', scenario, 1, ['minimal', 'complete'], true)),
          );
        results.behavior = { tasks, aggregates: aggregate(tasks) };
      }
      if (preset === 'bottlenecks' || preset === 'full') {
        const tasks = [];
        for (const scenario of SCENARIOS)
          tasks.push(
            ...(await runBehavior('bottlenecks', scenario, 3, ['minimal', 'complete'], false)),
          );
        results.bottlenecks = { tasks, aggregates: aggregate(tasks) };
      }
      await telemetry.exportTrace();
      return {
        result: { preset, model: MODEL, results },
        trace: JSON.parse(readFileSync(tracePath, 'utf8')),
      };
    } finally {
      await import('node:fs/promises').then(({ rm }) =>
        Promise.all([
          rm(auth, { recursive: true, force: true }),
          rm(traceDir, { recursive: true, force: true }),
        ]),
      );
    }
  };
}

function staticAudit(root: string) {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) return [];
      if (entry.isDirectory()) return walk(file);
      return entry.isFile() && entry.name.endsWith('.md') ? [file] : [];
    });
  const files = walk(root).sort();
  const seen = new Map<string, string>();
  const findings = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const source = path.relative(root, file).split(path.sep).join('/');
    const digest = createHash('sha256').update(content).digest('hex');
    if (seen.has(digest)) findings.push({ kind: 'duplicate', sources: [seen.get(digest), source] });
    else seen.set(digest, source);
    const words = content.split(/\s+/).length;
    if (words > 3000) findings.push({ kind: 'large_resource', source, words });
  }
  return {
    findings,
    resourceCount: files.length,
    uniqueContentCount: seen.size,
    coverageComplete: false,
  };
}

async function semanticAudit(input: {
  modelRuntime: Awaited<ReturnType<typeof ModelRuntime.create>>;
  team: Awaited<ReturnType<typeof selectedTeam>>;
  signal: AbortSignal;
  telemetry: Telemetry;
  resources: string;
}) {
  const task = await runTask({
    arm: 'complete',
    scenario: 'targeted-fix',
    repetition: 0,
    team: input.team,
    modelRuntime: input.modelRuntime,
    provider: 'ollama',
    model: MODEL,
    timeoutMs: 120_000,
    initialThinking: 'off',
    retryFailed: false,
    telemetry: input.telemetry,
    signal: input.signal,
    capturePrompt: true,
  });
  const attempt = task.attempts[0];
  const prompt = attempt?.instructions.effectivePrompt;
  if (!prompt) throw new Error('Pi did not expose its effective prompt for audit.');
  const findings: unknown[] = [];
  const loaded = (attempt.instructions.resources ?? []).filter((resource) => resource.loaded);
  const paths = readdirSync(input.resources, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name.endsWith('.md'),
  );
  for (const resource of loaded) {
    input.signal.throwIfAborted();
    const file = paths.find((entry) => entry.name === path.basename(resource.path));
    if (!file) continue;
    const source = path.join(input.resources, file.name);
    const sourceText = readFileSync(source, 'utf8');
    input.signal.throwIfAborted();
    const response = await fetch(`${ENDPOINT}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: BASE_MODEL,
        stream: false,
        think: false,
        options: { num_ctx: 8192 },
        format: 'json',
        messages: [
          {
            role: 'user',
            content: `Review the isolated Pi prompt and source for instruction conflicts, ambiguity, unnecessary work, and broad triggers. Return JSON with findings containing severity, issue, evidence, and suggestion. Treat each finding as a potential suggestion.\n\nPROMPT:\n${prompt}\n\nSOURCE ${file.name}:\n${sourceText}`,
          },
        ],
      }),
    });
    input.signal.throwIfAborted();
    if (!response.ok)
      throw new Error(`Semantic audit failed for ${file.name} (${response.status}).`);
    const generated = (await response.json()) as { message?: { content?: string } };
    const data = JSON.parse(generated.message?.content ?? '{}') as { findings?: unknown[] };
    for (const finding of data.findings ?? [])
      findings.push({
        source: file.name,
        sourceHash: resource.sha256,
        confidence: 'potential',
        ...(finding as object),
      });
  }
  return {
    findings,
    sourceCount: loaded.length,
    coverageComplete: false,
    coverageNote: 'Isolated Pi prompt only; Paseo/runtime-added instructions are not included.',
  };
}

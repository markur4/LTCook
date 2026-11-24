import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { sanitizeEvaluationText } from '../runtime/src/evals/diagnostics.js';
import { evaluateMemoryFixture } from '../runtime/src/evals/session-memory.js';
import {
  EVAL_MODEL,
  LUNA_EVALUATION,
  hash,
  resolveEvaluationContext,
} from '../runtime/src/evals/setup.js';
import {
  createLocalPiEvaluationSession,
  prepareLunaPiEvaluation,
} from '../runtime/src/evals/summarization-decision.js';
import {
  inspectEvaluationModel,
  listEvaluationModels,
  modelTag,
} from '../runtime/src/evals/summarization-grader.js';
import {
  estimateMemoryTokens,
  memoryGeneration,
  type MemoryMessage,
} from '../runtime/src/evals/session-memory-extractive.js';
import { SessionMemory, type MemorySource } from '../runtime/src/session-memory/service.js';
import {
  createSessionMemoryTool,
  sessionMemoryDescription,
  sessionMemoryInput,
} from '../runtime/src/tools/session-memory.js';
import {
  compareContextMemory,
  contextModel,
  type ContextStrategy,
} from './session-memory-context.js';
import {
  editBase,
  editTranscript,
  sessionMemoryEditCases,
} from './session-memory-edit-fixtures.js';

const root = path.resolve(import.meta.dir, '..');
const { summarization } = resolveEvaluationContext({
  python: path.join(root, '.venv/bin/python'),
  setup: 'current',
  teamSelection: process.env.LTCOOK_TEAM ?? 'default-minimal',
});
if (!summarization) throw new Error('AppRC summarizer settings are unavailable.');
const { endpoint } = summarization;
const args = process.argv.slice(2);
const contextAware = args.includes('--context-aware');
const [
  extractorName = contextAware ? contextModel : 'LiquidAI/lfm2.5-1.2b-instruct:q8_0',
  workerName = contextAware ? LUNA_EVALUATION.model : EVAL_MODEL,
] = args.filter((value) => !value.startsWith('--'));
if (contextAware && modelTag(extractorName) !== modelTag(contextModel))
  throw new Error('The context-aware comparison uses the configured Session Memory summarizer.');
const fixtureId = args.find((value) => value.startsWith('--fixture='))?.slice('--fixture='.length);
const fixtures = fixtureId
  ? sessionMemoryEditCases.filter(({ id }) => id === fixtureId)
  : sessionMemoryEditCases;
if (!fixtures.length) throw new Error('Unknown repository edit fixture.');
const useLuna = workerName === LUNA_EVALUATION.model;
const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-memory-edit-'));
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
const { signal } = controller;
const run = promisify(execFile);
type EditCase = (typeof sessionMemoryEditCases)[number];

function transcriptSource(messages: readonly MemoryMessage[]): MemorySource {
  return {
    async read(_id, cursor, direction = 'after') {
      const page =
        direction === 'tail'
          ? messages.slice(-16)
          : direction === 'before'
            ? messages.filter(({ seq }) => seq < cursor!.seq).slice(-16)
            : messages.filter(({ seq }) => seq > (cursor?.seq ?? 0)).slice(0, 16);
      return {
        epoch: 'fixed-history',
        earliest: 1,
        start: page[0]?.seq,
        latest: messages.at(-1)!.seq,
        through: page.at(-1)?.seq ?? 0,
        reset: false,
        messages: page,
      };
    },
  };
}

async function editWithPi(input: {
  fixture: EditCase;
  mode: 'conventional' | 'search' | 'hybrid' | ContextStrategy;
  source: MemorySource;
  handoff: string;
  model: string;
  hostedSession?: Awaited<ReturnType<typeof prepareLunaPiEvaluation>>;
}) {
  const { fixture, mode, source, handoff, model, hostedSession } = input;
  const arm = path.join(directory, fixture.id, mode);
  const workspace = path.join(arm, 'workspace');
  const files = [fixture.file, fixture.sibling];
  const original = await Promise.all(
    files.map(async (file) => {
      const { stdout } = await run('git', ['show', `${editBase}:${file}`], { cwd: root, signal });
      const destination = path.join(workspace, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, stdout);
      return stdout;
    }),
  );
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source,
    summarize: async (type) => ({ type, text: '', complete: false, elapsedMs: 0 }),
  });
  const tool = createSessionMemoryTool(memory);
  const searches: Array<{
    query?: string;
    sourceSeq?: number;
    results: number;
    elapsedMs: number;
  }> = [];
  const search = defineTool({
    name: 'session_memory',
    label: 'Session Memory',
    description: sessionMemoryDescription,
    parameters: sessionMemoryInput,
    async execute(_id, request, toolSignal) {
      const started = performance.now();
      const result = await tool.execute(
        { ...request, agentId: 'leader' },
        {
          agentId: 'leader',
          workspaceRoot: workspace,
          workspaceFileAccess: false,
          signal: toolSignal ? AbortSignal.any([signal, toolSignal]) : signal,
        },
      );
      searches.push({
        query: request.query,
        sourceSeq: request.source?.seq,
        results: result.matches.reduce((n, { entries }) => n + entries.length, 0),
        elapsedMs: Math.round(performance.now() - started),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
  const started = performance.now();
  try {
    const options = {
      endpoint,
      model,
      cwd: workspace,
      directory: path.join(arm, 'pi'),
      instructions:
        'You are a worker implementing an authorized edit. Work in the supplied checkout. Edit only the assigned file. Use the latest confirmed user decision when there is relevant history. Make the smallest edit you can and keep the final report brief.',
      tools: ['read', 'edit', ...(mode === 'conventional' ? [] : [search.name])],
      customTools: mode === 'conventional' ? [] : [search],
    };
    const { session } = await (hostedSession ?? createLocalPiEvaluationSession)(options);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const abort = () => void session.abort();
    bounded.addEventListener('abort', abort, { once: true });
    const calls: Array<{ tool: string; failed: boolean }> = [];
    const unsubscribe = session.agent.subscribe((event) => {
      if (event.type === 'tool_execution_end')
        calls.push({ tool: event.toolName, failed: event.isError });
    });
    try {
      bounded.throwIfAborted();
      await session.prompt(
        [fixture.assignment, fixture.manualHandoff, ...(handoff ? [handoff] : [])].join('\n\n'),
      );
      const answers = session.messages.filter((message) => message.role === 'assistant');
      const lastAnswer = answers.at(-1);
      const stopReason = lastAnswer?.stopReason;
      const error = answers.some(
        ({ responseModel }) => responseModel && modelTag(responseModel) !== modelTag(model),
      )
        ? 'The Pi provider returned a different worker model.'
        : bounded.aborted || !stopReason || ['error', 'aborted', 'length'].includes(stopReason)
          ? sanitizeEvaluationText(lastAnswer?.errorMessage || 'Pi did not finish the edit turn.')
          : undefined;
      const usage = answers.reduce(
        (total, { usage }) => ({
          inputTokens: total.inputTokens + usage.input + usage.cacheRead + usage.cacheWrite,
          outputTokens: total.outputTokens + usage.output,
        }),
        { inputTokens: 0, outputTokens: 0 },
      );
      const targetChanged =
        (await readFile(path.join(workspace, fixture.file), 'utf8')) !== original[0];
      const siblingUnchanged =
        (await readFile(path.join(workspace, fixture.sibling), 'utf8')) === original[1];
      const workspaceFiles = (await readdir(workspace, { recursive: true, withFileTypes: true }))
        .filter((entry) => !entry.isDirectory())
        .map((entry) => path.relative(workspace, path.join(entry.parentPath, entry.name)));
      const scoped = siblingUnchanged && workspaceFiles.every((file) => files.includes(file));
      const checks: Record<string, boolean> = await fixture
        .grade(workspace)
        .catch(() => ({ executable: false }));
      return {
        mode,
        provider: session.model?.provider,
        requestedModel: session.model?.id,
        responseModels: [
          ...new Set(
            answers.flatMap(({ responseModel }) => (responseModel ? [responseModel] : [])),
          ),
        ],
        ...usage,
        elapsedMs: Math.round(performance.now() - started),
        searches,
        calls,
        targetChanged,
        scoped,
        checks,
        error,
        passed: !error && targetChanged && scoped && Object.values(checks).every(Boolean),
      };
    } finally {
      bounded.removeEventListener('abort', abort);
      unsubscribe();
      session.dispose();
    }
  } finally {
    await memory.close();
  }
}

try {
  const catalog = await listEvaluationModels(endpoint, signal);
  const resolve = async (name: string) => {
    const model = catalog.find((entry) => modelTag(entry.name) === modelTag(name));
    if (!model) throw new Error(`Missing Ollama model: ${name}`);
    return inspectEvaluationModel(endpoint, model, signal);
  };
  const [extractor, worker, hostedSession] = await Promise.all([
    resolve(extractorName),
    useLuna ? { name: workerName, reasoning: LUNA_EVALUATION.reasoning } : resolve(workerName),
    useLuna ? prepareLunaPiEvaluation(directory, signal) : undefined,
  ]);
  const started = performance.now();
  const scenarios = [];
  for (const fixture of fixtures) {
    const transcript = editTranscript(fixture);
    const messages = transcript.turns.flat();
    if (contextAware) {
      const comparison = await compareContextMemory(transcript, {
        settings: summarization,
        digest: extractor.digest,
        weightsDigest: extractor.weightsDigest,
        signal,
        progress: (event) => console.error(event),
      });
      const arms = [];
      for (const { strategy: mode, handoff, ...summary } of comparison.arms) {
        console.error(`Running native Pi ${mode} edit for ${fixture.id}`);
        const workerResult = await editWithPi({
          fixture,
          mode,
          handoff: mode === 'original-search' ? '' : handoff,
          source: transcriptSource(messages),
          model: worker.name,
          hostedSession,
        });
        arms.push({ ...summary, strategy: mode, worker: workerResult });
        console.error(
          `${fixture.id} ${mode}: ${workerResult.passed ? 'passed' : 'failed'} in ${workerResult.elapsedMs} ms`,
        );
      }
      const conventional = await editWithPi({
        fixture,
        mode: 'conventional',
        handoff: '',
        source: transcriptSource(messages),
        model: worker.name,
        hostedSession,
      });
      scenarios.push({
        fixture: fixture.id,
        sourceEstimatedTokens: comparison.sourceEstimatedTokens,
        transcriptHash: hash(JSON.stringify(messages)),
        arms,
        conventional,
        originalControlPassed:
          arms.find(({ strategy }) => strategy === 'original-search')?.worker.passed ?? false,
      });
      continue;
    }
    console.error(`Extracting Session Memory for ${fixture.id}`);
    const extraction = await evaluateMemoryFixture({
      fixture: transcript,
      settings: {
        ...summarization,
        model: extractor.name,
        cpuOnly: true,
        keepAlive: 300,
        generation: JSON.stringify(memoryGeneration),
      },
      digest: extractor.digest,
      weightsDigest: extractor.weightsDigest,
      threshold: 3000,
      downstreamModel: worker.name,
      directory,
      signal,
      extractOnly: true,
      finalize: false,
    });
    const arms = [];
    for (const mode of ['conventional', 'search', 'hybrid'] as const) {
      console.error(`Running native Pi ${mode} edit for ${fixture.id}`);
      const result = await editWithPi({
        fixture,
        mode,
        source: transcriptSource(messages),
        handoff: mode === 'hybrid' ? extraction.handoff : '',
        model: worker.name,
        hostedSession,
      });
      arms.push(result);
      console.error(
        `${fixture.id} ${mode}: ${result.passed ? 'passed' : 'failed'} in ${result.elapsedMs} ms`,
      );
    }
    scenarios.push({
      fixture: fixture.id,
      transcriptHash: hash(JSON.stringify(messages)),
      messages: messages.length,
      estimatedTokens: messages.reduce((total, { text }) => total + estimateMemoryTokens(text), 0),
      extractionAttempts: extraction.attempts,
      handoffEstimatedTokens: estimateMemoryTokens(extraction.handoff),
      arms,
    });
  }
  const after = await listEvaluationModels(endpoint, signal);
  const identityUnchanged = [extractor, ...('digest' in worker ? [worker] : [])].every((model) =>
    after.some(({ name, digest }) => name === model.name && digest === model.digest),
  );
  console.log(
    JSON.stringify(
      {
        editBase,
        extractor,
        worker,
        identityUnchanged,
        elapsedMs: Math.round(performance.now() - started),
        scenarios,
      },
      null,
      2,
    ),
  );
  if (!identityUnchanged) process.exitCode = 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
  await rm(directory, { recursive: true, force: true });
}

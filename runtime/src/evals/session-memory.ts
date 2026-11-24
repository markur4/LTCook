import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { cpus, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  ollamaEndpoint,
  type OllamaChatMetrics,
  type OllamaSettings,
  type OllamaUsage,
} from '../integrations/ollama.js';
import {
  estimateMemoryTokens,
  extractMemory,
  memoryGeneration,
  MemoryOutputError,
  mergeMemoryEntries,
  preservePromptMessages,
  renderMemoryHandoff,
  selectMemoryContext,
  type MemoryEntry,
  type MemoryMessage,
} from '../session-memory/extraction.js';
import { EVAL_MODEL, hash } from './setup.js';
import { evaluateMemoryHandoff } from './session-memory-handoff.js';
import {
  memoryCadenceFixture,
  memoryFixtures,
  type MemoryFixture,
} from './session-memory-fixtures.js';
import { inspectEvaluationModel, listEvaluationModels, modelTag } from './summarization-grader.js';

const models = [
  'LiquidAI/lfm2.5-1.2b-instruct:q8_0',
  'lfm3:1.7b-q8_0',
  'lfm3:1.7b-qad-q4_0',
] as const;
const qualification = {
  criticalFacts:
    'Every scheduled update must retain expected critical facts with correct source attribution and no fixture contradiction.',
  outputs: 'Every attempted inference must provide valid output and show CPU residency.',
  userMessages:
    'Every processed user message must be preserved verbatim. The handoff must include each latest correction and an earlier committed user message.',
  downstream: 'Both the original-source control and hybrid Pi handoff must pass every fixture.',
  diagnostics: 'Categorization and noncritical omissions are reported separately from the gate.',
};
const runningModelSchema = z.object({
  models: z.array(
    z.object({
      digest: z.string(),
      size: z.number().nonnegative(),
      size_vram: z.number().nonnegative(),
    }),
  ),
});

async function residency(endpoint: URL, digest: string, signal: AbortSignal) {
  const response = await fetch(new URL('/api/ps', endpoint), {
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) as NonNullable<
      Parameters<typeof fetch>[1]
    >['signal'],
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Ollama model residency request failed.');
  }
  const { models } = runningModelSchema.parse(await response.json());
  const loaded = models.find((model) => model.digest === digest);
  return loaded ? { bytes: loaded.size, gpuBytes: loaded.size_vram } : null;
}

async function peakRunnerRss(weightsDigest?: string) {
  if (!weightsDigest || platform() !== 'linux') return undefined;
  const blob = `sha256-${weightsDigest.replace(/^sha256:/, '')}`;
  const processes = await readdir('/proc').catch(() => []);
  const samples = await Promise.all(
    processes
      .filter((pid) => /^\d+$/.test(pid))
      .map(async (pid) => {
        const directory = `/proc/${pid}`;
        try {
          const args = (await readFile(`${directory}/cmdline`, 'utf8')).split('\0');
          if (path.basename(args[args.indexOf('--model') + 1] ?? '') !== blob) return 0;
          const status = await readFile(`${directory}/status`, 'utf8');
          return Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
        } catch {
          return 0;
        }
      }),
  );
  return Math.max(0, ...samples) || undefined;
}

function gradeMemory(
  entries: readonly MemoryEntry[],
  seen: readonly MemoryMessage[],
  fixture: MemoryFixture,
) {
  const actualSources = new Map(seen.map((message) => [message.seq, message]));
  const eligible = fixture.facts.filter(({ source }) => actualSources.has(source));
  const derived = entries.filter(({ author }) => author === 'agent' || author === 'tool');
  const evaluateFact = (fact: MemoryFixture['facts'][number]) => {
    const matching = derived.filter(({ text }) => fact.expected.test(text));
    const source = actualSources.get(fact.source);
    return {
      label: fact.label,
      source: fact.source,
      critical: fact.critical ?? false,
      missing: !matching.length,
      incorrect:
        fact.contradicts !== undefined && derived.some(({ text }) => fact.contradicts?.test(text)),
      wrongAttribution: matching.some(
        ({ seq, author }) => seq !== fact.source || author !== source?.author,
      ),
      wrongCategory: matching.some(({ kind }) => kind !== fact.kind),
    };
  };
  const facts = eligible.map(evaluateFact);
  const absentUserSources = seen
    .filter(
      ({ author, seq, text }) =>
        author === 'user' &&
        !entries.some(
          (entry) =>
            entry.seq === seq &&
            entry.author === author &&
            entry.kind === 'user' &&
            entry.text === text,
        ),
    )
    .map(({ seq }) => seq);
  return {
    facts,
    missing: facts.filter(({ missing }) => missing).map(({ label }) => label),
    incorrect: facts.filter(({ incorrect }) => incorrect).map(({ label }) => label),
    wrongAttribution: facts
      .filter(({ wrongAttribution }) => wrongAttribution)
      .map(({ label }) => label),
    wrongCategory: facts.filter(({ wrongCategory }) => wrongCategory).map(({ label }) => label),
    absentUserSources,
    passed:
      absentUserSources.length === 0 &&
      facts.every(
        (fact) => !fact.incorrect && (!fact.critical || (!fact.missing && !fact.wrongAttribution)),
      ),
  };
}

export async function evaluateMemoryFixture(input: {
  fixture: MemoryFixture;
  settings: OllamaSettings;
  digest: string;
  threshold: number;
  downstreamModel: string;
  directory: string;
  signal: AbortSignal;
  extractOnly?: boolean;
  weightsDigest?: string;
  taskAware?: boolean;
  finalize?: boolean;
}) {
  const { fixture, settings, digest, threshold, downstreamModel, directory, signal } = input;
  const endpoint = ollamaEndpoint(settings.endpoint);
  const seen: MemoryMessage[] = [];
  let entries: MemoryEntry[] = [];
  let processed = 0;
  const attempts = [];
  const estimatedTokens = (messages: readonly MemoryMessage[]) =>
    messages.reduce(
      (total, message) =>
        total + (message.author === 'runtime' ? 0 : estimateMemoryTokens(message.text)),
      0,
    );

  async function update() {
    const pending = seen.slice(processed);
    entries = mergeMemoryEntries(entries, preservePromptMessages(pending));
    let usage: OllamaUsage | undefined;
    let metrics: OllamaChatMetrics | undefined;
    let error: string | undefined;
    let output: 'valid' | 'invalid' | 'unavailable' | 'skipped' = 'skipped';
    const attempted = pending.some(({ author }) => author === 'agent' || author === 'tool');
    const before = attempted ? await residency(endpoint, digest, signal) : null;
    const start = performance.now();
    try {
      if (attempted) {
        const additions = await extractMemory(settings, pending, signal, {
          focus: input.taskAware ? fixture.focus : undefined,
          onUsage(value) {
            usage = value;
          },
          onMetrics(value) {
            metrics = value;
          },
        });
        entries = mergeMemoryEntries(entries, additions);
        output = 'valid';
      }
      processed = seen.length;
    } catch (failure) {
      signal.throwIfAborted();
      output = failure instanceof MemoryOutputError ? 'invalid' : 'unavailable';
      error = failure instanceof Error ? failure.message : 'Unknown extraction failure.';
    }
    const elapsedMs = performance.now() - start;
    const after = attempted ? await residency(endpoint, digest, signal) : null;
    return {
      firstSeq: pending.at(0)?.seq,
      lastSeq: pending.at(-1)?.seq,
      checkpointSeq: seen[processed - 1]?.seq ?? null,
      estimatedInputTokens: estimatedTokens(pending),
      residencyBefore: !attempted ? undefined : before ? 'loaded' : 'unloaded',
      elapsedMs: Math.round(elapsedMs),
      usage,
      metrics,
      outputTokensPerSecond:
        usage?.outputTokens === undefined ? undefined : (usage.outputTokens * 1000) / elapsedMs,
      loadedBytes: after?.bytes,
      peakRunnerRssBytes: attempted ? await peakRunnerRss(input.weightsDigest) : undefined,
      gpuBytes: after?.gpuBytes,
      cpuVerified: after?.gpuBytes === 0,
      output,
      error,
      grade: gradeMemory(entries, seen, fixture),
    };
  }

  for (const turn of fixture.turns.slice(0, -1)) {
    seen.push(...turn);
    const last = seen.at(-1);
    if (
      (last && fixture.flushAfter.includes(last.seq)) ||
      estimatedTokens(seen.slice(processed)) >= threshold
    )
      attempts.push(await update());
  }
  seen.push(...fixture.turns.at(-1)!);
  const pending = seen.slice(processed);
  const context = selectMemoryContext(
    entries,
    pending.filter(({ author }) => author !== 'runtime'),
    fixture.focus,
    pending.length > 0,
  );
  const handoff = renderMemoryHandoff(context);
  const selectedUserSources = [
    ...context.entries.filter(({ author }) => author === 'user'),
    ...context.recent.filter(({ author }) => author === 'user'),
  ].map(({ seq }) => seq);
  const freshness = {
    pendingMessages: pending.length,
    pendingEstimatedTokens: estimatedTokens(pending),
    selectedUserSources,
    correctionIncluded: fixture.correctionSources.every((seq) => selectedUserSources.includes(seq)),
    earlierUserSources: selectedUserSources.filter((seq) => seq <= (seen[processed - 1]?.seq ?? 0)),
    potentiallyIncomplete: context.incomplete,
  };
  if (input.finalize !== false) attempts.push(await update());
  const downstream = input.extractOnly
    ? undefined
    : await evaluateMemoryHandoff({
        context: handoff,
        endpoint: settings.endpoint,
        model: downstreamModel,
        directory,
        signal,
        task: fixture.task,
      });
  return {
    fixture: fixture.id,
    attempts,
    freshness,
    downstream,
    handoff,
    finalMemory: entries,
    passed:
      attempts.every(
        ({ grade, cpuVerified, output }) =>
          grade.passed && (output === 'skipped' || (output === 'valid' && cpuVerified)),
      ) &&
      freshness.correctionIncluded &&
      freshness.earlierUserSources.length > 0 &&
      (downstream?.passed ?? true),
  };
}

export async function runSessionMemoryEvaluation(
  settings: OllamaSettings,
  signal: AbortSignal,
  downstreamModel = EVAL_MODEL,
  onProgress?: (event: string) => void,
  selection?: {
    model?: string;
    threshold?: number;
    cadence?: boolean;
    includeCadence?: boolean;
    extractOnly?: boolean;
    taskAware?: boolean;
    recommendedSampling?: boolean;
  },
) {
  const selectedModels = models.filter((model) => {
    if (selection?.model === 'remaining') return model !== models[0];
    return !selection?.model || modelTag(model) === modelTag(selection.model);
  });
  const threshold = selection?.threshold ?? 3000;
  const fixtures = selection?.cadence
    ? [memoryCadenceFixture()]
    : selection?.includeCadence
      ? [...memoryFixtures, memoryCadenceFixture()]
      : memoryFixtures;
  if (!selectedModels.length || !Number.isInteger(threshold) || threshold < 1 || threshold > 6500)
    throw new Error(
      'Choose a Session Memory candidate or remaining, and optional cadence from 1 to 6500.',
    );
  const started = performance.now();
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-session-memory-eval-'));
  try {
    const catalog = await listEvaluationModels(settings.endpoint, signal);
    const inspect = (name: string) => {
      const model = catalog.find((entry) => modelTag(entry.name) === modelTag(name));
      return model ? inspectEvaluationModel(settings.endpoint, model, signal) : undefined;
    };
    const downstreamIdentity = selection?.extractOnly ? undefined : await inspect(downstreamModel);
    if (!downstreamIdentity && !selection?.extractOnly)
      throw new Error('The downstream Pi evaluation model is unavailable.');

    const baseline = [];
    for (const fixture of downstreamIdentity ? fixtures : []) {
      const sources = fixture.turns
        .flat()
        .filter(({ seq }) => fixture.originalSources.includes(seq));
      onProgress?.(`Running the Pi original-source control for ${fixture.id}`);
      const result = await evaluateMemoryHandoff({
        context: JSON.stringify(sources),
        endpoint: settings.endpoint,
        model: downstreamIdentity!.name,
        directory: path.join(directory, 'original', fixture.id),
        signal,
        task: fixture.task,
      });
      baseline.push({ fixture: fixture.id, messages: sources.length, ...result });
    }
    const candidates = [];
    for (const requestedModel of selectedModels) {
      const identity = await inspect(requestedModel);
      if (!identity) {
        candidates.push({ requestedModel, error: 'Ollama model is unavailable.', passed: false });
        continue;
      }
      const generation = selection?.recommendedSampling
        ? {
            ...memoryGeneration,
            options: {
              ...memoryGeneration.options,
              temperature: 0.1,
              top_k: 50,
              repeat_penalty: requestedModel === models[0] ? 1.05 : 1.1,
            },
          }
        : memoryGeneration;
      const scenarios = [];
      for (const fixture of fixtures) {
        onProgress?.(`Evaluating ${requestedModel} on ${fixture.id}`);
        try {
          const result = await evaluateMemoryFixture({
            fixture,
            settings: {
              ...settings,
              model: identity.name,
              keepAlive: 300,
              cpuOnly: true,
              generation: JSON.stringify(generation),
            },
            digest: identity.digest,
            weightsDigest: identity.weightsDigest,
            threshold,
            downstreamModel: downstreamIdentity?.name ?? downstreamModel,
            directory: path.join(directory, String(candidates.length), fixture.id),
            signal,
            extractOnly: selection?.extractOnly,
            taskAware: selection?.taskAware,
          });
          const original = baseline.find(({ fixture: id }) => id === fixture.id);
          const originalInput = original?.inputTokens;
          const hybridInput = result.downstream?.inputTokens;
          const contextReduction =
            originalInput && hybridInput !== undefined
              ? {
                  inputTokensSaved: originalInput - hybridInput,
                  fractionSaved: (originalInput - hybridInput) / originalInput,
                }
              : undefined;
          scenarios.push({
            ...result,
            contextReduction,
            passed: result.passed && (selection?.extractOnly || original?.passed === true),
          });
        } catch (error) {
          signal.throwIfAborted();
          scenarios.push({
            fixture: fixture.id,
            passed: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      candidates.push({
        identity,
        generation,
        scenarios,
        passed: scenarios.every(({ passed }) => passed),
      });
    }
    const after = await listEvaluationModels(settings.endpoint, signal);
    const identities = [
      ...(downstreamIdentity ? [downstreamIdentity] : []),
      ...candidates.flatMap(({ identity }) => (identity ? [identity] : [])),
    ];
    const identityUnchanged = identities.every((model) =>
      after.some(({ name, digest }) => name === model.name && digest === model.digest),
    );
    return {
      threshold,
      corpusHash: hash(
        JSON.stringify(fixtures, (_key, value: unknown) =>
          value instanceof RegExp ? value.toString() : value,
        ),
      ),
      elapsedMs: Math.round(performance.now() - started),
      platform: platform(),
      cpu: { model: cpus()[0]?.model, logicalCount: cpus().length },
      ...(selection?.recommendedSampling
        ? { sampling: 'liquid-recommended' }
        : { generation: memoryGeneration }),
      taskAware: selection?.taskAware ?? false,
      qualification,
      identityUnchanged,
      downstreamIdentity,
      baseline,
      candidates,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

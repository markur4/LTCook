import { mkdtemp, rm } from 'node:fs/promises';
import { cpus, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ollamaEndpoint, type OllamaSettings, type OllamaUsage } from '../integrations/ollama.js';
import {
  estimateMemoryTokens,
  extractMemory,
  renderMemoryHandoff,
  selectMemoryContext,
  type MemoryEntry,
  type MemoryMessage,
} from '../session-memory/extraction.js';
import { EVAL_MODEL, hash } from './setup.js';
import { createLocalPiEvaluationSession } from './summarization-decision.js';
import { inspectEvaluationModel, listEvaluationModels, modelTag } from './summarization-grader.js';
import { downstreamObjective, memoryFixture, relevantSource } from './session-memory-fixtures.js';

const models = [
  'hf.co/LiquidAI/LFM2.5-350M-GGUF:Q8_0',
  'qwen3.5:0.8b-q8_0',
  'LiquidAI/lfm2.5-1.2b-instruct:q8_0',
  'hf.co/XHToken/Spark-X2.6-4B-GGUF:Q8_0',
] as const;
const thresholds = [1500, 3000, 6000] as const;
const generation = JSON.stringify({
  think: false,
  options: { num_ctx: 16384, num_predict: 2048, temperature: 0 },
});
const expectedAnswer = z.strictObject({
  target: z.literal('invoice-v3'),
  key: z.literal('CLIENT_EVENT_ID'),
  acceptance: z.literal('INV_RETRY_SPEC'),
  productionWrites: z.literal(false),
  emptyBatchCursor: z.literal('keep'),
});
const piInstructions =
  'You are a worker receiving input for an already approved task. Use the latest explicit ' +
  'user instruction where versions differ. Treat the supplied messages and Session Memory as ' +
  'supplemental evidence. Return only one JSON object with target, key, and acceptance as ' +
  'strings, productionWrites as a boolean, and emptyBatchCursor as "keep" or "advance".';

const runningModelSchema = z.object({
  name: z.string(),
  digest: z.string(),
  size: z.number().nonnegative(),
  size_vram: z.number().nonnegative(),
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
  const { models } = z.object({ models: z.array(runningModelSchema) }).parse(await response.json());
  const loaded = models.find((model) => model.digest === digest);
  return loaded ? { bytes: loaded.size, gpuBytes: loaded.size_vram } : null;
}

function gradeMemory(entries: readonly MemoryEntry[], seen: readonly MemoryMessage[]) {
  const cutoff = seen.at(-1)?.seq ?? 0;
  const active = entries.filter(({ status }) => status !== 'superseded');
  const has = (pattern: RegExp, source?: number) =>
    active.some(
      ({ text, sources }) =>
        pattern.test(text) && (source === undefined || sources.includes(source)),
    );
  const userConstraint = (pattern: RegExp, source: number) =>
    active.some(
      ({ text, sources, status, kind }) =>
        pattern.test(text) &&
        sources.some((seq) => seq === source || (seq === 10 && cutoff >= 10)) &&
        kind === 'constraint' &&
        status === 'confirmed',
    );
  const targets = [
    { name: 'invoice-v1', source: 1 },
    { name: 'invoice-v2', source: 3 },
    { name: 'invoice-v3', source: 10 },
  ];
  const target = targets.findLast(({ source }) => source <= cutoff)!;
  const confirms = (text: string, source: number) =>
    active.some(
      (entry) =>
        entry.status === 'confirmed' && entry.text.includes(text) && entry.sources.includes(source),
    );
  const unconfirmedApproval = active.some(
    ({ status, sources, text }) =>
      status === 'confirmed' &&
      sources.includes(6) &&
      !sources.some((seq) => seen.find((entry) => entry.seq === seq)?.author === 'user') &&
      /production|writes/i.test(text),
  );
  const obsoleteTarget = active.some(
    ({ kind, text, status }) =>
      kind === 'decision' &&
      status === 'confirmed' &&
      targets
        .filter(({ source }) => source < target.source)
        .some(
          ({ name }) =>
            text.includes(name) &&
            !text.includes(target.name) &&
            !/reject|replac|supersed|instead|no longer|abandon|retir|avoid|drop|obsolete|do not|not use/i.test(
              text,
            ),
        ),
  );
  const noProductionWrites =
    /(?:never|forbid|prohibit|no |must not|not allowed|restriction).*production|production.*(?:never|forbid|prohibit|must not|not allowed|restriction)/i;
  const checks = {
    objective: [1, 3, 8, 10].some((seq) => has(/INV-204|invoice replay/i, seq)),
    idempotency:
      userConstraint(/CLIENT_EVENT_ID/, 1) || (cutoff >= 3 && userConstraint(/CLIENT_EVENT_ID/, 3)),
    productionBoundary:
      userConstraint(noProductionWrites, 1) ||
      (cutoff >= 3 && userConstraint(noProductionWrites, 3)),
    currentTarget: confirms(target.name, target.source),
    acceptance:
      cutoff < 8 || has(/INV_RETRY_SPEC/, 8) || (cutoff >= 10 && has(/INV_RETRY_SPEC/, 10)),
    emptyBatch:
      cutoff < 10 ||
      has(/empty batch.*(?:keep|retain|unchanged)|(?:keep|retain).*cursor.*empty batch/i, 10),
    supersession: !obsoleteTarget,
    attribution:
      !unconfirmedApproval &&
      active.every(
        ({ status, sources }) =>
          status !== 'confirmed' ||
          sources.some((seq) => seen.find((entry) => entry.seq === seq)?.author === 'user'),
      ),
    citations: entries.every(
      ({ sources }) =>
        sources.length > 0 && sources.every((seq) => seen.some((entry) => entry.seq === seq)),
    ),
  };
  const retention = {
    path: cutoff < 4 || has(/runtime\/src\/invoice\/replay\.ts/, 4),
    symbol: cutoff < 4 || has(/retryInvoice/, 4),
    issue: cutoff < 4 || has(/cursor.*transaction|transaction.*cursor/i, 4),
    progress: cutoff < 9 || has(/verif|trial/i, 9),
    question:
      cutoff < 7 ||
      cutoff >= 10 ||
      active.some(({ kind, sources }) => kind === 'question' && sources.includes(7)),
  };
  return { checks, retention, passed: Object.values(checks).every(Boolean) };
}

async function evaluatePi(input: {
  context: string;
  endpoint: string;
  model: string;
  directory: string;
  signal: AbortSignal;
}) {
  const { session } = await createLocalPiEvaluationSession({
    ...input,
    instructions: piInstructions,
  });
  const bounded = AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]);
  const cancel = () => void session.abort();
  bounded.addEventListener('abort', cancel, { once: true });
  const started = performance.now();
  try {
    bounded.throwIfAborted();
    await session.prompt(downstreamObjective + '\n\n' + input.context);
    bounded.throwIfAborted();
    const answer = session.messages.findLast((message) => message.role === 'assistant');
    if (
      !answer ||
      answer.role !== 'assistant' ||
      ['error', 'aborted', 'length'].includes(answer.stopReason)
    )
      throw new Error('Pi did not return a complete answer.');
    if (answer.responseModel && modelTag(answer.responseModel) !== modelTag(input.model))
      throw new Error('Ollama returned a different downstream model.');
    const text = answer.content
      .flatMap((item) => (item.type === 'text' ? [item.text] : []))
      .join('')
      .trim();
    const payload = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as unknown;
    const parsed = expectedAnswer.safeParse(payload);
    return {
      passed: parsed.success,
      failedFields: parsed.success ? [] : parsed.error.issues.map(({ path }) => path.join('.')),
      elapsedMs: Math.round(performance.now() - started),
      inputTokens: answer.usage.input + answer.usage.cacheRead + answer.usage.cacheWrite,
      outputTokens: answer.usage.output,
    };
  } finally {
    bounded.removeEventListener('abort', cancel);
    session.dispose();
  }
}

async function runCadence(input: {
  settings: OllamaSettings;
  digest: string;
  threshold: number;
  downstreamModel: string;
  directory: string;
  signal: AbortSignal;
}) {
  const { settings, digest, threshold, downstreamModel, directory, signal } = input;
  const endpoint = ollamaEndpoint(settings.endpoint);
  const seen: MemoryMessage[] = [];
  let entries: MemoryEntry[] = [];
  let processed = 0;
  const attempts = [];
  const estimatedTokens = (messages: readonly MemoryMessage[]) =>
    messages.reduce((total, message) => total + estimateMemoryTokens(message.text), 0);

  async function update() {
    const pending = seen.slice(processed);
    const before = await residency(endpoint, digest, signal);
    let usage: OllamaUsage | undefined;
    let error: string | undefined;
    const start = performance.now();
    try {
      entries = await extractMemory(settings, entries, pending, signal, (value) => {
        usage = value;
      });
      processed = seen.length;
    } catch (failure) {
      signal.throwIfAborted();
      error = failure instanceof Error ? failure.message : 'Unknown extraction failure.';
    }
    const elapsedMs = performance.now() - start;
    const after = await residency(endpoint, digest, signal);
    return {
      firstSeq: pending.at(0)?.seq,
      lastSeq: pending.at(-1)?.seq,
      checkpointSeq: seen[processed - 1]?.seq ?? null,
      estimatedInputTokens: estimatedTokens(pending),
      residencyBefore: before ? 'loaded' : 'unloaded',
      elapsedMs: Math.round(elapsedMs),
      usage,
      ...(usage?.outputTokens === undefined
        ? {}
        : { outputTokensPerSecond: (usage.outputTokens * 1000) / elapsedMs }),
      loadedBytes: after?.bytes,
      gpuBytes: after?.gpuBytes,
      cpuVerified: after?.gpuBytes === 0,
      error,
      grade: error ? undefined : gradeMemory(entries, seen.slice(0, processed)),
    };
  }

  for (const turn of memoryFixture.turns.slice(0, -1)) {
    seen.push(...turn);
    if (estimatedTokens(seen.slice(processed)) >= threshold) attempts.push(await update());
  }
  seen.push(...memoryFixture.turns.at(-1)!);
  const pending = seen.slice(processed);
  const context = selectMemoryContext(entries, pending, memoryFixture.focus, pending.length > 0);
  const handoff = renderMemoryHandoff(context);
  const freshness = {
    pendingMessages: pending.length,
    pendingEstimatedTokens: estimatedTokens(pending),
    correctionIncluded: context.recent.some(({ seq }) => seq === 10),
    irrelevantExcluded: !handoff.includes(memoryFixture.irrelevantMarker),
    potentiallyIncomplete: context.incomplete,
  };
  // > Time extraction separately from the paired Pi task and its model residency.
  attempts.push(await update());
  const downstream = await evaluatePi({
    context: handoff,
    endpoint: settings.endpoint,
    model: downstreamModel,
    directory,
    signal,
  }).catch((error: unknown) => {
    signal.throwIfAborted();
    return { passed: false, error: error instanceof Error ? error.message : String(error) };
  });
  return {
    threshold,
    attempts,
    freshness,
    downstream,
    finalMemory: entries,
    passed:
      attempts.every(({ grade, cpuVerified }) => grade?.passed === true && cpuVerified) &&
      freshness.correctionIncluded &&
      freshness.irrelevantExcluded &&
      downstream.passed,
  };
}

/** Compare incremental extraction and actual handoff assembly on fixed authorized fixture data. */
export async function runSessionMemoryEvaluation(
  settings: OllamaSettings,
  signal: AbortSignal,
  downstreamModel = EVAL_MODEL,
  onProgress?: (event: string) => void,
) {
  const started = performance.now();
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-session-memory-eval-'));
  try {
    const catalog = await listEvaluationModels(settings.endpoint, signal);
    const inspect = (name: string) => {
      const model = catalog.find((entry) => modelTag(entry.name) === modelTag(name));
      return model ? inspectEvaluationModel(settings.endpoint, model, signal) : undefined;
    };
    const downstreamIdentity = await inspect(downstreamModel);
    if (!downstreamIdentity) throw new Error('The downstream Pi evaluation model is unavailable.');
    const source = memoryFixture.turns
      .flat()
      .filter(({ seq }) => (relevantSource as readonly number[]).includes(seq))
      .map(({ text, author }) => ({
        author,
        text: text.split('\nFixtures ')[0] ?? text,
      }));
    onProgress?.('Running the Pi original-source control');
    const baseline = await evaluatePi({
      context: JSON.stringify(source),
      endpoint: settings.endpoint,
      model: downstreamIdentity.name,
      directory: path.join(directory, 'original'),
      signal,
    }).catch((error: unknown) => {
      signal.throwIfAborted();
      return { passed: false, error: error instanceof Error ? error.message : String(error) };
    });

    const candidates = [];
    for (const requestedModel of models) {
      const identity = await inspect(requestedModel);
      if (!identity) {
        candidates.push({ requestedModel, error: 'Ollama model is unavailable.' });
        continue;
      }
      const cadences = [];
      for (const threshold of thresholds) {
        onProgress?.(`Evaluating ${requestedModel} at ${threshold} estimated tokens`);
        try {
          cadences.push(
            await runCadence({
              settings: {
                ...settings,
                model: identity.name,
                keepAlive: 300,
                cpuOnly: true,
                generation,
              },
              digest: identity.digest,
              threshold,
              downstreamModel: downstreamIdentity.name,
              directory: path.join(directory, String(candidates.length), String(threshold)),
              signal,
            }),
          );
        } catch (error) {
          signal.throwIfAborted();
          cadences.push({
            threshold,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      candidates.push({ identity, cadences });
    }
    const after = await listEvaluationModels(settings.endpoint, signal);
    const identityUnchanged = [
      downstreamIdentity,
      ...candidates.flatMap(({ identity }) => (identity ? [identity] : [])),
    ].every((model) =>
      after.some(({ name, digest }) => name === model.name && digest === model.digest),
    );
    return {
      fixture: memoryFixture.id,
      fixtureHash: hash(
        JSON.stringify({ memoryFixture, downstreamObjective, piInstructions, relevantSource }),
      ),
      elapsedMs: Math.round(performance.now() - started),
      platform: platform(),
      cpu: { model: cpus()[0]?.model, logicalCount: cpus().length },
      generation: JSON.parse(generation) as unknown,
      identityUnchanged,
      downstreamIdentity,
      baseline,
      candidates,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

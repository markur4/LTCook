import type { MemoryFixture } from '../runtime/src/evals/session-memory-fixtures.js';
import {
  extractMemory,
  preservePromptMessages,
} from '../runtime/src/evals/session-memory-extractive.js';
import { peakRunnerRss, residency } from '../runtime/src/evals/session-memory.js';
import {
  ollamaEndpoint,
  type OllamaChatMetrics,
  type OllamaSettings,
  type OllamaUsage,
} from '../runtime/src/integrations/ollama.js';
import { SessionMemory } from '../runtime/src/session-memory/service.js';
import {
  memoryHistory,
  type MemorySummaryResult,
  prepareMemorySummaries,
  sessionMemoryGeneration,
  sessionMemoryModel,
  summarizeMemory,
} from '../runtime/src/session-memory/summarization.js';
import {
  budgetMemoryText,
  estimateMemoryTokens,
  memoryIdentifierMatches,
  memoryRelevance,
  missingMemoryIdentifiers,
} from '../runtime/src/session-memory/text.js';
import {
  identifyMemoryUnits,
  observedMemoryChecks,
  type MemorySourceMessage,
  type MemoryUnit,
} from '../runtime/src/session-memory/units.js';

export const contextStrategies = [
  'extractive',
  'token-based',
  'logical',
  'rolling',
  'original-search',
] as const;
export type ContextStrategy = (typeof contextStrategies)[number];
export const contextModel = sessionMemoryModel;

type Request = {
  kind?: MemoryUnit['type'];
  first: number;
  last: number;
  elapsedMs: number;
  historyEstimatedTokens?: number;
  usage?: OllamaUsage;
  metrics?: OllamaChatMetrics;
  complete: boolean;
  json?: boolean;
  fields?: string[];
  error?: string;
};
type Evidence = { sources: readonly number[]; text: string };

function oldBatches(fixture: MemoryFixture): MemorySourceMessage[][] {
  const pending: MemorySourceMessage[] = [];
  const batches: MemorySourceMessage[][] = [];
  for (const turn of fixture.turns.slice(0, -1)) {
    pending.push(...turn.filter(({ author }) => author !== 'runtime'));
    const end = turn.at(-1)?.seq;
    if (
      end !== undefined &&
      (fixture.flushAfter.includes(end) ||
        pending.reduce((tokens, { text }) => tokens + estimateMemoryTokens(text), 0) >= 3000)
    ) {
      batches.push(pending.splice(0));
    }
  }
  if (pending.length) batches.push(pending);
  return batches;
}

function logicalUnits(fixture: MemoryFixture) {
  const prompts = new Map<string, 'completed'>();
  const messages: MemorySourceMessage[] = [];
  let turn: MemorySourceMessage[] = [];
  const addTurn = () => {
    if (!turn.length) return;
    const turnId = turn[0]!.turnId ?? String(turn[0]!.seq);
    if (turn.some(({ author }) => author === 'agent')) prompts.set(turnId, 'completed');
    messages.push(...turn.map((message) => ({ ...message, turnId })));
    turn = [];
  };
  for (const source of fixture.turns.slice(0, -1).flat()) {
    if (
      source.turnId !== undefined
        ? source.turnId !== turn[0]?.turnId
        : turn[0]?.turnId !== undefined ||
          source.author === 'user' ||
          source.author === 'runtime' ||
          source.author === 'unknown'
    )
      addTurn();
    turn.push(source);
  }
  addTurn();
  return identifyMemoryUnits(messages, prompts, 3000, true);
}

function handoffFor(fixture: MemoryFixture, evidence: Evidence[], recoverSources: boolean) {
  const context = fixture.turns.flat();
  const last = fixture.turns.at(-1)!;
  const queries = new Map(last.map((message) => [message.seq, message]));
  const originals = context.filter(({ author }) => author === 'user');
  const user = budgetMemoryText(
    originals.sort(
      (a, b) => Number(queries.has(b.seq)) - Number(queries.has(a.seq)) || b.seq - a.seq,
    ),
    650,
    fixture.focus,
    (item) => estimateMemoryTokens(JSON.stringify(item)),
  );
  const ranked = [...evidence].sort(
    (a, b) =>
      memoryRelevance(b.text, fixture.focus) - memoryRelevance(a.text, fixture.focus) ||
      b.sources.at(-1)! - a.sources.at(-1)!,
  );
  const pack = (entries: Evidence[], identifiers: readonly string[] = []) =>
    budgetMemoryText(
      entries,
      900,
      fixture.focus,
      (item) => estimateMemoryTokens(JSON.stringify(item) + '\n'),
      identifiers,
    );
  let selected = pack(ranked).selected;
  let recovered: Evidence[] = [];
  if (recoverSources) {
    const identifiers = missingMemoryIdentifiers(
      fixture.focus,
      [...user.selected, ...selected].map(({ text }) => text).join('\n'),
    );
    if (identifiers.length) {
      recovered = context
        .filter(({ author }) => author !== 'runtime')
        .flatMap(({ seq, text, attachments }) =>
          [text, ...(attachments ?? []).map((item) => item.text)]
            .map((body) => ({
              evidence: { sources: [seq], text: body },
              score: memoryIdentifierMatches(body, identifiers).size,
            }))
            .filter(({ score }) => score > 0),
        )
        .sort(
          (a, b) =>
            b.score - a.score || b.evidence.sources[0]! - a.evidence.sources[0]!,
        )
        .map(({ evidence }) => evidence);
      selected = pack([...recovered, ...ranked], identifiers).selected;
    }
  }
  const chronological = selected.sort((a, b) => a.sources.at(-1)! - b.sources.at(-1)!);
  const recoveredReferences = new Set(recovered.map(({ sources }) => sources));
  const recent = last.filter(({ author }) => author !== 'runtime' && author !== 'user');
  const supplied = [
    ...user.selected.map(({ seq, text }) => ({ sources: [seq], text })),
    ...chronological,
    ...recent.map(({ seq, text }) => ({ sources: [seq], text })),
  ];
  return {
    supplied,
    recoveredSources: [
      ...new Set(
        chronological
          .filter(({ sources }) => recoveredReferences.has(sources))
          .flatMap(({ sources }) => sources),
      ),
    ],
    text: [
      'Follow the current assignment and latest original user instructions. Resolve uncertain decisions against original user messages. Prefer original tool results for observed outcomes.',
      'Original user messages',
      ...user.selected.sort((a, b) => a.seq - b.seq).map((item) => JSON.stringify(item)),
      'Historical evidence with original sequence references',
      ...chronological.map((item) => JSON.stringify(item)),
      'Recent original messages',
      ...recent.map((item) => JSON.stringify(item)),
    ].join('\n'),
  };
}

export async function compareContextMemory(
  fixture: MemoryFixture,
  input: {
    settings: OllamaSettings;
    digest: string;
    weightsDigest?: string;
    signal: AbortSignal;
    progress?: (message: string) => void;
    strategies?: readonly ContextStrategy[];
  },
) {
  const { signal, digest, weightsDigest, progress } = input;
  const settings = {
    ...input.settings,
    model: contextModel,
    keepAlive: 900,
    cpuOnly: true,
    generation: JSON.stringify(sessionMemoryGeneration),
  };
  const endpoint = ollamaEndpoint(settings.endpoint);
  const units = logicalUnits(fixture);
  const batches = oldBatches(fixture);
  const originals = fixture.turns.flat();
  const sourceBySequence = new Map(originals.map((message) => [message.seq, message]));
  const lastSequences = new Set(fixture.turns.at(-1)!.map(({ seq }) => seq));
  const arms = [];
  for (const strategy of input.strategies ?? contextStrategies) {
    signal.throwIfAborted();
    progress?.(`${fixture.id} ${strategy}`);
    const started = performance.now();
    const requests: Request[] = [];
    const evidence: Evidence[] = [];
    const observedChecks: Evidence[] = [];
    const summaries: { type: MemoryUnit['type']; text: string }[] = [];
    if (strategy === 'extractive') {
      for (const batch of batches) {
        const start = performance.now();
        let usage: OllamaUsage | undefined;
        let metrics: OllamaChatMetrics | undefined;
        if (!batch.some(({ author }) => author === 'agent' || author === 'tool')) continue;
        let complete = false;
        let error: string | undefined;
        try {
          const extracted = await extractMemory(settings, batch, signal, {
            onUsage: (value) => {
              usage = value;
            },
            onMetrics: (value) => {
              metrics = value;
            },
          });
          evidence.push(...extracted.map(({ seq, text }) => ({ sources: [seq], text })));
          complete = true;
        } catch (failure) {
          signal.throwIfAborted();
          error = failure instanceof Error ? failure.message : 'Extraction failed.';
        }
        requests.push({
          first: batch[0]!.seq,
          last: batch.at(-1)!.seq,
          elapsedMs: Math.round(performance.now() - start),
          complete,
          error,
          usage,
          metrics,
        });
      }
    } else if (strategy !== 'original-search') {
      const selected: readonly MemoryUnit[] =
        strategy === 'token-based'
          ? batches.map((messages) => ({ type: 'UAMP', messages }))
          : units;
      for (const unit of selected) {
        if (unit.type === 'AAB') {
          observedChecks.push(
            ...observedMemoryChecks(unit.messages).map(({ seq, text }) => ({
              sources: [seq],
              text,
            })),
          );
        }
        const history = strategy === 'rolling' ? memoryHistory(summaries) : '';
        const output: string[] = [];
        const parts = prepareMemorySummaries(unit, history);
        for (const part of parts) {
          const started = performance.now();
          const result = await summarizeMemory(
            settings,
            part.prompt,
            signal,
            unit.type,
            true,
          ).catch((failure: unknown) => {
            signal.throwIfAborted();
            requests.push({
              kind: unit.type,
              first: part.sources[0]!,
              last: part.sources.at(-1)!,
              elapsedMs: Math.round(performance.now() - started),
              complete: false,
              historyEstimatedTokens: estimateMemoryTokens(history),
              error: failure instanceof Error ? failure.message : 'Summarization failed.',
            });
            return undefined;
          });
          if (!result) continue;
          let json = false;
          try {
            JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/gi, ''));
            json = true;
          } catch {}
          requests.push({
            kind: unit.type,
            first: part.sources[0]!,
            last: part.sources.at(-1)!,
            historyEstimatedTokens: estimateMemoryTokens(history),
            elapsedMs: result.elapsedMs,
            usage: result.usage,
            metrics: result.metrics,
            complete: result.complete,
            json,
            fields: Object.keys(result.fields ?? {}),
          });
          if (result.complete) output.push(result.text);
        }
        if (parts.length && output.length === parts.length) {
          const text = output.join('\n');
          summaries.push({ type: unit.type, text });
          evidence.push({ sources: unit.messages.map(({ seq }) => seq), text });
        }
      }
    } else {
      evidence.push(
        ...originals.flatMap(({ seq, attachments }) =>
          (attachments ?? []).map(({ text }) => ({ sources: [seq], text })),
        ),
      );
      evidence.push(
        ...originals
          .filter(
            ({ author, seq }) =>
              author !== 'user' && author !== 'runtime' && !lastSequences.has(seq),
          )
          .map(({ seq, text }) => ({ sources: [seq], text })),
      );
    }
    const handoff = handoffFor(
      fixture,
      [...evidence, ...observedChecks],
      strategy === 'logical' || strategy === 'rolling',
    );
    const grade = fixture.facts.map((fact) => {
      const hasIdentifiers = (text: string) =>
        !fact.identifiers ||
        memoryIdentifierMatches(text, fact.identifiers).size === fact.identifiers.length;
      const retainsFact = (text: string) => fact.expected.test(text) && hasIdentifiers(text);
      const directUser = preservePromptMessages([sourceBySequence.get(fact.source)!]).map(
        ({ text }) => text,
      );
      const relevant = [
        ...directUser,
        ...evidence.filter(({ sources }) => sources.includes(fact.source)).map(({ text }) => text),
      ];
      const contradicted =
        !!fact.contradicts &&
        evidence.some(({ text }) => fact.contradicts!.test(text) && hasIdentifiers(text));
      const retained = relevant.some(retainsFact);
      return {
        label: fact.label,
        critical: !!fact.critical,
        retained,
        retainedWithObservedChecks:
          retained ||
          observedChecks.some(
            ({ sources, text }) => sources.includes(fact.source) && retainsFact(text),
          ),
        retainedInHandoff: handoff.supplied.some(
          ({ sources, text }) => sources.includes(fact.source) && retainsFact(text),
        ),
        contradicted,
      };
    });
    const loaded = requests.length ? await residency(endpoint, digest, signal) : undefined;
    arms.push({
      strategy,
      requests,
      grade,
      handoff: handoff.text,
      recoveredSources: handoff.recoveredSources,
      elapsedMs: Math.round(performance.now() - started),
      handoffEstimatedTokens: estimateMemoryTokens(handoff.text),
      historicalEvidenceEstimatedTokens: estimateMemoryTokens(
        evidence.map(({ text }) => text).join('\n'),
      ),
      loadedBytes: loaded?.bytes,
      gpuBytes: loaded?.gpuBytes,
      peakRunnerRssBytes: requests.length ? await peakRunnerRss(weightsDigest) : undefined,
    });
  }
  return {
    fixture: fixture.id,
    sourceEstimatedTokens: estimateMemoryTokens(
      originals
        .flatMap(({ text, attachments }) => [text, ...(attachments ?? []).map(({ text }) => text)])
        .join('\n'),
    ),
    arms,
  };
}

export async function measureContextCache(input: {
  settings: OllamaSettings;
  digest: string;
  weightsDigest?: string;
  signal: AbortSignal;
  progress?: (message: string) => void;
}) {
  const settings = {
    ...input.settings,
    model: contextModel,
    cpuOnly: true,
    keepAlive: 900,
    generation: JSON.stringify(sessionMemoryGeneration),
  };
  const endpoint = ollamaEndpoint(settings.endpoint);
  const prior = Array.from({ length: 10 }, (_, index) => ({
    type: 'AAB' as const,
    text: Array.from(
      { length: 18 },
      (_, row) =>
        `For LUT-${index}, the documentation work group verified guide section ${row} and retained its current link anchor. The native check passed with no edits.`,
    ).join('\n'),
  }));
  const probeUnit: MemoryUnit = {
    type: 'UAMP',
    messages: [
      {
        seq: 100,
        author: 'user',
        text: 'Use the existing runtimeConfig API. The old summary that claimed we approved removing it is incorrect. Keep the current signature in runtime/src/main.ts.',
      },
      {
        seq: 101,
        author: 'agent',
        text: 'Understood. I will preserve runtimeConfig and its signature.',
      },
    ],
  };
  const correctionHistory = memoryHistory([
    {
      type: 'UAMP',
      text: 'Accepted decision from earlier Discussion: Remove the runtimeConfig symbol and add a replacement API.',
    },
  ]);
  const samples: (Omit<MemorySummaryResult, 'text' | 'fields'> & {
    label: string;
    historicalEstimatedTokens: number;
    fields: string[];
    loadedBytes?: number;
    gpuBytes?: number;
    peakRunnerRssBytes?: number;
    keepsRuntimeConfig: boolean;
    preservesPath: boolean;
    falseRemovalUnderDecisions: boolean;
  })[] = [];
  const sample = async (label: string, history: string, unit = probeUnit) => {
    input.progress?.(label);
    const prompt = prepareMemorySummaries(unit, history)[0]!.prompt;
    const { text, ...stats } = await summarizeMemory(
      settings,
      prompt,
      input.signal,
      unit.type,
      true,
    );
    const model = await residency(endpoint, input.digest, input.signal);
    const sample = {
      label,
      historicalEstimatedTokens: estimateMemoryTokens(history),
      ...stats,
      fields: Object.keys(stats.fields ?? {}),
      loadedBytes: model?.bytes,
      gpuBytes: model?.gpuBytes,
      peakRunnerRssBytes: await peakRunnerRss(input.weightsDigest),
      keepsRuntimeConfig:
        /\b(?:keep|preserve|retain|maintain|use)\b.{0,115}\bruntimeConfig\b/i.test(text),
      preservesPath: text.includes('runtime/src/main.ts'),
      falseRemovalUnderDecisions: /\b(?:approve|agreed|accepted)\b.{0,80}\bremov(?:e|ing)\b/i.test(
        JSON.stringify(stats.fields?.decisions ?? ''),
      ),
    };
    samples.push(sample);
    return sample;
  };
  const before = prior.findIndex((_, index) => {
    if (index === 0) return false;
    const previous = memoryHistory(prior.slice(0, index));
    return previous.length > 0 && !memoryHistory(prior.slice(0, index + 1)).startsWith(previous);
  });
  if (before < 0) throw new Error('The cache fixture does not exercise grouped eviction.');
  const preEviction = memoryHistory(prior.slice(0, before));
  const postEviction = memoryHistory(prior.slice(0, before + 1));
  const grown = memoryHistory(prior.slice(0, before + 2));
  await sample('prior-summary-contradicted-by-current-user', correctionHistory);
  await sample('agent-A-uncached-history', preEviction);
  await sample('agent-A-repeat-same-history', preEviction);
  await sample(
    'agent-B-with-different-history',
    memoryHistory([{ ...prior.at(-1)!, text: prior.at(-1)!.text.replaceAll('LUT-', 'DOC-') }]),
  );
  await sample('agent-A-return-after-agent-switch', preEviction);
  await sample('agent-A-grouped-eviction', postEviction);
  await sample('agent-A-grow-after-eviction', grown);
  await sample('agent-A-repeat-after-eviction', grown);
  const foregroundUnit: MemoryUnit = {
    type: 'UAMP',
    messages: [
      {
        seq: 1,
        author: 'user',
        text: 'Keep TOOL_VERIFY in src/verify.ts and use the recorded check result.',
      },
      {
        seq: 2,
        author: 'agent',
        text: 'TOOL_VERIFY passed in src/verify.ts after the scheduling check.',
      },
    ],
  };
  await sample('foreground-baseline', '', foregroundUnit);
  const queue: {
    kind: MemoryUnit['type'];
    queueMs: number;
    elapsedMs: number;
    complete: boolean;
  }[] = [];
  const pending = Promise.withResolvers<void>();
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: {
      async read(agentId, cursor) {
        const messages = foregroundUnit.messages
          .map((message) => ({
            ...message,
            turnId: agentId,
            text: message.text.replaceAll('TOOL_VERIFY', agentId === 'A' ? 'CHECK_A' : 'CHECK_B'),
          }))
          .filter(({ seq }) => seq > (cursor?.seq ?? 0));
        return {
          epoch: agentId,
          earliest: 1,
          start: 1,
          latest: 2,
          through: 2,
          reset: false,
          messages,
        };
      },
    },
    summarize: (type, prompt, signal) =>
      summarizeMemory(settings, prompt, AbortSignal.any([signal, input.signal]), type, true),
    onRequest({ type: kind, queueMs, result: { elapsedMs, complete } }) {
      queue.push({ kind, queueMs, elapsedMs, complete });
      if (queue.length === 2) pending.resolve();
    },
    onFailure: () => pending.reject(new Error('Queued Session Memory probe did not complete.')),
  });
  const release = memory.holdForeground();
  const guard = AbortSignal.any([input.signal, AbortSignal.timeout(240_000)]);
  const abort = () => pending.reject(guard.reason);
  guard.addEventListener('abort', abort, { once: true });
  try {
    memory.turn('A', { turnId: 'A', outcome: 'completed' }, false);
    memory.turn('B', { turnId: 'B', outcome: 'completed' }, false);
    await sample('foreground-with-queued-memory', '', foregroundUnit);
    if (queue.length)
      throw new Error('The foreground priority probe started background inference early.');
    release();
    await pending.promise;
  } finally {
    guard.removeEventListener('abort', abort);
    await memory.close();
  }
  return { samples, queue };
}

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MemoryFixture } from '../runtime/src/evals/session-memory-fixtures.js';
import {
  contradictsMemoryFact,
  matchesMemoryFact,
} from '../runtime/src/evals/session-memory-facts.js';
import { peakRunnerRss, residency } from '../runtime/src/evals/session-memory.js';
import {
  ollamaEndpoint,
  type OllamaChatMetrics,
  type OllamaSettings,
  type OllamaUsage,
} from '../runtime/src/integrations/ollama.js';
import {
  memoryDispatchDeadlineMs,
  SessionMemory,
  type MemorySource,
  type MemorySearchEntry,
} from '../runtime/src/session-memory/service.js';
import { MemoryStore, type StoredMemorySummary } from '../runtime/src/session-memory/store.js';
import {
  defaultMemoryBudgets,
  type MemoryHistoryEntry,
  prepareMemorySummaries,
  sessionMemoryGeneration,
  sessionMemoryModel,
  summarizeMemory,
} from '../runtime/src/session-memory/summarization.js';
import { estimateMemoryTokens } from '../runtime/src/session-memory/text.js';
import {
  identifyMemoryUnits,
  observedMemoryChecks,
  type MemorySourceMessage,
  type MemoryUnit,
} from '../runtime/src/session-memory/units.js';

export const contextStrategies = [
  'no-context',
  'task-context',
  'immediate',
  'original-search',
] as const;
export const routineContextStrategies = ['task-context', 'immediate'] as const;
export const defaultContextSeeds = [17] as const;

export function contextSeeds(raw?: string) {
  if (raw === undefined) return [...defaultContextSeeds];
  const seeds = raw.split(',').map((item) => item.trim());
  if (
    seeds.some((seed) => !/^\d+$/.test(seed) || !Number.isSafeInteger(Number(seed))) ||
    new Set(seeds.map(Number)).size !== seeds.length
  )
    throw new Error('Supply distinct nonnegative integer seeds.');
  return seeds.map(Number);
}
export type ContextStrategy = (typeof contextStrategies)[number];
export const contextModel = sessionMemoryModel;

function contextSettings(settings: OllamaSettings, seed?: number): OllamaSettings {
  return {
    ...settings,
    model: contextModel,
    keepAlive: 900,
    cpuOnly: settings.cpuOnly ?? false,
    generation: JSON.stringify({
      ...sessionMemoryGeneration,
      options: { ...sessionMemoryGeneration.options, seed },
    }),
  };
}

type Request = {
  kind?: MemoryUnit['type'];
  first: number;
  sources?: number[];
  attachmentSources?: number[];
  sourceHash?: string;
  prefixHash?: string;
  historyIds?: string[];
  authoritativeEstimatedTokens?: number;
  last: number;
  elapsedMs: number;
  historyEstimatedTokens?: number;
  originalEstimatedTokens?: number;
  usage?: OllamaUsage;
  metrics?: OllamaChatMetrics;
  complete: boolean;
  json?: boolean;
  fields?: string[];
  error?: string;
};
type Evidence = { sources: readonly number[]; text: string };

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

/** Benchmark one production-shaped request without running any preceding summaries. */
export async function sampleContextMemory(
  fixture: MemoryFixture,
  input: { settings: OllamaSettings; digest: string; seed: number; signal: AbortSignal },
) {
  const settings = contextSettings({ ...input.settings, cpuOnly: true }, input.seed);
  const unit = logicalUnits(fixture).find(
    ({ type, messages }) => type === 'AAB' && messages.length === 1 && messages[0]?.seq === 8,
  );
  if (!unit) throw new Error('The CPU timing fixture has no isolated cache-check action.');
  const [portion, extra] = prepareMemorySummaries(
    { ...unit, task: unit.task ?? fixture.taskContext },
    [],
  );
  if (!portion || extra) throw new Error('The CPU timing sample must fit in one request.');
  const result = await summarizeMemory(settings, portion.prompt, input.signal, unit.type, true);
  const loaded = await residency(ollamaEndpoint(settings.endpoint), input.digest, input.signal);
  return {
    fixture: fixture.id,
    seed: input.seed,
    sources: portion.sources,
    originalEstimatedTokens: portion.sourceSize,
    cpuVerified: !!loaded && loaded.bytes > 0 && loaded.gpuBytes === 0,
    ...result,
  };
}

const evaluationAgent = 'leader';
const evaluationEpoch = 'fixed-history';

export function transcriptSource(
  history: readonly MemorySourceMessage[] | ((id: string) => readonly MemorySourceMessage[]),
): MemorySource {
  return {
    async read(id, cursor, direction = 'after') {
      const messages = typeof history === 'function' ? history(id) : history;
      const latest = messages.at(-1)?.seq ?? -1;
      const page =
        direction === 'tail'
          ? messages.slice(-16)
          : direction === 'before'
            ? messages.filter(({ seq }) => seq < cursor!.seq).slice(-16)
            : messages.filter(({ seq }) => seq > (cursor?.seq ?? -1)).slice(0, 16);
      const epoch = typeof history === 'function' ? id : evaluationEpoch;
      return {
        epoch,
        earliest: messages[0]?.seq,
        start: page[0]?.seq,
        latest,
        through: page.at(-1)?.seq ?? cursor?.seq ?? -1,
        reset: cursor !== undefined && cursor.epoch !== epoch,
        messages: page.map((item) => ({ ...item })),
      };
    },
  };
}

async function withProductionMemory(
  fixture: MemoryFixture,
  records: StoredMemorySummary[],
  signal: AbortSignal,
  originalControl: boolean,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-memory-handoff-'));
  const file = path.join(directory, 'memory.sqlite');
  const messages = fixture.turns.flat();
  const processed = fixture.turns.slice(0, -1).flat();
  const elapsed = performance.now();
  try {
    const store = new MemoryStore(file);
    try {
      store.savePrompts(evaluationAgent, evaluationEpoch, processed);
      store.saveState(evaluationAgent, {
        epoch: evaluationEpoch,
        seq: Math.min(
          processed.at(-1)?.seq ?? -1,
          ...records.filter(({ complete }) => !complete).map(({ sources }) => sources[0]!.seq - 1),
        ),
      });
      for (const record of records) store.saveSummary(record);
    } finally {
      store.close();
    }
    const memory = new SessionMemory({
      databasePath: file,
      source: transcriptSource(messages),
      summarize: async (type) => ({ type, text: '', complete: false, elapsedMs: 0 }),
    });
    try {
      const assemble = async (recoverOriginals: boolean) => {
        const start = performance.now();
        const empty = {
          text: '',
          entries: [] as MemorySearchEntry[],
          recoveredSources: [] as number[],
        };
        if (!records.length) return { ...empty, elapsedMs: undefined, timedOut: false };
        const deadline = AbortSignal.timeout(memoryDispatchDeadlineMs);
        const handoff = await memory
          .handoffDetails(
            evaluationAgent,
            fixture.focus,
            AbortSignal.any([signal, deadline]),
            recoverOriginals,
          )
          .catch((error: unknown) => {
            signal.throwIfAborted();
            if (!deadline.aborted) throw error;
            return empty;
          });
        return { ...handoff, elapsedMs: performance.now() - start, timedOut: deadline.aborted };
      };
      const handoff = await assemble(true);
      const handoffWithoutRecovery = await assemble(false);
      const searchStarted = performance.now();
      const search = await memory.search(
        evaluationAgent,
        '',
        fixture.focus,
        evaluationAgent,
        signal,
        true,
      );
      const originalSearch = search.matches.flatMap(({ entries }) => entries);
      const corrections = originalControl
        ? await Promise.all(
            fixture.correctionSources.map((seq) =>
              memory.sourceMessage(evaluationAgent, '', {
                agentId: evaluationAgent,
                epoch: evaluationEpoch,
                seq,
              }),
            ),
          )
        : [];
      const originalHandoff =
        originalControl && corrections.every((item) => item !== undefined)
          ? 'Authorized original conversation evidence. Use the latest explicit user decision.\n' +
            JSON.stringify(
              [
                ...originalSearch.filter(({ seq }) => !fixture.correctionSources.includes(seq)),
                ...corrections,
              ].map(({ seq, author, text }) => ({ seq, author, text })),
            )
          : '';
      return {
        handoff,
        handoffWithoutRecovery,
        originalSearch,
        originalHandoff,
        originalSearchIncomplete: search.incomplete,
        originalSearchMs: performance.now() - searchStarted,
        assemblyMs: performance.now() - elapsed,
      };
    } finally {
      await memory.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function gradesMemoryFact(
  fact: MemoryFixture['facts'][number],
  entry: Pick<MemorySearchEntry, 'seq' | 'sources' | 'text'>,
) {
  return (
    (entry.sources ?? [entry.seq]).includes(fact.source) && matchesMemoryFact(fact, entry.text)
  );
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
    auditOutput?: boolean;
    seed?: number;
  },
) {
  const { signal, digest, weightsDigest, progress } = input;
  const settings = contextSettings(input.settings, input.seed);
  const endpoint = ollamaEndpoint(settings.endpoint);
  const units = logicalUnits(fixture);
  const originals = fixture.turns.flat();
  const sourceBySequence = new Map(originals.map((message) => [message.seq, message]));
  const primaryTask = originals.find(({ author, scope }) => author === 'user' && !!scope?.taskId)
    ?.scope?.taskId;
  const arms = [];
  for (const strategy of input.strategies ?? routineContextStrategies) {
    signal.throwIfAborted();
    progress?.(`${fixture.id} ${strategy}`);
    const started = performance.now();
    const requests: Request[] = [];
    const evidence: Evidence[] = [];
    const summaries: MemoryHistoryEntry[] = [];
    const records: StoredMemorySummary[] = [];
    const save = (
      unit: MemoryUnit,
      parts: StoredMemorySummary['parts'],
      complete: boolean,
      expectedParts = parts.length,
    ) => {
      const first = unit.messages[0]!.seq;
      const position = unit.messages.at(-1)!.seq;
      const id = [unit.type, first, position].join(':');
      records.push({
        id,
        agentId: evaluationAgent,
        sessionId: evaluationAgent,
        epoch: evaluationEpoch,
        position,
        type: unit.type,
        scope: unit.scope,
        sources: [...unit.messages],
        createdAt: new Date().toISOString(),
        historyHash: '',
        parts,
        complete,
        expectedParts,
        observedChecks: unit.type === 'AAB' ? observedMemoryChecks(unit.messages) : undefined,
      });
      if (complete)
        for (const [index, part] of parts.entries())
          summaries.push({
            ...part,
            type: unit.type,
            scope: unit.scope,
            unitId: id,
            id: `${id}/${index + 1}`,
          });
    };
    if (strategy !== 'original-search') {
      for (const unit of units) {
        const current = {
          ...unit,
          task: unit.task ?? (unit.scope?.taskId === primaryTask ? fixture.taskContext : undefined),
        };
        const output: StoredMemorySummary['parts'] = [];
        const parts = prepareMemorySummaries(current, summaries, defaultMemoryBudgets, {
          mode: strategy,
        });
        for (const part of parts) {
          const started = performance.now();
          const sourceHash = createHash('sha256').update(part.text).digest('hex');
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
              historyEstimatedTokens: part.historyEstimatedTokens,
              originalEstimatedTokens: part.sourceSize,
              sources: part.sources,
              attachmentSources: part.attachmentSources,
              sourceHash,
              prefixHash: part.prefixHash,
              historyIds: part.historyIds,
              authoritativeEstimatedTokens: part.authoritativeEstimatedTokens,
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
            historyEstimatedTokens: part.historyEstimatedTokens,
            originalEstimatedTokens: part.sourceSize,
            sources: part.sources,
            attachmentSources: part.attachmentSources,
            sourceHash,
            prefixHash: part.prefixHash,
            historyIds: part.historyIds,
            authoritativeEstimatedTokens: part.authoritativeEstimatedTokens,
            elapsedMs: result.elapsedMs,
            usage: result.usage,
            metrics: result.metrics,
            complete: result.complete,
            json,
            fields: Object.keys(result.fields ?? {}),
          });
          if (result.complete)
            output.push({
              text: result.text,
              fields: result.fields,
              sources: part.sources,
              noUsefulInformation: result.noUsefulInformation,
            });
        }
        const complete = parts.length > 0 && output.length === parts.length;
        if (parts.length) save(unit, output, complete, parts.length);
        if (complete) evidence.push(...output.filter((part) => !part.noUsefulInformation));
      }
    }
    const assembled = await withProductionMemory(
      fixture,
      records,
      signal,
      strategy === 'original-search',
    );
    const grade = fixture.facts.map((fact) => {
      const source = sourceBySequence.get(fact.source);
      const reference =
        fact.contextSource === undefined ? undefined : sourceBySequence.get(fact.contextSource);
      const matches = (text: string) => matchesMemoryFact(fact, text);
      return {
        label: fact.label,
        critical: !!fact.critical,
        attachment: !!fact.attachment,
        sourceCovered:
          !!source &&
          (fact.attachment
            ? (source.attachments ?? []).some(({ text }) => !!text && matches(text))
            : [source.text, reference?.text].some((text) => !!text && matches(text))),
        suppliedToSummarizer: requests.some((request) =>
          (fact.attachment ? request.attachmentSources : request.sources)?.includes(fact.source),
        ),
        retained:
          strategy === 'original-search'
            ? undefined
            : evidence.some(({ sources, text }) => sources.includes(fact.source) && matches(text)),
        retainedInHandoff: assembled.handoff.entries.some((entry) => gradesMemoryFact(fact, entry)),
        retainedWithoutOriginalRecovery: assembled.handoffWithoutRecovery.entries.some((entry) =>
          gradesMemoryFact(fact, entry),
        ),
        matchingTextWithoutPortionReference: evidence.some(
          ({ sources, text }) => !sources.includes(fact.source) && matches(text),
        ),
        wrongIdentifierSpelling:
          !!fact.identifiers &&
          evidence.some(
            ({ sources, text }) =>
              sources.includes(fact.source) && fact.expected.test(text) && !matches(text),
          ),
        retrievedByOriginalSearch: assembled.originalSearch.some((entry) =>
          gradesMemoryFact(fact, entry),
        ),
        contradicted: evidence.some(({ text }) => contradictsMemoryFact(fact, text)),
      };
    });
    const loaded = requests.length ? await residency(endpoint, digest, signal) : undefined;
    const handoff =
      strategy === 'original-search' ? assembled.originalHandoff : assembled.handoff.text;
    arms.push({
      strategy,
      seed: input.seed,
      requests,
      grade,
      handoff,
      recoveredSources: assembled.handoff.recoveredSources,
      dispatchMs: assembled.handoff.elapsedMs,
      dispatchTimedOut: assembled.handoff.timedOut,
      dispatchWithoutOriginalRecoveryMs: assembled.handoffWithoutRecovery.elapsedMs,
      handoffWithoutOriginalRecoveryEstimatedTokens: estimateMemoryTokens(
        assembled.handoffWithoutRecovery.text,
      ),
      ...(input.auditOutput
        ? {
            summaryAudit: records.map(({ id, type, parts, complete }) => ({
              id,
              type,
              parts,
              complete,
            })),
          }
        : {}),
      originalSearchMs: assembled.originalSearchMs,
      originalSearchIncomplete: assembled.originalSearchIncomplete,
      elapsedMs: Math.round(performance.now() - started),
      handoffEstimatedTokens: estimateMemoryTokens(handoff),
      outputTokensByType: Object.fromEntries(
        ['UAMP', 'AAB'].map((type) => [
          type,
          requests
            .filter(({ kind }) => kind === type)
            .map(({ usage }) => usage?.outputTokens ?? null),
        ]),
      ),
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

import { createHash, randomUUID } from 'node:crypto';
import type { OllamaDeviceCatalog } from '../integrations/ollama-devices.js';
import { OllamaSummaryError, type OllamaSettings } from '../integrations/ollama.js';
import { isEmptyMemorySummary, memorySummaryText } from './json.js';
import {
  budgetMemoryText,
  memoryRelevance,
  estimateMemoryTokens,
  memoryIdentifierMatches,
  memoryIdentifiers,
  memoryPreview,
} from './text.js';
import {
  compactHandoffLine,
  renderMemoryHandoff,
  unavailableMemoryHandoff,
  type MemoryHandoffSelection,
  type OriginalHistoryAvailability,
} from './handoff.js';
import {
  automaticMemoryDevice,
  MemoryStore,
  type MemoryDevice,
  type MemoryState,
  type MemorySummaryCursor,
  type MemorySummaryPassage,
  type MemoryTurn,
  type StoredMemorySummary,
} from './store.js';
import {
  defaultMemoryBudgets,
  MemoryInputBudgetError,
  relevantMemoryScope,
  retrievableSummaryStatements,
  prepareMemorySummaries,
  originalUampDialogue,
  type MemoryBudgets,
  type MemorySummaryProgress,
  type MemorySummaryResult,
  type MemorySummaryFormat,
} from './summarization.js';
import {
  identifyMemoryUnits,
  isMemoryInstruction,
  scopeKey,
  observedMemoryChecks,
  type MemorySourceMessage,
  type MemoryScope,
  type MemoryTurnOutcome,
  type MemoryUnit,
} from './units.js';

export type MemoryCursor = { epoch: string; seq: number };
export type MemoryPage = {
  epoch: string;
  latest: number;
  start?: number;
  earliest?: number;
  through: number;
  reset: boolean;
  messages: MemorySourceMessage[];
};
export interface MemorySource {
  read(
    agentId: string,
    cursor?: MemoryCursor,
    direction?: 'after' | 'tail' | 'before',
  ): Promise<MemoryPage>;
  watch?(agentId: string, notify: () => void): () => void;
  invalidateAttachments?(agentId: string, epoch: string, from?: number): Promise<void>;
}

type UnitCounts = { uamp: number; aab: number };
type SummaryOutcome = 'up-to-date' | 'below-threshold' | 'failed' | 'unknown';
type MemoryError = { at: string; message: string };
type StoredMemory = UnitCounts & { agentId: string; epoch: string; coveredThrough: number | null };
type DeliveredMemory = UnitCounts & {
  sessionId: string;
  recipientAgentId: string;
  recipientEpoch: string | null;
  sourceAgentId: string;
  sourceEpoch: string;
  deliveredAt: string;
  bytes: number;
};

export type MemoryHandoffObservation = UnitCounts & {
  bytes: number;
  sourceAgentId: string;
  sourceEpoch: string;
  sourceGeneration: symbol;
};

export type SessionMemoryStatus = {
  device: MemoryDevice;
  summarization: SummaryOutcome | 'paused' | 'queued' | 'summarizing';
  rate: MemorySummaryProgress | null;
  lastSuccessfulSummaryAt: string | null;
  lastError: MemoryError | null;
  stored: StoredMemory | null;
  lastDelivered: DeliveredMemory | null;
  currentContext: null;
  pendingUamp: number | null;
  pendingAab: number | null;
};

type AgentMemoryActivity = {
  generation: symbol;
  epoch?: string;
  latest?: number;
  outcome: SummaryOutcome;
  stored?: StoredMemory;
  pending?: UnitCounts;
  lastSuccessfulSummaryAt?: string;
  lastError?: MemoryError;
};

type ActiveMemoryInference = {
  agentId: string;
  generation: symbol;
  rate?: MemorySummaryProgress;
};

type MemoryPlacement = Pick<OllamaSettings, 'cpuOnly' | 'mainGpu'>;
type MemoryDeviceOption = MemoryDevice & { unavailable?: string };

const cpuMemoryDevice = { id: 'cpu', label: 'CPU' };
const unknownDevice = 'The selected GPU is unavailable in Ollama.';
const unaddressableDevice = 'Ollama cannot select this GPU by a unique index.';

export type MemoryProcessing = 'legacy-json' | 'deterministic-json' | 'deterministic-markdown';

type MemoryOptions = {
  processing?: MemoryProcessing;
  databasePath: string;
  source: MemorySource;
  summarize(
    unit: MemoryUnit['type'],
    request: ReturnType<typeof prepareMemorySummaries>[number]['prompt'],
    signal: AbortSignal,
    placement: MemoryPlacement,
    onProgress?: (rate: MemorySummaryProgress | undefined) => void,
    format?: MemorySummaryFormat,
  ): Promise<MemorySummaryResult>;
  deviceCatalog?(refresh?: boolean): Promise<OllamaDeviceCatalog>;
  releaseCpuModel?(signal: AbortSignal): Promise<void>;
  threshold?: number;
  budgets?: MemoryBudgets;
  model?: string;
  configuration?: string;
  peers?(agentId: string, workspaceRoot: string): readonly string[];
  onFailure?(): void;
  onDispatch?(data: { agentId: string; elapsedMs: number; estimatedTokens?: number }): void;
  onRequest?(data: {
    agentId: string;
    unitId: string;
    portion: number;
    historyIds: string[];
    authoritativeEstimatedTokens: number;
    prefixHash: string;
    type: MemoryUnit['type'];
    queueMs: number;
    result: MemorySummaryResult;
  }): void;
};

export type MemorySearchEntry = {
  seq: number;
  author: string;
  kind: 'UAMP' | 'AAB' | 'user' | 'original-message' | 'unattributed-prompt';
  text: string;
  sources?: number[];
  summaryId?: string;
  portion?: number;
  field?: string;
  tool?: MemorySourceMessage['tool'];
  userSources?: number[];
  truncated?: true;
};
type SearchEntry = MemorySearchEntry;
type SearchHit = SearchEntry & { agentId: string; epoch: string; score: number };
const searchTokens = 2200;
export const shortDiscussionTokens = 256;
const overviewLimit = 12;

function memorySources(messages: readonly MemorySourceMessage[]) {
  return messages.map(({ seq, turnId, author, messageId, timestamp }) => ({
    seq,
    turnId,
    author,
    messageId,
    timestamp,
  }));
}

export function originalTokenCount(messages: readonly MemorySourceMessage[]) {
  const attachmentIds = new Set<string>();
  const text = messages.map(
    ({ text, attachments }) =>
      text +
      (attachments ?? [])
        .filter(({ id }) => {
          if (attachmentIds.has(id)) return false;
          attachmentIds.add(id);
          return true;
        })
        .map(({ text }) => text)
        .join(''),
  );
  return estimateMemoryTokens(text.join(''));
}

function actionOverview(messages: readonly MemorySourceMessage[]): StoredMemorySummary['action'] {
  const counts = new Map<string, number>();
  const paths = new Map<string, Map<string, number>>();
  const modified = new Set<string>();
  let failureCount = 0;
  for (const { tool } of messages) {
    if (!tool) continue;
    const kind = ['shell', 'edit', 'write', 'read', 'search'].includes(tool.kind)
      ? tool.kind
      : 'other';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (tool.status === 'failed' || tool.status === 'error' || (tool.exitCode ?? 0) !== 0)
      failureCount++;
    if (!tool.filePath) continue;
    const operations = paths.get(tool.filePath) ?? new Map<string, number>();
    operations.set(kind, (operations.get(kind) ?? 0) + 1);
    paths.set(tool.filePath, operations);
    if (tool.status === 'completed' && (kind === 'edit' || kind === 'write'))
      modified.add(tool.filePath);
  }
  const counted = (values: ReadonlyMap<string, number>) =>
    [...values].map(([kind, count]) => ({ kind, count }));
  const checks = observedMemoryChecks(messages);
  return {
    counts: counted(counts),
    files: [...paths].slice(0, overviewLimit).map(([path, operations]) => ({
      path: memoryPreview(path, 128),
      counts: counted(operations),
    })),
    pathCount: paths.size,
    fileCount: modified.size,
    checks: checks.slice(0, overviewLimit),
    checkCount: checks.length,
    failureCount,
  };
}

function relevantDiscussionScope(
  previous: MemoryScope | undefined,
  current: MemoryScope | undefined,
) {
  if (relevantMemoryScope(previous, current)) return true;
  return (
    !!current?.taskId &&
    !!current.sessionId &&
    !previous?.taskId &&
    previous?.sessionId === current.sessionId &&
    (!previous.planId || previous.planId === current.planId) &&
    (!previous.passId || previous.passId === current.passId)
  );
}

type MemoryReference = StoredMemorySummary['sources'][number];

function matchesReference(message: MemorySourceMessage, reference: MemoryReference): boolean {
  return (
    message.seq === reference.seq &&
    message.author === reference.author &&
    message.messageId === reference.messageId &&
    message.turnId === reference.turnId
  );
}

function referenceEntry(
  summary: StoredMemorySummary,
  message: MemorySourceMessage,
  includeText: boolean,
): SearchEntry[] {
  const entry = {
    ...sourceEntry(message),
    kind: summary.type,
    summaryId: summary.id,
    sources: [message.seq],
  };
  return [
    ...(includeText && message.text.trim() ? [entry] : []),
    ...(message.attachments ?? []).map(({ text }) => ({ ...entry, author: 'attachment', text })),
  ];
}

export const memoryDispatchDeadlineMs = 500;

async function beforeReadDeadline<T>(read: () => Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return undefined;
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<undefined>((resolve) => {
        stop = () => resolve(undefined);
        signal.addEventListener('abort', stop, { once: true });
      }),
      read(),
    ]);
  } finally {
    if (stop) signal.removeEventListener('abort', stop);
  }
}

function compareHits(a: SearchHit, b: SearchHit): number {
  return (
    b.score - a.score ||
    Number(b.author === 'tool' || b.author === 'user') -
      Number(a.author === 'tool' || a.author === 'user') ||
    b.seq - a.seq
  );
}

function searchCost({ score: _score, ...entry }: SearchHit): number {
  return estimateMemoryTokens(JSON.stringify(entry) + ',');
}

function unitId({ type, messages }: MemoryUnit): string {
  return [type, messages[0]!.seq, messages.at(-1)!.seq].join(':');
}

function countUnits(types: Iterable<MemoryUnit['type']>): UnitCounts {
  const counts = { uamp: 0, aab: 0 };
  for (const type of types) counts[type === 'UAMP' ? 'uamp' : 'aab']++;
  return counts;
}

function sourceEntry({ seq, text, author, tool }: MemorySourceMessage): SearchEntry {
  const kind =
    author === 'user' ? 'user' : author === 'unknown' ? 'unattributed-prompt' : 'original-message';
  return { seq, text, author, kind, ...(tool ? { tool } : {}) };
}

function summaryEntries(summary: StoredMemorySummary): SearchEntry[] {
  return summary.parts.flatMap((part, index) => {
    const entry = {
      kind: summary.type,
      author: 'summary',
      seq: summary.position,
      summaryId: summary.id,
      portion: index + 1,
      sources: part.sources,
      userSources: summary.sources
        .filter(({ author, seq }) => author === 'user' && part.sources.includes(seq))
        .map(({ seq }) => seq),
    };
    return retrievableSummaryStatements({ type: summary.type, ...part }).map((statement) => ({
      ...entry,
      ...statement,
    }));
  });
}

function uniqueEvidence<T extends SearchEntry>(entries: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.author, entry.text.trim().replace(/\s+/g, ' ')]);
    const existing = seen.get(key);
    if (!existing) seen.set(key, entry);
    // Keep the winning statement's own portion and source references.
  }
  return [...seen.values()];
}

const unavailableHandoff = { text: unavailableMemoryHandoff, entries: [], recoveredSources: [] };
const tentativeProposal =
  /^\s*(?:initial|tentative|early)\s+(?:[^.!?\n]{0,50}\s)?(?:thought|idea|proposal)\b/i;
const questionOnly =
  /^\s*(?:what|why|when|how|where|which|who|did|does|is|are|has|have)\b[^.!?]*\?\s*$/i;

export type MemorySearchStatus = {
  summariesPending: boolean;
  resultsTruncated: boolean;
  originalHistory: OriginalHistoryAvailability;
};

function originalHistoryAvailability(
  histories: readonly OriginalHistoryAvailability[],
): OriginalHistoryAvailability {
  if (histories.every((history) => history === 'available')) return 'available';
  if (histories.every((history) => history === 'unavailable')) return 'unavailable';
  return 'partial';
}

export class SessionMemory {
  private readonly store: MemoryStore;
  private readonly threshold: number;
  private readonly processing: MemoryProcessing;
  private readonly awaitingInference = new Set<string>();
  private readonly budgets: MemoryBudgets;
  private readonly pending = new Map<string, { force: boolean; queuedAt: number }>();
  private readonly foreground = new Set<string>();
  private readonly activeTurns = new Map<string, string>();
  private readonly watchers = new Map<string, () => void>();
  private readonly abort = new AbortController();
  private summarizationAbort = new AbortController();
  private readonly activity = new Map<string, AgentMemoryActivity>();
  private readonly deliveries = new Map<
    string,
    {
      value: DeliveredMemory;
      sourceGeneration: symbol;
      recipientGeneration: symbol;
      order: number;
    }
  >();
  private inference?: ActiveMemoryInference;
  private sendOrder = 0;
  private drain?: Promise<void>;

  constructor(private readonly options: MemoryOptions) {
    this.processing = options.processing ?? 'deterministic-markdown';
    this.threshold = options.threshold ?? 3000;
    this.budgets = options.budgets ?? defaultMemoryBudgets;
    const { input } = this.budgets;
    if (!Number.isInteger(this.threshold) || this.threshold < 1 || this.threshold > 6500)
      throw new Error('Session Memory action threshold must be between 1 and 6500 tokens.');
    if (!Number.isSafeInteger(input) || input < 1024 || input > 14336)
      throw new Error('Session Memory input budget must be between 1024 and 14336 tokens.');
    this.store = new MemoryStore(options.databasePath);
  }

  private async readDeviceCatalog(refresh = false): Promise<OllamaDeviceCatalog> {
    try {
      return (
        (await this.options.deviceCatalog?.(refresh)) ?? {
          devices: [],
          diagnostic: 'Ollama GPU discovery is unavailable.',
        }
      );
    } catch {
      return { devices: [], diagnostic: 'Ollama GPU discovery failed.' };
    }
  }

  async device(deviceId?: string): Promise<{
    device: MemoryDevice;
    devices: MemoryDeviceOption[];
    diagnostic?: string;
  }> {
    const catalog = await this.readDeviceCatalog(deviceId === undefined);
    this.abort.signal.throwIfAborted();
    const devices: MemoryDeviceOption[] = [
      { ...automaticMemoryDevice },
      { ...cpuMemoryDevice },
      ...catalog.devices.map(({ id, label, mainGpu, unavailable }) => ({
        id,
        label,
        unavailable: unavailable ?? (mainGpu === undefined ? unaddressableDevice : undefined),
      })),
    ];
    const current = this.store.deviceSettings();
    if (deviceId === undefined)
      return { device: current.device, devices, diagnostic: catalog.diagnostic };
    const choice = devices.find(({ id }) => id === deviceId);
    if (!choice || choice.unavailable) throw new Error(choice?.unavailable ?? unknownDevice);
    const device = { id: choice.id, label: choice.label };
    this.store.saveDeviceSettings({ ...current, device });
    return { device, devices, diagnostic: catalog.diagnostic };
  }

  setSummarizationEnabled(enabled: boolean): void {
    if (enabled === !this.summarizationAbort.signal.aborted) return;
    if (enabled) {
      this.summarizationAbort = new AbortController();
      this.resumeInference();
    } else {
      this.inference = undefined;
      this.summarizationAbort.abort();
    }
  }

  status(sessionId: string | undefined, agentId: string, epoch?: string): SessionMemoryStatus {
    const recorded = this.activity.get(agentId);
    const mismatched =
      epoch !== undefined && recorded?.epoch !== undefined && recorded.epoch !== epoch;
    const activity = mismatched ? undefined : recorded;
    const inference = this.inference;
    const summarizing =
      inference?.agentId === agentId &&
      inference.generation === activity?.generation &&
      !this.abort.signal.aborted;
    const delivery = sessionId
      ? this.deliveries.get(JSON.stringify([sessionId, agentId]))
      : undefined;
    const lastDelivered =
      delivery &&
      activity?.generation === delivery.recipientGeneration &&
      this.activity.get(delivery.value.sourceAgentId)?.generation === delivery.sourceGeneration
        ? { ...delivery.value }
        : null;
    return {
      device: this.store.deviceSettings().device,
      summarization: this.summarizationAbort.signal.aborted
        ? 'paused'
        : mismatched
          ? 'unknown'
          : summarizing
            ? 'summarizing'
            : this.pending.has(agentId)
              ? 'queued'
              : (activity?.outcome ?? 'unknown'),
      rate: summarizing && inference.rate ? { ...inference.rate } : null,
      lastSuccessfulSummaryAt: activity?.lastSuccessfulSummaryAt ?? null,
      lastError: activity?.lastError ? { ...activity.lastError } : null,
      stored: activity?.stored ? { ...activity.stored } : null,
      lastDelivered,
      currentContext: null,
      pendingUamp: activity?.pending?.uamp ?? null,
      pendingAab: activity?.pending?.aab ?? null,
    };
  }

  async readStoredSummaries(
    agentId: string,
    before?: MemorySummaryCursor,
    {
      includeContent = true,
      passage,
    }: { includeContent?: boolean; passage?: MemorySummaryPassage } = {},
  ) {
    const generation = this.activity.get(agentId)?.generation;
    const tail = await this.options.source.read(agentId, undefined, 'tail');
    this.abort.signal.throwIfAborted();
    const state = this.store.state(agentId);
    if (
      tail.reset ||
      (generation !== undefined && this.activity.get(agentId)?.generation !== generation) ||
      (state?.epoch === tail.epoch && state.seq > tail.latest) ||
      (before && (before.epoch !== tail.epoch || before.position > tail.latest)) ||
      (passage &&
        (passage.epoch !== tail.epoch ||
          !Number.isSafeInteger(passage.start) ||
          !Number.isSafeInteger(passage.position) ||
          passage.start < (tail.earliest ?? 1) ||
          passage.start > passage.position ||
          passage.position > tail.latest))
    ) {
      throw new Error('Conversation history changed. Reopen the stored summaries.');
    }
    const page = this.store.summaryPage(
      agentId,
      tail.epoch,
      tail.latest,
      before,
      includeContent,
      passage,
    );
    return {
      ...page,
      storagePath: this.options.databasePath === ':memory:' ? null : this.options.databasePath,
    };
  }

  async readEvidenceReferences(
    agentId: string,
    { epoch, id, position }: MemorySummaryCursor,
    after = -1,
  ) {
    const generation = this.activity.get(agentId)?.generation;
    const tail = await this.options.source.read(agentId, undefined, 'tail');
    this.abort.signal.throwIfAborted();
    const record = this.store.summary(agentId, epoch, id);
    const state = this.store.state(agentId);
    if (
      tail.reset ||
      tail.epoch !== epoch ||
      generation !== this.activity.get(agentId)?.generation ||
      (state?.epoch === epoch && state.seq > tail.latest) ||
      position > tail.latest ||
      record?.state !== 'recorded' ||
      record.position !== position
    )
      return { sources: [], next: null };
    const sources: (Pick<MemoryReference, 'seq' | 'messageId' | 'turnId'> & {
      author: 'agent' | 'tool';
    })[] = [];
    let next: number | null = null;
    // > A small page limits the original tool output fetched in one expansion.
    for (const { seq, messageId, turnId, author } of record.sources) {
      if (seq <= after || (author !== 'agent' && author !== 'tool')) continue;
      if (sources.length === 8) {
        next = sources.at(-1)!.seq;
        break;
      }
      sources.push({ seq, messageId, turnId, author });
    }
    return { sources, next };
  }

  private async referencedMessages(
    agentId: string,
    epoch: string,
    references: readonly MemoryReference[],
    signal: AbortSignal,
    known: readonly MemorySourceMessage[] = [],
    lookupSignal?: AbortSignal,
    latest?: number,
  ) {
    const found = new Map(known.map((message) => [message.seq, message]));
    const requested = [...new Set(references.map(({ seq }) => seq))].sort((a, b) => b - a);
    for (const seq of requested) {
      signal.throwIfAborted();
      if (found.has(seq)) continue;
      const read = () =>
        this.options.source.read(agentId, { epoch, seq: seq + 1 }, 'before').catch(() => undefined);
      const page = lookupSignal ? await beforeReadDeadline(read, lookupSignal) : await read();
      signal.throwIfAborted();
      if (page && (page.epoch !== epoch || (latest !== undefined && page.latest < latest)))
        return { messages: [], originalHistory: 'unavailable' as const };
      if (!page || page.reset) break;
      for (const message of page.messages) found.set(message.seq, message);
    }
    const messages = references.flatMap((reference) => {
      const message = found.get(reference.seq);
      return message && matchesReference(message, reference) ? [message] : [];
    });
    return {
      messages,
      originalHistory:
        messages.length === references.length ? ('available' as const) : ('partial' as const),
    };
  }

  async recordEntries(
    agentId: string,
    epoch: string,
    summaries: readonly StoredMemorySummary[],
    signal = this.abort.signal,
  ): Promise<MemorySearchEntry[]> {
    return (await this.resolveRecordEntries(agentId, epoch, summaries, signal)).entries;
  }

  private async resolveRecordEntries(
    agentId: string,
    epoch: string,
    summaries: readonly StoredMemorySummary[],
    signal: AbortSignal,
    known: readonly MemorySourceMessage[] = [],
    lookupSignal?: AbortSignal,
    latest?: number,
  ) {
    const references = summaries
      .filter(({ state, complete }) => complete && (state === 'skipped' || state === 'recorded'))
      .flatMap(({ sources, attachmentSources }) => [...sources, ...(attachmentSources ?? [])]);
    const resolved = await this.referencedMessages(
      agentId,
      epoch,
      references,
      signal,
      known,
      lookupSignal,
      latest,
    );
    const bySequence = new Map(resolved.messages.map((message) => [message.seq, message]));
    const entries = summaries.flatMap((summary) => {
      if (!summary.complete) return [];
      if (summary.state !== 'skipped' && summary.state !== 'recorded')
        return summaryEntries(summary);
      const entriesFor = (reference: MemoryReference, includeText: boolean) => {
        const message = bySequence.get(reference.seq);
        return message && matchesReference(message, reference)
          ? referenceEntry(summary, message, includeText)
          : [];
      };
      return [
        ...summary.sources.flatMap((reference) => entriesFor(reference, true)),
        ...(summary.attachmentSources ?? []).flatMap((reference) => entriesFor(reference, false)),
      ];
    });
    return { entries, originalHistory: resolved.originalHistory };
  }

  private agentActivity(agentId: string): AgentMemoryActivity {
    let activity = this.activity.get(agentId);
    if (!activity) {
      activity = { generation: Symbol(), outcome: 'unknown' };
      this.activity.set(agentId, activity);
    }
    return activity;
  }

  private resetActivity(activity: AgentMemoryActivity): void {
    activity.generation = Symbol();
    activity.epoch = undefined;
    activity.latest = undefined;
    activity.outcome = 'unknown';
    activity.stored = undefined;
    activity.pending = undefined;
    activity.lastSuccessfulSummaryAt = undefined;
    activity.lastError = undefined;
  }

  private noteTimeline(agentId: string, page: MemoryPage): void {
    const activity = this.agentActivity(agentId);
    if (
      page.reset ||
      (activity.epoch !== undefined && activity.epoch !== page.epoch) ||
      (activity.latest !== undefined && activity.latest > page.latest)
    ) {
      this.resetActivity(activity);
    } else if (activity.latest !== page.latest) {
      activity.pending = undefined;
      if (activity.outcome === 'up-to-date' || activity.outcome === 'below-threshold')
        activity.outcome = 'unknown';
    }
    activity.epoch = page.epoch;
    activity.latest = page.latest;
  }

  private noteStored(
    agentId: string,
    epoch: string,
    seq: number,
    summaries: Iterable<StoredMemorySummary>,
  ): void {
    const activity = this.agentActivity(agentId);
    const types = new Map<string, MemoryUnit['type']>();
    for (const summary of summaries) if (summary.complete) types.set(summary.id, summary.type);
    activity.stored = {
      agentId,
      epoch,
      coveredThrough: seq < 0 ? null : seq,
      ...countUnits(types.values()),
    };
  }

  private noteFailure(agentId: string, message: string): void {
    const activity = this.agentActivity(agentId);
    activity.outcome = 'failed';
    activity.lastError = { at: new Date().toISOString(), message };
  }

  prepareDelivery(
    sessionId: string,
    recipientAgentId: string,
    payload: MemoryHandoffObservation,
  ): () => void {
    const recipient = this.agentActivity(recipientAgentId);
    const recipientGeneration = recipient.generation;
    const recipientEpoch = recipient.epoch ?? null;
    const key = JSON.stringify([sessionId, recipientAgentId]);
    const order = ++this.sendOrder;
    return () => {
      const prior = this.deliveries.get(key);
      if (
        this.abort.signal.aborted ||
        recipient.generation !== recipientGeneration ||
        this.activity.get(payload.sourceAgentId)?.generation !== payload.sourceGeneration ||
        (prior && prior.order >= order)
      )
        return;
      this.deliveries.set(key, {
        value: {
          sessionId,
          recipientAgentId,
          recipientEpoch,
          sourceAgentId: payload.sourceAgentId,
          sourceEpoch: payload.sourceEpoch,
          deliveredAt: new Date().toISOString(),
          bytes: payload.bytes,
          uamp: payload.uamp,
          aab: payload.aab,
        },
        sourceGeneration: payload.sourceGeneration,
        recipientGeneration,
        order,
      });
    };
  }

  foregroundStarted(id: string): void {
    this.foreground.add(id);
  }

  foregroundEnded(id: string): void {
    this.foreground.delete(id);
    this.resumeInference();
  }

  holdForeground(): () => void {
    const id = randomUUID();
    this.foregroundStarted(id);
    return () => this.foregroundEnded(id);
  }

  turn(agentId: string, turn: MemoryTurn, local: boolean): void {
    if (this.abort.signal.aborted) return;
    const prior = this.store.turns(agentId, new Set([turn.turnId])).get(turn.turnId);
    if (prior && prior.outcome !== 'running') return;
    this.store.saveTurn(agentId, {
      ...prior,
      ...turn,
      scope: prior?.scope ?? turn.scope,
      task: prior?.task ?? turn.task,
    });
    const key = JSON.stringify([agentId, turn.turnId]);
    if (turn.outcome === 'running') {
      const previous = this.activeTurns.get(agentId);
      if (previous) this.foreground.delete(previous);
      this.activeTurns.set(agentId, key);
      if (local) this.foregroundStarted(key);
      if (this.options.source.watch && !this.watchers.has(agentId)) {
        this.watchers.set(
          agentId,
          this.options.source.watch(agentId, () => this.observe(agentId)),
        );
      }
    } else {
      const active = this.activeTurns.get(agentId);
      if (active === undefined || active === key) {
        this.watchers.get(agentId)?.();
        this.watchers.delete(agentId);
        this.activeTurns.delete(agentId);
      }
      this.foregroundEnded(key);
    }
    this.observe(agentId);
  }

  scopeChanged(agentId: string, context: Pick<MemoryTurn, 'scope' | 'task'>): void {
    const active = this.activeTurns.get(agentId);
    if (!active || this.abort.signal.aborted) return;
    const [, turnId] = JSON.parse(active) as [string, string];
    const receipt = this.store.turns(agentId, new Set([turnId])).get(turnId);
    if (!receipt || receipt.outcome !== 'running') return;
    const changes = receipt.changes ?? [];
    const previous = changes.at(-1) ?? receipt;
    if (
      scopeKey(previous.scope) === scopeKey(context.scope) &&
      JSON.stringify(previous.task) === JSON.stringify(context.task)
    )
      return;
    this.store.saveTurn(agentId, {
      ...receipt,
      changes: [...changes, { ...context, at: new Date().toISOString() }],
    });
    this.observe(agentId, true);
  }

  agentClosed(agentId: string): void {
    this.watchers.get(agentId)?.();
    this.watchers.delete(agentId);
    const foreground = this.activeTurns.get(agentId);
    this.activeTurns.delete(agentId);
    if (foreground) this.foregroundEnded(foreground);
    this.observe(agentId, true);
  }

  observe(agentId: string, force = false): void {
    if (this.abort.signal.aborted) return;
    const prior = this.pending.get(agentId);
    this.pending.set(agentId, {
      force: !!prior?.force || force,
      queuedAt: prior?.queuedAt ?? performance.now(),
    });
    const activity = this.agentActivity(agentId);
    activity.pending = undefined;
    this.startDrain();
  }

  private resumeInference(): void {
    if (!this.foreground.size && !this.summarizationAbort.signal.aborted) {
      for (const agentId of this.awaitingInference) {
        this.awaitingInference.delete(agentId);
        this.observe(agentId);
      }
    }
    this.startDrain();
  }

  async settled(): Promise<void> {
    while (this.drain) await this.drain;
  }

  private startDrain(): void {
    if (this.drain || !this.pending.size) return;
    const legacy = this.processing === 'legacy-json';
    if (legacy && this.foreground.size) return;
    const signal = legacy
      ? AbortSignal.any([this.abort.signal, this.summarizationAbort.signal])
      : this.abort.signal;
    if (signal.aborted) return;
    this.drain = Promise.resolve().then(async () => {
      try {
        await this.runPending(signal);
      } finally {
        this.drain = undefined;
        this.startDrain();
      }
    });
  }

  finalize(agentId: string): void {
    this.observe(agentId, true);
  }

  recover(agentIds: readonly string[]): void {
    for (const id of agentIds) this.observe(id, this.store.state(id) !== undefined);
  }

  private async runPending(signal: AbortSignal): Promise<void> {
    while (
      this.pending.size &&
      !signal.aborted &&
      (this.processing !== 'legacy-json' || !this.foreground.size)
    ) {
      const [agentId, pending] = this.pending.entries().next().value!;
      this.pending.delete(agentId);
      const activity = this.agentActivity(agentId);
      activity.outcome = 'unknown';
      activity.pending = undefined;
      let retry: boolean;
      try {
        retry = await this.update(agentId, pending.force, pending.queuedAt, signal);
      } catch {
        retry = signal.aborted;
        if (!retry) {
          this.noteFailure(agentId, 'Session Memory update failed.');
          this.options.onFailure?.();
        }
      }
      if (retry && !this.abort.signal.aborted) {
        const next = this.pending.get(agentId);
        this.pending.set(agentId, {
          force: pending.force || !!next?.force,
          queuedAt: pending.queuedAt,
        });
      }
    }
  }

  private async readOutstanding(
    agentId: string,
    state: MemoryState | undefined,
    signal: AbortSignal,
  ) {
    const cursor = state && state.seq >= 0 ? state : undefined;
    let page = await this.options.source.read(agentId, cursor);
    signal.throwIfAborted();
    if (state && (page.epoch !== state.epoch || page.reset || state.seq > page.latest)) {
      const from = page.epoch === state.epoch && !page.reset ? page.latest + 1 : undefined;
      await this.invalidate(agentId, state.epoch, from);
      signal.throwIfAborted();
      page = await this.options.source.read(agentId);
      signal.throwIfAborted();
      state = undefined;
    }
    this.noteTimeline(agentId, page);
    const { epoch, latest } = page;
    let through = state?.seq ?? -1;
    const messages: MemorySourceMessage[] = [];
    while (!page.reset && page.epoch === epoch && page.through > through) {
      messages.push(...page.messages.filter(({ seq }) => seq <= latest));
      through = Math.min(page.through, latest);
      if (through >= latest) break;
      page = await this.options.source.read(agentId, { epoch, seq: through });
      signal.throwIfAborted();
    }
    if (page.reset || page.epoch !== epoch) {
      this.noteTimeline(agentId, page);
      return undefined;
    }
    return { epoch, latest, through, messages, previous: state?.seq ?? -1 };
  }

  private async currentHistory(agentId: string, epoch: string, last: number, signal: AbortSignal) {
    const tail = await this.options.source.read(agentId, undefined, 'tail');
    signal.throwIfAborted();
    if (tail.reset || tail.epoch !== epoch || tail.latest < last) {
      await this.invalidate(
        agentId,
        epoch,
        tail.epoch === epoch && !tail.reset ? tail.latest + 1 : undefined,
      );
      this.noteTimeline(agentId, tail);
      return undefined;
    }
    this.noteTimeline(agentId, tail);
    return tail;
  }

  private async invalidate(agentId: string, epoch: string, from?: number) {
    this.store.invalidate(agentId, epoch, from);
    const activity = this.activity.get(agentId);
    if (activity && (activity.epoch === undefined || activity.epoch === epoch))
      this.resetActivity(activity);
    await this.options.source.invalidateAttachments?.(agentId, epoch, from);
  }

  private async update(
    agentId: string,
    force: boolean,
    queuedAt: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const input = await this.readOutstanding(agentId, this.store.state(agentId), signal);
    signal.throwIfAborted();
    if (!input) return false;
    const { epoch, latest, through, messages, previous } = input;
    const activity = this.agentActivity(agentId);
    if (through <= previous) {
      if (!activity.stored) {
        this.noteStored(agentId, epoch, previous, this.store.summaries(agentId, epoch));
      }
      if (activity.latest === previous && !this.activeTurns.has(agentId)) {
        activity.outcome = 'up-to-date';
        activity.lastError = undefined;
        activity.pending = { uamp: 0, aab: 0 };
      }
      return false;
    }
    if (!(await this.currentHistory(agentId, epoch, latest, signal))) return true;
    signal.throwIfAborted();
    this.store.savePrompts(agentId, epoch, messages);
    const turnIds = new Set(messages.flatMap(({ turnId }) => (turnId ? [turnId] : [])));
    const turns = this.store.turns(agentId, turnIds);
    const outcomes = new Map<string, MemoryTurnOutcome>();
    const lastByTurn = new Map<string, number>();
    for (const message of messages) if (message.turnId) lastByTurn.set(message.turnId, message.seq);
    for (const [id, turn] of turns) {
      if (turn.epoch && turn.epoch !== epoch) continue;
      if (turn.outcome !== 'running') outcomes.set(id, turn.outcome);
      this.store.saveTurn(agentId, { ...turn, epoch, lastSeq: lastByTurn.get(id) });
    }
    for (const message of messages) {
      const turn = message.turnId ? turns.get(message.turnId) : undefined;
      if (!turn || (turn.epoch && turn.epoch !== epoch)) continue;
      const timestamp = message.timestamp;
      const context = timestamp
        ? (turn.changes?.findLast(({ at }) => Date.parse(at) <= Date.parse(timestamp)) ?? turn)
        : turn;
      message.scope ??= context.scope;
      message.task ??= context.task;
    }
    const stored = this.store.summaries(agentId, epoch);
    this.noteStored(agentId, epoch, previous, stored);
    const summaries = new Map(stored.map((summary) => [summary.id, summary]));
    const actions = new Set(
      stored
        .filter(({ type }) => type === 'AAB')
        .flatMap(({ sources }) => sources.map(({ seq }) => seq)),
    );
    const bySequence = new Map(messages.map((item) => [item.seq, item]));
    const units = identifyMemoryUnits(messages, outcomes, this.threshold, force, actions);
    for (const summary of stored) {
      if (summary.complete || summary.position <= previous) continue;
      const sources = summary.sources.flatMap(({ seq }) => {
        const message = bySequence.get(seq);
        return message ? [message] : [];
      });
      if (sources.length !== summary.sources.length) continue;
      if (!units.some((unit) => unitId(unit) === summary.id)) {
        const context = identifyMemoryUnits(messages, outcomes, this.threshold, true).find(
          (unit) => unitId(unit) === summary.id,
        );
        units.push({
          type: summary.type,
          messages: sources,
          scope: summary.scope,
          task: context?.task ?? sources[0]?.task,
          instructions:
            context?.instructions ??
            messages.filter((source) =>
              sources.some(
                (item) =>
                  item.turnId &&
                  item.turnId === source.turnId &&
                  source.seq < item.seq &&
                  isMemoryInstruction(source, item.task),
              ),
            ),
        });
      }
    }
    units.sort((a, b) => a.messages.at(-1)!.seq - b.messages.at(-1)!.seq);
    const pendingUnits = new Map<string, MemoryUnit['type']>();
    for (const unit of units) {
      const id = unitId(unit);
      if (!summaries.get(id)?.complete) pendingUnits.set(id, unit.type);
    }
    const pendingCounts = countUnits(pendingUnits.values());
    const notePending = () => {
      if (through === latest && activity.latest === latest && !this.pending.has(agentId))
        activity.pending = { ...pendingCounts };
    };
    notePending();

    let checkpoint = through;
    const retainCoverage = (unit: MemoryUnit) => {
      checkpoint = Math.min(
        checkpoint,
        unit.messages[0]!.seq - 1,
        ...(unit.instructions ?? []).map(({ seq }) => seq - 1),
      );
    };
    let hasOpenTurn = false;
    let belowThreshold = false;
    const scheduledActions = new Set([
      ...actions,
      ...units
        .filter(({ type }) => type === 'AAB')
        .flatMap(({ messages }) => messages.map(({ seq }) => seq)),
    ]);
    const latestTurn = messages.findLast(({ turnId }) => turnId !== undefined)?.turnId;
    for (const message of messages) {
      const pending =
        message.turnId &&
        message.turnId === latestTurn &&
        !outcomes.has(message.turnId) &&
        (turns.get(message.turnId)?.outcome === 'running' || !force);
      const openAction =
        !force &&
        (message.author === 'tool' ||
          message.intermediate ||
          (message.author === 'agent' &&
            !!message.scope?.taskId &&
            !!message.turnId &&
            outcomes.get(message.turnId) === 'completed' &&
            !units.some(
              ({ type, messages: sources }) => type === 'UAMP' && sources.includes(message),
            ))) &&
        !scheduledActions.has(message.seq);
      hasOpenTurn ||= Boolean(pending);
      belowThreshold ||= Boolean(openAction);
      if (pending || openAction) {
        const start = message.turnId
          ? messages.find(({ turnId }) => turnId === message.turnId)
          : message;
        checkpoint = Math.min(checkpoint, (start?.seq ?? message.seq) - 1);
      }
    }
    const legacy = this.processing === 'legacy-json';
    const format = this.processing === 'deterministic-markdown' ? 'markdown' : 'json';
    let deferred = false;
    this.awaitingInference.delete(agentId);
    const saveFinished = (summary: StoredMemorySummary) => {
      this.store.saveSummary(summary);
      summaries.set(summary.id, summary);
      const count = summary.type === 'UAMP' ? 'uamp' : 'aab';
      const stored = activity.stored;
      if (stored?.epoch === epoch) stored[count]++;
      if (pendingUnits.delete(summary.id)) pendingCounts[count]--;
      notePending();
    };
    for (const unit of units) {
      if (legacy && this.foreground.size) return true;
      const id = unitId(unit);
      const existing = summaries.get(id);
      if (existing?.complete) continue;
      const position = unit.messages.at(-1)!.seq;
      const originalTokens = originalTokenCount(unit.messages);
      const record: StoredMemorySummary = {
        id,
        agentId,
        sessionId: unit.scope?.sessionId ?? agentId,
        epoch,
        position,
        type: unit.type,
        scope: unit.scope,
        sources: memorySources(unit.messages),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        originalTokens,
        historyHash: '',
        parts: [],
        expectedParts: 1,
        complete: false,
      };
      if (!legacy && (unit.type === 'AAB' || originalTokens < shortDiscussionTokens)) {
        if (!(await this.currentHistory(agentId, epoch, latest, signal))) return true;
        if (unit.type === 'AAB') {
          record.state = 'recorded';
          record.action = actionOverview(unit.messages);
          record.observedChecks = observedMemoryChecks(unit.messages);
          record.attachmentSources = memorySources(
            unit.instructions?.filter(({ attachments }) => attachments?.length) ?? [],
          );
        } else {
          record.state = 'skipped';
        }
        record.complete = true;
        saveFinished(record);
        continue;
      }
      if (!legacy && (this.foreground.size || this.summarizationAbort.signal.aborted)) {
        retainCoverage(unit);
        deferred = true;
        if (!existing) {
          if (!(await this.currentHistory(agentId, epoch, latest, signal))) return true;
          this.store.saveSummary({ ...record, state: 'pending' });
        }
        continue;
      }
      const prior = [...summaries.values()]
        .filter(
          (candidate) =>
            candidate.type === 'UAMP' &&
            candidate.complete &&
            candidate.position < position &&
            (legacy ? relevantMemoryScope : relevantDiscussionScope)(candidate.scope, unit.scope) &&
            (candidate.state === 'skipped' ||
              candidate.parts.some(
                ({ content }) =>
                  !isEmptyMemorySummary(content) && memorySummaryText(content).trim(),
              )),
        )
        .sort((a, b) => b.position - a.position);
      const anchor = prior.find(({ state }) => state !== 'skipped');
      let history = anchor
        ? anchor.parts.map((part, index) => ({
            ...part,
            type: anchor.type,
            scope: unit.scope,
            unitId: anchor.id,
            id: `${anchor.id}/${index + 1}`,
          }))
        : [];
      const skipped = [];
      let skippedTokens = 0;
      for (const candidate of prior) {
        if (candidate.state !== 'skipped' || skippedTokens >= 512) break;
        const { messages: originals } = await this.referencedMessages(
          agentId,
          epoch,
          candidate.sources,
          signal,
          messages,
        );
        if (originals.length) skipped.push({ id: candidate.id, messages: originals });
        skippedTokens += Math.max(32, candidate.originalTokens ?? 32);
      }
      if (format === 'markdown' && anchor && skipped.length) {
        // > A short exchange can refer to an earlier proposal. Use that pair's original wording when available.
        const { messages: originals } = await this.referencedMessages(
          agentId,
          epoch,
          anchor.sources,
          signal,
          messages,
        );
        if (originals.length === anchor.sources.length) {
          history = [
            {
              id: anchor.id,
              unitId: anchor.id,
              scope: unit.scope,
              type: 'UAMP',
              content: originalUampDialogue(originals),
              sources: anchor.sources.map(({ seq }) => seq),
              format: undefined,
            },
          ];
        }
      }
      let parts: ReturnType<typeof prepareMemorySummaries>;
      try {
        parts = prepareMemorySummaries(unit, history, this.budgets, { format, skipped });
      } catch (error) {
        if (!(error instanceof MemoryInputBudgetError)) throw error;
        retainCoverage(unit);
        this.noteFailure(agentId, error.message);
        this.options.onFailure?.();
        if (!legacy) {
          if (!(await this.currentHistory(agentId, epoch, latest, signal))) return true;
          this.store.saveSummary({ ...record, state: 'failed' });
        }
        continue;
      }
      const historyHash = createHash('sha256')
        .update(JSON.stringify(parts.map(({ prompt }) => prompt)))
        .digest('hex');
      const reusable =
        existing?.historyHash === historyHash && existing.expectedParts === parts.length
          ? existing
          : undefined;
      const retainedParts = reusable?.parts ?? [];
      const summary: StoredMemorySummary = {
        ...record,
        state: legacy ? undefined : 'pending',
        summaryTokens: retainedParts.reduce(
          (total, { content }) => total + estimateMemoryTokens(memorySummaryText(content)),
          0,
        ),
        // > An older partial summary may have portions with unknown durations.
        durationMs: retainedParts.length ? reusable?.durationMs : 0,
        model: this.options.model,
        configuration: this.options.configuration,
        historyHash,
        parts: retainedParts,
        observedChecks: unit.type === 'AAB' ? observedMemoryChecks(unit.messages) : undefined,
        expectedParts: parts.length,
      };
      const inferenceSignal = legacy
        ? signal
        : AbortSignal.any([signal, this.summarizationAbort.signal]);
      let failure = false;
      if (!legacy && !existing) {
        if (!(await this.currentHistory(agentId, epoch, latest, signal))) return true;
        this.store.saveSummary(summary);
      }
      for (const part of parts.slice(summary.parts.length)) {
        if (this.foreground.size || inferenceSignal.aborted) {
          if (legacy) return true;
          deferred = true;
          break;
        }
        const generation = activity.generation;
        const queueMs = Math.round(performance.now() - queuedAt);
        const started = performance.now();
        const report = (result: MemorySummaryResult) =>
          this.options.onRequest?.({
            agentId,
            type: unit.type,
            unitId: id,
            portion: summary.parts.length + 1,
            queueMs,
            historyIds: part.historyIds,
            authoritativeEstimatedTokens: part.authoritativeEstimatedTokens,
            prefixHash: part.prefixHash,
            result,
          });
        try {
          const { device, cpuRunner } = this.store.deviceSettings();
          let placement: MemoryPlacement = {};
          if (device.id === cpuMemoryDevice.id) {
            placement = { cpuOnly: true };
          } else if (device.id !== automaticMemoryDevice.id) {
            const catalog = await this.readDeviceCatalog();
            inferenceSignal.throwIfAborted();
            if (
              this.store.deviceSettings().device.id !== device.id ||
              activity.generation !== generation
            )
              return true;
            const selected = catalog.devices.find(({ id }) => id === device.id);
            if (selected?.mainGpu === undefined || selected.unavailable) {
              this.noteFailure(
                agentId,
                selected?.unavailable ?? catalog.diagnostic ?? unknownDevice,
              );
              failure = true;
              this.options.onFailure?.();
              break;
            }
            placement = { mainGpu: selected.mainGpu };
          }
          if (!placement.cpuOnly && cpuRunner && this.options.releaseCpuModel) {
            // > Ollama can reuse a CPU-only runner until it is unloaded.
            await this.options.releaseCpuModel(inferenceSignal);
            inferenceSignal.throwIfAborted();
            const current = this.store.deviceSettings();
            this.store.saveDeviceSettings({ ...current, cpuRunner: false });
            if (
              this.foreground.size ||
              current.device.id !== device.id ||
              activity.generation !== generation
            )
              return true;
          }
          if (this.foreground.size) {
            if (legacy) return true;
            deferred = true;
            break;
          }
          inferenceSignal.throwIfAborted();
          if (placement.cpuOnly && !cpuRunner)
            this.store.saveDeviceSettings({ device, cpuRunner: true });
          const inference: ActiveMemoryInference = { agentId, generation };
          this.inference = inference;
          let ollamaFailure: string | undefined;
          const result = await this.options
            .summarize(
              unit.type,
              part.prompt,
              inferenceSignal,
              placement,
              (rate) => {
                if (
                  this.inference === inference &&
                  activity.generation === generation &&
                  !inferenceSignal.aborted
                )
                  inference.rate = rate;
              },
              format,
            )
            .finally(() => {
              this.inference = undefined;
            })
            .catch((error: unknown): MemorySummaryResult => {
              inferenceSignal.throwIfAborted();
              if (error instanceof OllamaSummaryError) ollamaFailure = error.message;
              return {
                type: unit.type,
                text: '',
                complete: false,
                elapsedMs: performance.now() - started,
              };
            });
          inferenceSignal.throwIfAborted();
          report(result);
          if (!result.complete) {
            this.noteFailure(
              agentId,
              ollamaFailure ??
                (result.failure === 'invalid-json'
                  ? 'Ollama returned invalid JSON for a Session Memory summary.'
                  : 'Session Memory returned an incomplete summary.'),
            );
            failure = true;
            this.options.onFailure?.();
            break;
          }
          summary.parts.push({ content: result.content, format, sources: part.sources });
          summary.summaryTokens =
            (summary.summaryTokens ?? 0) + estimateMemoryTokens(memorySummaryText(result.content));
          if (summary.durationMs !== undefined) {
            const durationMs = summary.durationMs + Math.round(result.elapsedMs);
            summary.durationMs =
              result.elapsedMs >= 0 && Number.isSafeInteger(durationMs) ? durationMs : undefined;
          }
          summary.complete = summary.parts.length === parts.length;
          if (!(await this.currentHistory(agentId, epoch, latest, signal))) return true;
          signal.throwIfAborted();
          if (summary.complete) {
            if (!legacy) summary.state = 'summarized';
            activity.lastSuccessfulSummaryAt = new Date().toISOString();
            saveFinished(summary);
          } else {
            this.store.saveSummary(summary);
          }
        } catch (error) {
          this.inference = undefined;
          signal.throwIfAborted();
          if (inferenceSignal.aborted) {
            deferred = true;
            break;
          }
          failure = true;
          this.noteFailure(
            agentId,
            error instanceof OllamaSummaryError
              ? error.message
              : 'Session Memory could not complete the summary.',
          );
          this.options.onFailure?.();
          break;
        }
      }
      if (!summary.complete) {
        if (failure && !legacy) summary.state = 'failed';
        retainCoverage(unit);
        if (!(await this.currentHistory(agentId, epoch, latest, signal))) return true;
        signal.throwIfAborted();
        this.store.saveSummary(summary);
      }
      summaries.set(id, summary);
    }
    const tail = await this.currentHistory(agentId, epoch, latest, signal);
    signal.throwIfAborted();
    if (!tail) return true;
    if (deferred) {
      this.awaitingInference.add(agentId);
      if (!this.foreground.size && !this.summarizationAbort.signal.aborted) return true;
    }
    const seq = Math.max(previous, checkpoint);
    this.store.saveState(agentId, { epoch, seq });
    if (activity.stored?.epoch === epoch) activity.stored.coveredThrough = seq < 0 ? null : seq;
    if (activity.outcome !== 'failed' && !hasOpenTurn && !this.activeTurns.has(agentId)) {
      if (seq === tail.latest) {
        activity.outcome = 'up-to-date';
        activity.lastError = undefined;
      } else if (belowThreshold && through === tail.latest) {
        activity.outcome = 'below-threshold';
      }
    }
    notePending();
    return false;
  }

  private async current(agentId: string) {
    const state = this.store.state(agentId);
    const activity = this.agentActivity(agentId);
    const generation = activity.generation;
    const latest = activity.latest;
    const tail = await this.options.source.read(agentId, undefined, 'tail');
    const summaries = this.store.summaries(agentId, tail.epoch);
    const canRecord =
      activity.generation === generation &&
      (activity.latest === latest ||
        (activity.latest !== undefined &&
          activity.epoch === tail.epoch &&
          tail.latest >= activity.latest));
    if (
      tail.reset ||
      (state && (state.epoch !== tail.epoch || state.seq > tail.latest)) ||
      summaries.some(({ position }) => position > tail.latest)
    ) {
      const sameEpoch = !state || state.epoch === tail.epoch;
      const invalidation = this.invalidate(
        agentId,
        state?.epoch ?? tail.epoch,
        sameEpoch && !tail.reset ? tail.latest + 1 : undefined,
      );
      if (canRecord) this.noteTimeline(agentId, tail);
      const sourceGeneration = canRecord && !tail.reset ? activity.generation : undefined;
      await invalidation;
      this.observe(agentId, true);
      return { tail, summaries: [], state: undefined, sourceGeneration };
    }
    if (canRecord) {
      this.noteTimeline(agentId, tail);
      const seq = Math.max(state?.seq ?? -1, activity.stored?.coveredThrough ?? -1);
      this.noteStored(agentId, tail.epoch, seq, summaries);
    }
    return {
      tail,
      summaries,
      state,
      sourceGeneration: canRecord ? activity.generation : undefined,
    };
  }

  async handoff(
    agentId: string,
    query: string,
    deadline?: AbortSignal,
    observePayload?: (payload: MemoryHandoffObservation) => void,
    scope?: MemoryScope,
  ): Promise<string> {
    const start = performance.now();
    let estimatedTokens: number | undefined;
    try {
      const { text } = await this.handoffDetails(
        agentId,
        query,
        deadline,
        true,
        observePayload,
        scope,
      );
      estimatedTokens = estimateMemoryTokens(text);
      return text;
    } finally {
      this.options.onDispatch?.({ agentId, elapsedMs: performance.now() - start, estimatedTokens });
    }
  }

  async handoffDetails(
    agentId: string,
    query: string,
    deadline?: AbortSignal,
    recoverOriginals = true,
    observePayload?: (payload: MemoryHandoffObservation) => void,
    scope?: MemoryScope,
  ): Promise<{
    text: string;
    entries: MemorySearchEntry[];
    recoveredSources: number[];
    selection?: MemoryHandoffSelection;
  }> {
    const signal = deadline ? AbortSignal.any([deadline, this.abort.signal]) : this.abort.signal;
    // > Leave time to assemble the handoff even when historical page reads lag.
    const lookupSignal = deadline
      ? AbortSignal.any([signal, AbortSignal.timeout(memoryDispatchDeadlineMs - 100)])
      : undefined;
    signal.throwIfAborted();
    const { tail, state, summaries, sourceGeneration } = await this.current(agentId);
    signal.throwIfAborted();
    const sourceActivity = this.agentActivity(agentId);
    if (tail.reset || sourceGeneration === undefined) return unavailableHandoff;
    const prompts = new Map(
      this.store.prompts(agentId, tail.epoch).map((item) => [item.seq, item]),
    );
    const through = state?.seq ?? -1;
    const recent: MemorySourceMessage[] = [];
    let cursor = state && state.seq >= 0 ? state : undefined;
    let originalHistory: OriginalHistoryAvailability = 'available';
    const tailStart = tail.start;
    if (tailStart !== undefined) {
      while (tailStart > Math.max(0, cursor?.seq ?? through) + 1) {
        const page = await this.options.source.read(agentId, cursor).catch(() => undefined);
        signal.throwIfAborted();
        if (!page) {
          originalHistory = 'partial';
          break;
        }
        if (page.reset || page.epoch !== tail.epoch || page.latest < tail.latest) {
          if (sourceActivity.generation === sourceGeneration) this.noteTimeline(agentId, page);
          this.observe(agentId, true);
          return unavailableHandoff;
        }
        if (page.through <= (cursor?.seq ?? through)) {
          originalHistory = 'partial';
          break;
        }
        recent.push(...page.messages.filter(({ seq }) => seq > through && seq < tailStart));
        cursor = { epoch: tail.epoch, seq: page.through };
      }
    }
    recent.push(...tail.messages);
    const scopeBySequence = new Map<number, MemoryScope>();
    for (const summary of summaries) {
      if (!summary.scope) continue;
      for (const { seq } of summary.sources) scopeBySequence.set(seq, summary.scope);
    }
    const turns = this.store.turns(
      agentId,
      new Set(recent.flatMap(({ turnId }) => (turnId ? [turnId] : []))),
    );
    for (const message of recent) {
      const turn = message.turnId ? turns.get(message.turnId) : undefined;
      const timestamp = message.timestamp;
      const context = timestamp
        ? (turn?.changes?.findLast(({ at }) => Date.parse(at) <= Date.parse(timestamp)) ?? turn)
        : turn;
      const currentScope =
        message.scope ?? (turn?.epoch && turn.epoch !== tail.epoch ? undefined : context?.scope);
      if (currentScope) scopeBySequence.set(message.seq, currentScope);
    }
    for (const item of recent)
      if (item.author === 'user')
        prompts.set(item.seq, { seq: item.seq, text: item.text, author: 'user' });
    const identifiers = memoryIdentifiers(query);
    const applies = (
      seq: number,
      text: string,
      decision = false,
      entryScope = scopeBySequence.get(seq),
    ) => {
      if (scope?.taskId && entryScope?.taskId) return scope.taskId === entryScope.taskId;
      return (
        !query ||
        memoryIdentifierMatches(text, identifiers).size > 0 ||
        memoryRelevance(text, query) >= (decision && scope?.taskId ? 2 : 1)
      );
    };
    const userEntries = [...prompts.values()].filter(({ seq, text }) => applies(seq, text));
    const latest = userEntries
      .filter(
        ({ seq, text }) =>
          applies(seq, text, true) && !tentativeProposal.test(text) && !questionOnly.test(text),
      )
      .reduce<SearchEntry | undefined>(
        (current, item) => (!current || item.seq > current.seq ? sourceEntry(item) : current),
        undefined,
      );
    const superseded = new Set(
      userEntries
        .filter(({ seq, text }) => latest && seq < latest.seq && tentativeProposal.test(text))
        .map(({ seq }) => seq),
    );
    const decision = latest
      ? budgetMemoryText([latest], 400, query, (entry) =>
          estimateMemoryTokens(compactHandoffLine(entry)),
        ).selected[0]
      : undefined;
    const users = budgetMemoryText(
      userEntries
        .filter(({ seq }) => seq !== decision?.seq && !superseded.has(seq))
        .sort(
          (a, b) =>
            Number(b.seq > through) - Number(a.seq > through) ||
            memoryRelevance(b.text, query) - memoryRelevance(a.text, query) ||
            b.seq - a.seq,
        ),
      650 - (decision ? estimateMemoryTokens(compactHandoffLine(decision)) : 0),
      query,
      ({ text }) => estimateMemoryTokens(text) + 8,
    );
    const observed = new Map(
      [
        ...summaries.flatMap(({ observedChecks }) => observedChecks ?? []),
        ...observedMemoryChecks(recent),
      ].map((check) => [JSON.stringify([check.seq, check.text]), check]),
    );
    const applicableRecords = summaries.filter(
      ({ complete, scope: recordedScope }) =>
        complete &&
        (!scope?.taskId || !recordedScope?.taskId || recordedScope.taskId === scope.taskId),
    );
    const resolved = await this.resolveRecordEntries(
      agentId,
      tail.epoch,
      applicableRecords,
      signal,
      recent,
      lookupSignal,
      tail.latest,
    );
    if (resolved.originalHistory === 'unavailable') {
      this.observe(agentId, true);
      return unavailableHandoff;
    }
    if (resolved.originalHistory === 'partial') originalHistory = 'partial';
    const recordScopes = new Map(applicableRecords.map(({ id, scope }) => [id, scope]));
    const candidates: SearchEntry[] = [
      ...resolved.entries.filter(
        (entry) =>
          applies(entry.seq, entry.text, false, recordScopes.get(entry.summaryId!)) &&
          !(
            entry.userSources?.length &&
            entry.userSources.every((seq) => superseded.has(seq)) &&
            ['intent', 'decisions', 'disagreements', 'questions'].includes(entry.field ?? '')
          ),
      ),
      ...[...observed.values()]
        .filter(({ seq }) => seq <= through)
        .map(({ seq, text }) => sourceEntry({ seq, text, author: 'tool' })),
      ...recent
        .filter(({ seq, author }) => seq > through && author !== 'runtime' && author !== 'user')
        .map(sourceEntry),
      ...recent.flatMap(({ seq, attachments }): SearchEntry[] =>
        attachments?.length
          ? [
              {
                seq,
                author: 'attachment',
                kind: 'original-message',
                text:
                  'Pasted reference material is available through the original source. Attachments: ' +
                  attachments.length,
              },
            ]
          : [],
      ),
    ].filter(
      ({ seq, author, text, summaryId }) => summaryId || author === 'summary' || applies(seq, text),
    );
    const nativeRecordIds = new Set(
      applicableRecords
        .filter(({ state }) => state === 'recorded' || state === 'skipped')
        .map(({ id }) => id),
    );
    const borrowedSources = new Map<SearchEntry, number>();
    const normalized = (text: string) => text.trim().replace(/\s+/g, ' ');
    const alreadySelectedUsers = new Set([
      ...users.selected.map(({ seq }) => seq),
      ...(decision ? [decision.seq] : []),
    ]);
    const selectEvidence = (identifiers: readonly string[] = []) => {
      const included = new Set(
        [...users.selected, ...(decision ? [decision] : [])].map(({ text }) => normalized(text)),
      );
      const ranked = candidates
        .sort(
          (a, b) =>
            (borrowedSources.get(a) ?? Infinity) - (borrowedSources.get(b) ?? Infinity) ||
            Number(a.author === 'summary') - Number(b.author === 'summary') ||
            memoryRelevance(b.text, query) - memoryRelevance(a.text, query) ||
            b.seq - a.seq,
        )
        .filter(({ seq, author, text }) => {
          const key = normalized(text);
          if (
            included.has(key) ||
            superseded.has(seq) ||
            (author === 'user' && alreadySelectedUsers.has(seq))
          )
            return false;
          included.add(key);
          return true;
        });
      return budgetMemoryText(
        ranked,
        900,
        query,
        (entry) => estimateMemoryTokens(compactHandoffLine(entry) + '\n'),
        identifiers,
      );
    };
    let evidence = selectEvidence();
    if (recoverOriginals && identifiers.length) {
      const search = () =>
        this.searchConversation(agentId, identifiers.join(' '), lookupSignal ?? signal, {
          tail,
          state,
          summaries: [],
          identifiers,
        }).catch(() => undefined);
      const discovered = lookupSignal
        ? await beforeReadDeadline(search, lookupSignal)
        : await search();
      signal.throwIfAborted();
      if (discovered?.stale) {
        this.observe(agentId, true);
        return unavailableHandoff;
      }
      if (!discovered || discovered.status.originalHistory !== 'available')
        originalHistory = 'partial';
      const evidenceKey = ({ seq, author, text }: { seq: number; author: string; text: string }) =>
        JSON.stringify([seq, author, text]);
      const represented = new Map<string, SearchEntry>();
      for (const entry of candidates) {
        const key = evidenceKey(entry);
        const existing = represented.get(key);
        if (!existing || (entry.summaryId && nativeRecordIds.has(entry.summaryId)))
          represented.set(key, entry);
      }
      const selectedUserKeys = new Set(users.selected.map(evidenceKey));
      const originals = discovered?.hits ?? [];
      const firstForIdentifier = new Set(
        identifiers.flatMap((identifier) => {
          const item = originals.find(
            ({ text }) => memoryIdentifierMatches(text, [identifier]).size > 0,
          );
          return item ? [item] : [];
        }),
      );
      for (const { agentId: _agentId, epoch, score: _score, ...entry } of [
        ...firstForIdentifier,
        ...originals.filter((item) => !firstForIdentifier.has(item)),
      ]) {
        const key = evidenceKey(entry);
        if (epoch !== tail.epoch || selectedUserKeys.has(key) || !applies(entry.seq, entry.text))
          continue;
        const existing = represented.get(key);
        if (existing?.summaryId && nativeRecordIds.has(existing.summaryId)) continue;
        const borrowed = existing ?? entry;
        if (!borrowedSources.has(borrowed)) borrowedSources.set(borrowed, borrowedSources.size);
        if (!existing) {
          represented.set(key, entry);
          candidates.push(entry);
        }
      }
      evidence = selectEvidence(identifiers);
    }
    if (sourceActivity.generation !== sourceGeneration || sourceActivity.epoch !== tail.epoch)
      return unavailableHandoff;
    const selectedKeys = new Set(
      [...borrowedSources.keys()].map(({ seq, author }) => JSON.stringify([seq, author])),
    );
    const recoveredSources = [
      ...new Set(
        evidence.selected
          .filter(
            ({ seq, author, text }) =>
              selectedKeys.has(JSON.stringify([seq, author])) &&
              memoryIdentifierMatches(text, identifiers).size > 0,
          )
          .map(({ seq }) => seq),
      ),
    ];
    const selection = {
      agentId,
      epoch: tail.epoch,
      originalHistory,
      evidence: [...users.selected.map(sourceEntry), ...evidence.selected].sort(
        (a, b) => a.seq - b.seq,
      ),
      decision,
    };
    const entries = [...selection.evidence, ...(decision ? [decision] : [])];
    const text = renderMemoryHandoff(selection);
    if (!text) return { text, entries, recoveredSources, selection };
    signal.throwIfAborted();
    if (observePayload) {
      const types = new Map<string, MemoryUnit['type']>();
      for (const { summaryId, kind } of evidence.selected) {
        if (summaryId && (kind === 'UAMP' || kind === 'AAB')) types.set(summaryId, kind);
      }
      observePayload({
        sourceAgentId: agentId,
        sourceEpoch: tail.epoch,
        sourceGeneration,
        bytes: Buffer.byteLength(text),
        ...countUnits(types.values()),
      });
    }
    return { text, entries, recoveredSources, selection };
  }

  private async searchConversation(
    id: string,
    query: string,
    signal: AbortSignal,
    view?: {
      tail: MemoryPage;
      state?: MemoryState;
      summaries: readonly StoredMemorySummary[];
      identifiers?: readonly string[];
    },
  ): Promise<{ hits: SearchHit[]; status: MemorySearchStatus; stale: boolean }> {
    const { state, tail, summaries } = view ?? (await this.current(id));
    const status: MemorySearchStatus = {
      summariesPending: tail.latest >= 0 && (!state || state.seq < tail.latest),
      resultsTruncated: false,
      originalHistory: 'available',
    };
    if (tail.reset)
      return { hits: [], status: { ...status, originalHistory: 'unavailable' }, stale: true };
    let hits: SearchHit[] = [];
    const add = (entry: SearchEntry) => {
      const score = view?.identifiers
        ? memoryIdentifierMatches(entry.text, view.identifiers).size
        : memoryRelevance(entry.text, query);
      if (query && !score) return;
      hits.push({ ...entry, agentId: id, epoch: tail.epoch, score });
    };
    const recordsBySequence = new Map<
      number,
      { record: StoredMemorySummary; reference: MemoryReference; includeText: boolean }[]
    >();
    for (const summary of summaries) {
      if (!summary.complete) continue;
      if (summary.state !== 'recorded' && summary.state !== 'skipped') {
        summaryEntries(summary).forEach(add);
        continue;
      }
      const index = (references: readonly MemoryReference[], includeText: boolean) => {
        for (const reference of references) {
          const records = recordsBySequence.get(reference.seq) ?? [];
          records.push({ record: summary, reference, includeText });
          recordsBySequence.set(reference.seq, records);
        }
      };
      index(summary.sources, true);
      index(summary.attachmentSources ?? [], false);
    }
    let page = tail;
    while (true) {
      signal.throwIfAborted();
      for (const message of page.messages) {
        if (message.author === 'runtime') continue;
        const records = recordsBySequence.get(message.seq) ?? [];
        let includedText = false;
        for (const { record, reference, includeText } of records) {
          if (!matchesReference(message, reference)) continue;
          referenceEntry(record, message, includeText).forEach(add);
          includedText ||= includeText;
        }
        if (includedText) continue;
        if (message.text.trim()) add(sourceEntry(message));
        for (const attachment of message.attachments ?? [])
          add({
            kind: 'original-message',
            author: 'attachment',
            seq: message.seq,
            text: attachment.text,
          });
      }
      const budgeted = budgetMemoryText(
        uniqueEvidence(hits.sort(compareHits)),
        searchTokens,
        query,
        searchCost,
        view?.identifiers,
      );
      hits = budgeted.selected;
      status.resultsTruncated ||= budgeted.incomplete;
      if (page.start === undefined || page.start <= (page.earliest ?? 1)) break;
      const previous = await this.options.source
        .read(id, { epoch: tail.epoch, seq: page.start }, 'before')
        .catch(() => undefined);
      signal.throwIfAborted();
      if (!previous) {
        status.originalHistory = 'partial';
        break;
      }
      if (
        previous.epoch !== tail.epoch ||
        previous.latest < tail.latest ||
        (view && previous.reset)
      )
        return { hits: [], status: { ...status, originalHistory: 'unavailable' }, stale: true };
      if (previous.reset || previous.start === undefined || previous.start >= page.start) {
        status.originalHistory = 'partial';
        break;
      }
      page = previous;
    }
    return { hits, status, stale: false };
  }

  async search(
    agentId: string,
    workspaceRoot: string,
    query = '',
    target?: string,
    signal = this.abort.signal,
    originalsOnly = false,
  ) {
    const peers = new Set([agentId, ...(this.options.peers?.(agentId, workspaceRoot) ?? [])]);
    if (target && !peers.has(target)) throw new Error('Session Memory access denied.');
    const results = await Promise.all(
      [...(target ? [target] : peers)].map(async (id) => {
        try {
          const view = originalsOnly ? { ...(await this.current(id)), summaries: [] } : undefined;
          return await this.searchConversation(id, query.trim(), signal, view);
        } catch {
          signal.throwIfAborted();
          return {
            status: {
              summariesPending: false,
              resultsTruncated: false,
              originalHistory: 'unavailable' as const,
            },
            hits: [],
          };
        }
      }),
    );
    const ranked = results.flatMap(({ hits }) => hits).sort(compareHits);
    const { selected, incomplete } = budgetMemoryText(ranked, searchTokens, query, searchCost);
    const matches = new Map<string, { agentId: string; epoch: string; entries: SearchEntry[] }>();
    for (const { agentId, epoch, score: _score, ...entry } of selected) {
      const match = matches.get(agentId) ?? { agentId, epoch, entries: [] };
      match.entries.push(entry);
      matches.set(agentId, match);
    }
    return {
      status: {
        summariesPending: results.some(({ status }) => status.summariesPending),
        resultsTruncated: incomplete || results.some(({ status }) => status.resultsTruncated),
        originalHistory: originalHistoryAvailability(
          results.map(({ status }) => status.originalHistory),
        ),
      },
      matches: [...matches.values()],
    };
  }

  async sourceMessage(
    agentId: string,
    workspaceRoot: string,
    reference: MemoryCursor & { agentId: string },
  ) {
    if (
      reference.agentId !== agentId &&
      !this.options.peers?.(agentId, workspaceRoot).includes(reference.agentId)
    )
      throw new Error('Session Memory access denied.');
    const page = await this.options.source
      .read(reference.agentId, { epoch: reference.epoch, seq: reference.seq + 1 }, 'before')
      .catch(() => undefined);
    if (!page || page.epoch !== reference.epoch) return { lookup: 'unavailable' as const };
    if (reference.seq > page.latest)
      return { lookup: 'not-found' as const, latestSequence: page.latest };
    if (page.reset) return { lookup: 'unavailable' as const };
    const message = page.messages.find(({ seq }) => seq === reference.seq);
    if (!message || message.author === 'runtime')
      return { lookup: 'not-found' as const, latestSequence: page.latest };
    return {
      lookup: 'found' as const,
      latestSequence: page.latest,
      source: { ...reference, ...message },
    };
  }

  async close(): Promise<void> {
    this.abort.abort();
    this.pending.clear();
    for (const unsubscribe of this.watchers.values()) unsubscribe();
    this.watchers.clear();
    await this.drain;
    this.store.close();
  }
}

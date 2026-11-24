import { createHash, randomUUID } from 'node:crypto';
import {
  budgetMemoryText,
  memoryRelevance,
  estimateMemoryTokens,
  memoryIdentifierMatches,
  memoryIdentifiers,
  missingMemoryIdentifiers,
} from './text.js';
import {
  MemoryStore,
  type MemoryState,
  type MemoryTurn,
  type StoredMemorySummary,
} from './store.js';
import {
  defaultMemoryBudgets,
  MemoryInputBudgetError,
  relevantMemoryScope,
  retrievableSummaryStatements,
  prepareMemorySummaries,
  type MemoryBudgets,
  type MemorySummaryResult,
} from './summarization.js';
import {
  identifyMemoryUnits,
  isMemoryInstruction,
  scopeKey,
  observedMemoryChecks,
  type MemorySourceMessage,
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
  summarization: SummaryOutcome | 'queued' | 'summarizing';
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

type MemoryOptions = {
  databasePath: string;
  source: MemorySource;
  summarize(
    unit: MemoryUnit['type'],
    request: ReturnType<typeof prepareMemorySummaries>[number]['prompt'],
    signal: AbortSignal,
  ): Promise<MemorySummaryResult>;
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
export const memoryDispatchDeadlineMs = 500;

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

function handoffLine(entry: SearchEntry): string {
  return JSON.stringify(entry);
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
    if (part.noUsefulInformation || !part.text.trim()) return [];
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

const incompleteHandoff = 'Supplemental Session Memory. This context is potentially incomplete.';

export class SessionMemory {
  private readonly store: MemoryStore;
  private readonly threshold: number;
  private readonly budgets: MemoryBudgets;
  private readonly pending = new Map<string, { force: boolean; queuedAt: number }>();
  private readonly foreground = new Set<string>();
  private readonly activeTurns = new Map<string, string>();
  private readonly watchers = new Map<string, () => void>();
  private readonly abort = new AbortController();
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
  private inferenceAgentId?: string;
  private sendOrder = 0;
  private drain?: Promise<void>;

  constructor(private readonly options: MemoryOptions) {
    this.threshold = options.threshold ?? 3000;
    this.budgets = options.budgets ?? defaultMemoryBudgets;
    const { input } = this.budgets;
    if (!Number.isInteger(this.threshold) || this.threshold < 1 || this.threshold > 6500)
      throw new Error('Session Memory action threshold must be between 1 and 6500 tokens.');
    if (!Number.isSafeInteger(input) || input < 1024 || input > 14336)
      throw new Error('Session Memory input budget must be between 1024 and 14336 tokens.');
    this.store = new MemoryStore(options.databasePath);
  }

  status(sessionId: string | undefined, agentId: string, epoch?: string): SessionMemoryStatus {
    const recorded = this.activity.get(agentId);
    const mismatched =
      epoch !== undefined && recorded?.epoch !== undefined && recorded.epoch !== epoch;
    const activity = mismatched ? undefined : recorded;
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
      summarization: mismatched
        ? 'unknown'
        : this.inferenceAgentId === agentId
          ? 'summarizing'
          : this.pending.has(agentId)
            ? 'queued'
            : (activity?.outcome ?? 'unknown'),
      lastSuccessfulSummaryAt: activity?.lastSuccessfulSummaryAt ?? null,
      lastError: activity?.lastError ? { ...activity.lastError } : null,
      stored: activity?.stored ? { ...activity.stored } : null,
      lastDelivered,
      currentContext: null,
      pendingUamp: activity?.pending?.uamp ?? null,
      pendingAab: activity?.pending?.aab ?? null,
    };
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
    this.startDrain();
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

  private startDrain(): void {
    if (this.foreground.size || !this.pending.size || this.abort.signal.aborted) return;
    this.drain ??= Promise.resolve().then(async () => {
      try {
        await this.runPending();
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

  private async runPending(): Promise<void> {
    while (this.pending.size && !this.foreground.size && !this.abort.signal.aborted) {
      const [agentId, pending] = this.pending.entries().next().value!;
      this.pending.delete(agentId);
      const activity = this.agentActivity(agentId);
      activity.outcome = 'unknown';
      activity.pending = undefined;
      try {
        if (await this.update(agentId, pending.force, pending.queuedAt)) {
          const next = this.pending.get(agentId);
          this.pending.set(agentId, {
            force: pending.force || !!next?.force,
            queuedAt: pending.queuedAt,
          });
        }
      } catch {
        if (!this.abort.signal.aborted) {
          this.noteFailure(agentId, 'Session Memory update failed.');
          this.options.onFailure?.();
        }
      }
    }
  }

  private async readOutstanding(agentId: string, state?: MemoryState) {
    const cursor = state && state.seq >= 0 ? state : undefined;
    let page = await this.options.source.read(agentId, cursor);
    if (state && (page.epoch !== state.epoch || page.reset || state.seq > page.latest)) {
      const from = page.epoch === state.epoch && !page.reset ? page.latest + 1 : undefined;
      await this.invalidate(agentId, state.epoch, from);
      page = await this.options.source.read(agentId);
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
    }
    if (page.reset || page.epoch !== epoch) {
      this.noteTimeline(agentId, page);
      return undefined;
    }
    return { epoch, latest, through, messages, previous: state?.seq ?? -1 };
  }

  private async currentHistory(agentId: string, epoch: string, last: number) {
    const tail = await this.options.source.read(agentId, undefined, 'tail');
    this.abort.signal.throwIfAborted();
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

  private async update(agentId: string, force: boolean, queuedAt: number): Promise<boolean> {
    const input = await this.readOutstanding(agentId, this.store.state(agentId));
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
    if (!(await this.currentHistory(agentId, epoch, latest))) return true;
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
    for (const unit of units) {
      if (this.foreground.size) return true;
      const id = unitId(unit);
      const existing = summaries.get(id);
      if (existing?.complete) continue;
      const position = unit.messages.at(-1)!.seq;
      let latestUamp: StoredMemorySummary | undefined;
      for (const summary of summaries.values()) {
        if (
          summary.type === 'UAMP' &&
          summary.complete &&
          summary.position < position &&
          (!latestUamp || summary.position > latestUamp.position) &&
          relevantMemoryScope(summary.scope, unit.scope) &&
          summary.parts.some(({ text, noUsefulInformation }) => !noUsefulInformation && text.trim())
        )
          latestUamp = summary;
      }
      const prior = latestUamp;
      const history = prior
        ? prior.parts.map((part, index) => ({
            ...part,
            type: prior.type,
            scope: prior.scope,
            unitId: prior.id,
            id: `${prior.id}/${index + 1}`,
          }))
        : [];
      let parts: ReturnType<typeof prepareMemorySummaries>;
      try {
        parts = prepareMemorySummaries(unit, history, this.budgets);
      } catch (error) {
        if (!(error instanceof MemoryInputBudgetError)) throw error;
        retainCoverage(unit);
        this.noteFailure(agentId, error.message);
        this.options.onFailure?.();
        continue;
      }
      const historyHash = createHash('sha256')
        .update(JSON.stringify(parts.map(({ prompt }) => prompt)))
        .digest('hex');
      const summary: StoredMemorySummary = {
        id,
        agentId,
        sessionId: unit.scope?.sessionId ?? agentId,
        epoch,
        position,
        type: unit.type,
        scope: unit.scope,
        sources: unit.messages.map(({ seq, author, messageId, timestamp }) => ({
          seq,
          author,
          messageId,
          timestamp,
        })),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        model: this.options.model,
        configuration: this.options.configuration,
        historyHash,
        parts:
          existing?.historyHash === historyHash && existing.expectedParts === parts.length
            ? existing.parts
            : [],
        observedChecks: unit.type === 'AAB' ? observedMemoryChecks(unit.messages) : undefined,
        expectedParts: parts.length,
        complete: false,
      };
      for (const part of parts.slice(summary.parts.length)) {
        if (this.foreground.size) return true;
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
          this.inferenceAgentId = agentId;
          const result = await this.options
            .summarize(unit.type, part.prompt, this.abort.signal)
            .finally(() => {
              this.inferenceAgentId = undefined;
            })
            .catch((): MemorySummaryResult => {
              this.abort.signal.throwIfAborted();
              return {
                type: unit.type,
                text: '',
                complete: false,
                elapsedMs: performance.now() - started,
              };
            });
          report(result);
          if (!result.complete || !result.text.trim()) {
            this.noteFailure(agentId, 'Session Memory returned an incomplete summary.');
            this.options.onFailure?.();
            break;
          }
          summary.parts.push({
            text: result.text,
            fields: result.fields,
            sources: part.sources,
            noUsefulInformation: result.noUsefulInformation,
          });
          summary.complete = summary.parts.length === parts.length;
          if (!(await this.currentHistory(agentId, epoch, latest))) return true;
          this.store.saveSummary(summary);
          if (summary.complete) {
            activity.lastSuccessfulSummaryAt = new Date().toISOString();
            const count = unit.type === 'UAMP' ? 'uamp' : 'aab';
            const stored = activity.stored;
            if (stored?.epoch === epoch) stored[count]++;
            if (pendingUnits.delete(id)) pendingCounts[count]--;
            notePending();
          }
        } catch {
          this.inferenceAgentId = undefined;
          this.abort.signal.throwIfAborted();
          this.noteFailure(agentId, 'Session Memory could not complete the summary.');
          this.options.onFailure?.();
          break;
        }
      }
      if (!summary.complete) {
        retainCoverage(unit);
        if (!(await this.currentHistory(agentId, epoch, latest))) return true;
        this.store.saveSummary(summary);
      }
      summaries.set(id, summary);
    }
    const tail = await this.currentHistory(agentId, epoch, latest);
    if (!tail) return true;
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
  ): Promise<string> {
    const start = performance.now();
    let estimatedTokens: number | undefined;
    try {
      const { text } = await this.handoffDetails(agentId, query, deadline, true, observePayload);
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
  ): Promise<{
    text: string;
    entries: MemorySearchEntry[];
    recoveredSources: number[];
  }> {
    const signal = deadline ? AbortSignal.any([deadline, this.abort.signal]) : this.abort.signal;
    signal.throwIfAborted();
    const { tail, state, summaries, sourceGeneration } = await this.current(agentId);
    signal.throwIfAborted();
    const sourceActivity = this.agentActivity(agentId);
    if (tail.reset || sourceGeneration === undefined)
      return { text: incompleteHandoff, entries: [], recoveredSources: [] };
    const prompts = new Map(
      this.store.prompts(agentId, tail.epoch).map((item) => [item.seq, item]),
    );
    const through = state?.seq ?? -1;
    const recent: MemorySourceMessage[] = [];
    let cursor = state && state.seq >= 0 ? state : undefined;
    const tailStart = tail.start;
    if (tailStart !== undefined) {
      while (tailStart > Math.max(0, cursor?.seq ?? through) + 1) {
        const page = await this.options.source.read(agentId, cursor).catch(() => undefined);
        signal.throwIfAborted();
        if (!page) break;
        if (page.reset || page.epoch !== tail.epoch || page.latest < tail.latest) {
          if (sourceActivity.generation === sourceGeneration) this.noteTimeline(agentId, page);
          this.observe(agentId, true);
          return { text: incompleteHandoff, entries: [], recoveredSources: [] };
        }
        if (page.through <= (cursor?.seq ?? through)) break;
        recent.push(...page.messages.filter(({ seq }) => seq > through && seq < tailStart));
        cursor = { epoch: tail.epoch, seq: page.through };
      }
    }
    recent.push(...tail.messages);
    for (const item of recent)
      if (item.author === 'user')
        prompts.set(item.seq, { seq: item.seq, text: item.text, author: 'user' });
    const users = budgetMemoryText(
      [...prompts.values()].sort(
        (a, b) =>
          Number(b.seq > through) - Number(a.seq > through) ||
          memoryRelevance(b.text, query) - memoryRelevance(a.text, query) ||
          b.seq - a.seq,
      ),
      650,
      query,
      ({ text }) => estimateMemoryTokens(text) + 8,
    );
    const observed = new Map(
      [
        ...summaries.flatMap(({ observedChecks }) => observedChecks ?? []),
        ...observedMemoryChecks(recent),
      ].map((check) => [JSON.stringify([check.seq, check.text]), check]),
    );
    const candidates: SearchEntry[] = [
      ...summaries.filter(({ complete }) => complete).flatMap(summaryEntries),
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
    ];
    const borrowedSources = new Map<SearchEntry, number>();
    const selectEvidence = (identifiers: readonly string[] = []) =>
      budgetMemoryText(
        uniqueEvidence(
          candidates.sort(
            (a, b) =>
              (borrowedSources.get(a) ?? Infinity) - (borrowedSources.get(b) ?? Infinity) ||
              memoryRelevance(b.text, query) - memoryRelevance(a.text, query) ||
              b.seq - a.seq,
          ),
        ),
        900,
        query,
        (entry) => estimateMemoryTokens(handoffLine(entry) + '\n'),
        identifiers,
      );
    let evidence = selectEvidence();
    const identifiers = memoryIdentifiers(query);
    let originalSearchIncomplete = false;
    if (recoverOriginals && identifiers.length) {
      const discovered = await this.searchConversation(agentId, identifiers.join(' '), signal, {
        tail,
        state,
        summaries: [],
        identifiers,
      }).catch(() => undefined);
      signal.throwIfAborted();
      if (discovered?.stale) {
        this.observe(agentId, true);
        return { text: incompleteHandoff, entries: [], recoveredSources: [] };
      }
      originalSearchIncomplete = !discovered || discovered.incomplete;
      const evidenceKey = ({ seq, author, text }: { seq: number; author: string; text: string }) =>
        JSON.stringify([seq, author, text]);
      const represented = new Map(candidates.map((entry) => [evidenceKey(entry), entry]));
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
        if (epoch !== tail.epoch || selectedUserKeys.has(key)) continue;
        const existing = represented.get(key);
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
      return { text: incompleteHandoff, entries: [], recoveredSources: [] };
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
    const entries = [...users.selected.map(sourceEntry), ...evidence.selected];
    if (!entries.length) return { text: '', entries, recoveredSources };
    const text = [
      'Supplemental Session Memory. Follow the approved assignment and the latest original user instruction. Resolve decisions against original user messages. Prefer original tool results for observed outcomes.',
      JSON.stringify({
        agentId,
        epoch: tail.epoch,
        potentiallyIncomplete:
          !state ||
          through < tail.latest ||
          users.incomplete ||
          evidence.incomplete ||
          originalSearchIncomplete ||
          missingMemoryIdentifiers(
            query,
            [...users.selected, ...evidence.selected].map(({ text }) => text).join('\n'),
          ).length > 0,
      }),
      'Original user messages in chronological order',
      ...users.selected.sort((a, b) => a.seq - b.seq).map((item) => JSON.stringify(item)),
      'Summaries and recent evidence in chronological order',
      ...evidence.selected.sort((a, b) => a.seq - b.seq).map(handoffLine),
    ].join('\n');
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
    return { text, entries, recoveredSources };
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
  ) {
    const { state, tail, summaries } = view ?? (await this.current(id));
    let incomplete = !state || state.seq < tail.latest || tail.reset;
    let hits: SearchHit[] = [];
    const add = (entry: SearchEntry) => {
      const score = view?.identifiers
        ? memoryIdentifierMatches(entry.text, view.identifiers).size
        : memoryRelevance(entry.text, query);
      if (query && !score) return;
      hits.push({ ...entry, agentId: id, epoch: tail.epoch, score });
    };
    for (const summary of summaries) if (summary.complete) summaryEntries(summary).forEach(add);
    let page = tail;
    while (true) {
      signal.throwIfAborted();
      for (const message of page.messages) {
        if (message.author === 'runtime') continue;
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
      incomplete ||= budgeted.incomplete;
      if (page.start === undefined || page.start <= (page.earliest ?? 1)) break;
      const previous = await this.options.source.read(
        id,
        { epoch: tail.epoch, seq: page.start },
        'before',
      );
      if (
        previous.epoch !== tail.epoch ||
        previous.latest < tail.latest ||
        (view && previous.reset)
      )
        return { hits: [], incomplete: true, stale: true };
      if (previous.reset || previous.start === undefined || previous.start >= page.start) {
        incomplete = true;
        break;
      }
      page = previous;
    }
    return { hits, incomplete, stale: false };
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
          return { incomplete: true, hits: [] };
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
      incomplete: incomplete || results.some(({ incomplete }) => incomplete),
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
    const page = await this.options.source.read(
      reference.agentId,
      { epoch: reference.epoch, seq: reference.seq + 1 },
      'before',
    );
    const message = page.messages.find(({ seq }) => seq === reference.seq);
    if (page.reset || page.epoch !== reference.epoch || !message || message.author === 'runtime')
      return undefined;
    return { ...reference, ...message };
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

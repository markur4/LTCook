import { createHash } from 'node:crypto';
import {
  budgetMemoryText,
  estimateMemoryTokens,
  memoryPreview,
  memoryRelevance,
} from '../paseo-plugin/server/memory-text.js';
import {
  ConversationStore,
  type ActionBatch,
  type ConversationCursor,
  type ConversationReference,
  type MemoryTurn,
} from './conversation-store.js';
import {
  handoffEntryCost,
  renderMemoryHandoff,
  type OriginalHistoryAvailability,
} from './handoff.js';
import {
  identifyMemoryUnits,
  observedMemoryChecks,
  scopeKey,
  type MemoryScope,
  type MemorySourceMessage,
  type MemoryTurnOutcome,
} from './units.js';

export type { ActionBatch, MemoryTurn } from './conversation-store.js';
export type MemoryCursor = ConversationCursor;
export type MemoryPage = {
  epoch: string;
  latest: number;
  start?: number;
  earliest?: number;
  through: number;
  reset: boolean;
  messages: MemorySourceMessage[];
};

export class MemoryHistoryUnavailableError extends Error {
  constructor() {
    super('Conversation history is unavailable.');
  }
}

export interface MemorySource {
  read(
    agentId: string,
    cursor?: MemoryCursor,
    direction?: 'after' | 'tail' | 'before',
  ): Promise<MemoryPage>;
  watch?(agentId: string, notify: () => void): () => void;
  invalidateAttachments?(agentId: string, epoch: string, from?: number): Promise<void>;
}

export type MemorySearchEntry = {
  seq: number;
  author: string;
  kind: 'user' | 'original-message' | 'unattributed-prompt';
  text: string;
  tool?: MemorySourceMessage['tool'];
  truncated?: true;
};

export type MemoryHandoffObservation = {
  bytes: number;
  sourceAgentId: string;
  sourceEpoch: string;
  sourceGeneration: symbol;
  aab: number;
};

type Delivery = Omit<MemoryHandoffObservation, 'sourceGeneration'> & {
  sessionId: string;
  recipientAgentId: string;
  recipientEpoch: string | null;
  deliveredAt: string;
};

type Options = {
  databasePath: string;
  source: MemorySource;
  threshold?: number;
  peers?(agentId: string, workspaceRoot: string): readonly string[];
  onObserved?(agentId: string): void;
  onFailure?(failure: {
    agentId: string;
    category: 'history-unavailable' | 'unexpected-update';
  }): void;
  onDispatch?(data: { agentId: string; elapsedMs: number; estimatedTokens?: number }): void;
};

type History = {
  epoch: string;
  latest: number;
  messages: MemorySourceMessage[];
  availability: OriginalHistoryAvailability;
};

export const memoryDispatchDeadlineMs = 500;
const searchTokens = 2200;

function reference({
  seq,
  turnId,
  author,
  messageId,
  timestamp,
}: MemorySourceMessage): ConversationReference {
  return { seq, turnId, author, messageId, timestamp };
}

function original({ seq, author, text, tool }: MemorySourceMessage): MemorySearchEntry {
  const kind =
    author === 'user' ? 'user' : author === 'unknown' ? 'unattributed-prompt' : 'original-message';
  return { seq, author, text, tool, kind };
}

function originals(message: MemorySourceMessage): MemorySearchEntry[] {
  if (message.author === 'runtime') return [];
  return [
    ...(message.text.trim() ? [original(message)] : []),
    ...(message.attachments ?? []).map(({ text }) => ({
      seq: message.seq,
      author: 'attachment',
      text,
      kind: 'original-message' as const,
    })),
  ];
}

function actionOverview(
  messages: readonly MemorySourceMessage[],
  checks: ActionBatch['checks'],
): ActionBatch['action'] {
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
  return {
    counts: counted(counts),
    files: [...paths].slice(0, 12).map(([path, operations]) => ({
      path: memoryPreview(path, 128),
      counts: counted(operations),
    })),
    pathCount: paths.size,
    fileCount: modified.size,
    checks: checks.slice(0, 12),
    checkCount: checks.length,
    failureCount,
  };
}

async function untilAbort<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T | undefined> {
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

function scopeMatches(actual?: MemoryScope, expected?: MemoryScope): boolean {
  return (
    (!expected?.sessionId || !actual?.sessionId || actual.sessionId === expected.sessionId) &&
    (!expected?.taskId || !actual?.taskId || actual.taskId === expected.taskId) &&
    (!expected?.passId || !actual?.passId || actual.passId === expected.passId)
  );
}

/** Owns deterministic projections of Paseo history. Inference consumers use their own cursors. */
export class ConversationRecords {
  readonly source: MemorySource;
  private readonly store: ConversationStore;
  private readonly abort = new AbortController();
  private readonly active = new Map<string, string>();
  private readonly watchers = new Map<string, () => void>();
  private readonly pending = new Map<string, boolean>();
  private readonly revisions = new Map<
    string,
    { epoch?: string; latest?: number; generation: symbol }
  >();
  private readonly deliveries = new Map<
    string,
    { value: Delivery; source: symbol; recipient: symbol; order: number }
  >();
  private sendOrder = 0;
  private drain?: Promise<void>;

  constructor(private readonly options: Options) {
    this.source = options.source;
    this.store = new ConversationStore(options.databasePath);
  }

  turn(agentId: string, turn: MemoryTurn, _local?: boolean): void {
    if (this.abort.signal.aborted) return;
    const prior = this.store.turn(agentId, turn.turnId);
    if (prior && prior.outcome !== 'running') return;
    this.store.saveTurn(agentId, {
      ...prior,
      ...turn,
      scope: prior?.scope ?? turn.scope,
      task: prior?.task ?? turn.task,
    });
    if (turn.outcome === 'running') this.active.set(agentId, turn.turnId);
    else if (this.active.get(agentId) === turn.turnId) this.active.delete(agentId);
    this.watch(agentId);
    this.observe(agentId);
  }

  scopeChanged(agentId: string, context: Pick<MemoryTurn, 'scope' | 'task'>): void {
    const turnId = this.active.get(agentId);
    if (this.abort.signal.aborted || !turnId) return;
    const receipt = this.store.turn(agentId, turnId);
    if (receipt?.outcome !== 'running') return;
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

  async recover(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      if (this.abort.signal.aborted) return;
      if (!this.store.cursor(id) && !this.revisions.has(id)) {
        // > Start existing chats at their current tail when the fresh store has no receipts.
        const tail = await this.source.read(id, undefined, 'tail').catch(() => undefined);
        if (this.abort.signal.aborted) return;
        if (!tail || tail.reset) continue;
        if (!this.store.cursor(id) && !this.revisions.has(id))
          this.store.save(id, { epoch: tail.epoch, seq: tail.latest, latest: tail.latest }, [], []);
      }
      this.watch(id);
      this.observe(id, true);
    }
  }

  finalize(agentId: string): Promise<void> {
    this.observe(agentId, true);
    return this.settled();
  }

  agentClosed(agentId: string): void {
    this.watchers.get(agentId)?.();
    this.watchers.delete(agentId);
    this.active.delete(agentId);
    this.observe(agentId, true);
  }

  private watch(id: string): void {
    if (!this.abort.signal.aborted && !this.watchers.has(id) && this.source.watch)
      this.watchers.set(
        id,
        this.source.watch(id, () => this.observe(id)),
      );
  }

  observe(id: string, force = false): void {
    if (this.abort.signal.aborted) return;
    this.revision(id);
    this.pending.set(id, force || !!this.pending.get(id));
    this.options.onObserved?.(id);
    this.startDrain();
  }

  private startDrain(): void {
    if (this.drain || !this.pending.size || this.abort.signal.aborted) return;
    this.drain = Promise.resolve()
      .then(async () => {
        while (!this.abort.signal.aborted && this.pending.size) {
          const [agentId, flush] = this.pending.entries().next().value!;
          this.pending.delete(agentId);
          try {
            await this.update(agentId, flush);
          } catch (error) {
            if (!this.abort.signal.aborted)
              this.options.onFailure?.({
                agentId,
                category:
                  error instanceof MemoryHistoryUnavailableError
                    ? 'history-unavailable'
                    : 'unexpected-update',
              });
          }
        }
      })
      .finally(() => {
        this.drain = undefined;
        this.startDrain();
      });
  }

  async settled(): Promise<void> {
    while (this.drain) await this.drain;
  }

  private revision(id: string): { epoch?: string; latest?: number; generation: symbol } {
    const prior = this.revisions.get(id);
    if (prior) return prior;
    const next = { generation: Symbol() };
    this.revisions.set(id, next);
    return next;
  }

  private note(id: string, page: MemoryPage): void {
    const prior = this.revision(id);
    const changed =
      page.reset ||
      (prior.epoch !== undefined && prior.epoch !== page.epoch) ||
      (prior.latest !== undefined && prior.latest > page.latest);
    this.revisions.set(id, {
      epoch: page.epoch,
      latest: page.latest,
      generation: changed ? Symbol() : prior.generation,
    });
  }

  private async invalidate(id: string, old: MemoryCursor, page: MemoryPage): Promise<void> {
    const from = old.epoch === page.epoch && page.latest < old.seq ? page.latest + 1 : undefined;
    this.store.invalidate(id, old.epoch, from);
    this.note(id, page);
    if (old.epoch !== page.epoch) await this.source.invalidateAttachments?.(id, old.epoch);
    else if (from !== undefined) await this.source.invalidateAttachments?.(id, old.epoch, from);
  }

  private annotate(id: string, epoch: string, messages: MemorySourceMessage[]) {
    const receipts = new Map<string, MemoryTurn>();
    for (const message of messages) {
      if (!message.turnId) continue;
      const receipt = receipts.get(message.turnId) ?? this.store.turn(id, message.turnId);
      if (!receipt || (receipt.epoch !== undefined && receipt.epoch !== epoch)) continue;
      receipts.set(message.turnId, {
        ...receipt,
        epoch,
        lastSeq: Math.max(message.seq, receipt.lastSeq ?? -1),
      });
      const timestamp = message.timestamp;
      const context =
        (timestamp &&
          receipt.changes?.findLast(({ at }) => Date.parse(at) <= Date.parse(timestamp))) ||
        receipt;
      message.scope ??= context.scope;
      message.task ??= context.task;
    }
    return receipts;
  }

  private async update(id: string, force: boolean): Promise<void> {
    let state = this.store.cursor(id);
    let page = await this.source.read(id, state && state.seq >= 0 ? state : undefined);
    this.abort.signal.throwIfAborted();
    if (state && (state.epoch !== page.epoch || page.reset || state.latest > page.latest)) {
      await this.invalidate(id, { epoch: state.epoch, seq: state.latest }, page);
      state = undefined;
      page = await this.source.read(id);
    }
    if (page.reset) return;
    this.note(id, page);
    const { epoch, latest } = page;
    const previous = state?.seq ?? -1;
    let through = previous;
    const messages: MemorySourceMessage[] = [];
    while (page.epoch === epoch && !page.reset && page.through > through) {
      messages.push(
        ...page.messages
          .filter(({ seq }) => seq > through && seq <= latest)
          .map((message) => ({ ...message })),
      );
      through = Math.min(page.through, latest);
      if (through >= latest) break;
      page = await this.source.read(id, { epoch, seq: through });
    }
    this.abort.signal.throwIfAborted();
    if (page.reset || page.epoch !== epoch) {
      if (state) await this.invalidate(id, { epoch: state.epoch, seq: state.latest }, page);
      if (page.epoch !== epoch) this.observe(id, force);
      return;
    }
    if (through === previous) return;
    const tail = await this.source.read(id, undefined, 'tail');
    this.abort.signal.throwIfAborted();
    if (tail.reset || tail.epoch !== epoch || tail.latest < latest) {
      await this.invalidate(id, { epoch, seq: latest }, tail);
      if (tail.epoch !== epoch || tail.latest < latest) this.observe(id, force);
      return;
    }
    this.note(id, tail);
    const receipts = this.annotate(id, epoch, messages);
    const outcomes = new Map<string, MemoryTurnOutcome>();
    for (const [turnId, receipt] of receipts)
      if (receipt.outcome !== 'running') outcomes.set(turnId, receipt.outcome);
    const priorBatches = this.store.batches(id, epoch, previous + 1);
    const recorded = new Set(priorBatches.flatMap(({ sources }) => sources.map(({ seq }) => seq)));
    const threshold = this.options.threshold ?? 3000;
    const units = identifyMemoryUnits(messages, outcomes, threshold, force, recorded);
    const batches = units.flatMap((unit): ActionBatch[] => {
      if (unit.type !== 'AAB') return [];
      const sources = unit.messages.map(reference);
      const checks = observedMemoryChecks(unit.messages);
      for (const { seq } of sources) recorded.add(seq);
      return [
        {
          id: createHash('sha256')
            .update(JSON.stringify(sources.map(({ seq }) => seq)))
            .digest('hex'),
          position: sources.at(-1)!.seq,
          scope: unit.scope,
          sources,
          attachmentSources: (unit.instructions ?? [])
            .filter(({ attachments }) => attachments?.length)
            .map(reference),
          checks,
          action: actionOverview(unit.messages, checks),
        },
      ];
    });
    let checkpoint = through;
    const unrecorded = identifyMemoryUnits(messages, outcomes, threshold, true, recorded)
      .filter(({ type }) => type === 'AAB')
      .flatMap(({ messages: sources }) => sources);
    const openTurn = messages.at(-1)?.turnId;
    for (const message of messages)
      if (
        openTurn &&
        message.turnId === openTurn &&
        !outcomes.has(openTurn) &&
        (!force || receipts.get(openTurn)?.outcome === 'running')
      )
        checkpoint = Math.min(checkpoint, message.seq - 1);
    for (const message of unrecorded) {
      const turnStart = message.turnId && messages.find(({ turnId }) => turnId === message.turnId);
      checkpoint = Math.min(checkpoint, (turnStart ? turnStart.seq : message.seq) - 1);
    }
    this.store.save(id, { epoch, seq: checkpoint, latest }, [...receipts.values()], batches);
  }

  async records(agentId: string): Promise<{ epoch: string; batches: ActionBatch[] }> {
    const page = await this.source.read(agentId, undefined, 'tail');
    this.abort.signal.throwIfAborted();
    return {
      epoch: page.epoch,
      batches: page.reset
        ? []
        : this.store.batches(agentId, page.epoch).filter(({ position }) => position <= page.latest),
    };
  }

  private allow(agentId: string, workspaceRoot: string, target: string): void {
    if (target !== agentId && !this.options.peers?.(agentId, workspaceRoot).includes(target))
      throw new Error('Conversation history access denied.');
  }

  async sourceMessage(
    agentId: string,
    workspaceRoot: string,
    source: MemoryCursor & { agentId: string; messageId?: string },
    signal = this.abort.signal,
  ) {
    this.allow(agentId, workspaceRoot, source.agentId);
    const page = await untilAbort(signal, () =>
      this.source.read(source.agentId, { epoch: source.epoch, seq: source.seq + 1 }, 'before'),
    ).catch(() => undefined);
    signal.throwIfAborted();
    if (!page || page.epoch !== source.epoch) return { lookup: 'unavailable' as const };
    if (source.seq > page.latest)
      return { lookup: 'not-found' as const, latestSequence: page.latest };
    if (page.reset) return { lookup: 'unavailable' as const };
    const message = page.messages.find(
      ({ seq, messageId }) =>
        seq === source.seq && (!source.messageId || messageId === source.messageId),
    );
    if (!message || message.author === 'runtime')
      return { lookup: 'not-found' as const, latestSequence: page.latest };
    return {
      lookup: 'found' as const,
      latestSequence: page.latest,
      source: { ...source, ...message },
    };
  }

  private async history(id: string, signal: AbortSignal): Promise<History> {
    const read = (cursor?: MemoryCursor) =>
      untilAbort(signal, () => this.source.read(id, cursor, cursor ? 'before' : 'tail')).catch(
        () => undefined,
      );
    let page = await read();
    if (!page || page.reset)
      return {
        epoch: page?.epoch ?? '',
        latest: page?.latest ?? -1,
        messages: [],
        availability: 'unavailable',
      };
    this.note(id, page);
    const { epoch, latest } = page;
    const messages = new Map(page.messages.map((message) => [message.seq, { ...message }]));
    let availability: OriginalHistoryAvailability = 'available';
    while (page.start !== undefined && page.start > (page.earliest ?? 1)) {
      const before = await read({ epoch, seq: page.start });
      if (before && (before.reset || before.epoch !== epoch || before.latest < latest)) {
        this.note(id, before);
        return { epoch, latest, messages: [], availability: 'unavailable' };
      }
      if (!before || before.start === undefined || before.start >= page.start) {
        availability = 'partial';
        break;
      }
      for (const message of before.messages)
        if (!messages.has(message.seq)) messages.set(message.seq, { ...message });
      page = before;
    }
    return {
      epoch,
      latest,
      messages: [...messages.values()].sort((a, b) => a.seq - b.seq),
      availability,
    };
  }

  async search(
    agentId: string,
    workspaceRoot: string,
    query = '',
    target?: string,
    signal = this.abort.signal,
  ) {
    if (target) this.allow(agentId, workspaceRoot, target);
    const ids = target
      ? [target]
      : [...new Set([agentId, ...(this.options.peers?.(agentId, workspaceRoot) ?? [])])];
    const histories = await Promise.all(ids.map((id) => this.history(id, signal)));
    signal.throwIfAborted();
    const ranked = histories
      .flatMap(({ epoch, messages }, index) =>
        messages.flatMap(originals).map((entry) => ({
          agentId: ids[index]!,
          epoch,
          entry,
          score: memoryRelevance(entry.text, query),
        })),
      )
      .filter(({ score }) => !query || score > 0)
      .sort((a, b) => b.score - a.score || b.entry.seq - a.entry.seq);
    const { selected, incomplete } = budgetMemoryText(
      ranked.map(({ entry, ...context }) => ({ ...entry, ...context })),
      searchTokens,
      query,
      ({ text }) => estimateMemoryTokens(text) + 12,
    );
    const matches = new Map<
      string,
      { agentId: string; epoch: string; entries: MemorySearchEntry[] }
    >();
    for (const { agentId: id, epoch, score: _score, ...entry } of selected) {
      const group = matches.get(id) ?? { agentId: id, epoch, entries: [] };
      group.entries.push(entry);
      matches.set(id, group);
    }
    const originalHistory: OriginalHistoryAvailability = histories.every(
      ({ availability }) => availability === 'unavailable',
    )
      ? 'unavailable'
      : histories.every(({ availability }) => availability === 'available')
        ? 'available'
        : 'partial';
    return {
      status: { resultsTruncated: incomplete, originalHistory },
      matches: [...matches.values()],
    };
  }

  async handoff(
    agentId: string,
    query: string,
    deadline?: AbortSignal,
    observePayload?: (value: MemoryHandoffObservation) => void,
    scope?: MemoryScope,
  ): Promise<string> {
    const start = performance.now();
    let estimatedTokens: number | undefined;
    try {
      const { text } = await this.handoffDetails(agentId, query, deadline, observePayload, scope);
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
    observePayload?: (value: MemoryHandoffObservation) => void,
    scope?: MemoryScope,
  ) {
    const signal = AbortSignal.any([this.abort.signal, ...(deadline ? [deadline] : [])]);
    const history = await this.history(
      agentId,
      AbortSignal.any([signal, AbortSignal.timeout(memoryDispatchDeadlineMs - 100)]),
    );
    signal.throwIfAborted();
    this.annotate(agentId, history.epoch, history.messages);
    const eligible = history.messages.filter(({ scope: actual }) => scopeMatches(actual, scope));
    const relevance = ({ text }: { text: string }) => memoryRelevance(text, query);
    const ranked = eligible.flatMap(originals).filter((entry) => !query || relevance(entry) > 0);
    const relevantSeq = new Set(ranked.map(({ seq }) => seq));
    const exchanges = eligible.filter(({ author }) => author === 'agent' || author === 'user');
    for (const [index, message] of exchanges.entries()) {
      if (!relevantSeq.has(message.seq)) continue;
      // > Include the adjacent original exchange so short referential approvals remain interpretable.
      for (const neighbor of [exchanges[index - 1], exchanges[index + 1]]) {
        if (!neighbor || relevantSeq.has(neighbor.seq) || neighbor.author === message.author)
          continue;
        ranked.push(original(neighbor));
      }
    }
    const candidate = ranked
      .filter(({ author }) => author === 'user')
      .sort((a, b) => b.seq - a.seq)
      .find(
        ({ text }) =>
          !text.trim().endsWith('?') &&
          !/^(?:what if|maybe|could we|should we)\b/i.test(text.trim()),
      );
    const decision = candidate
      ? budgetMemoryText([candidate], 400, query, handoffEntryCost).selected[0]
      : undefined;
    const evidenceByKey = new Map<string, MemorySearchEntry>();
    for (const entry of ranked)
      if (entry.seq !== decision?.seq || entry.author !== 'user')
        evidenceByKey.set(JSON.stringify([entry.seq, entry.author, entry.text]), entry);
    const candidates = [...evidenceByKey.values()].sort(
      (a, b) => relevance(b) - relevance(a) || b.seq - a.seq,
    );
    const { selected, incomplete } = budgetMemoryText(candidates, 1500, query, handoffEntryCost);
    const evidence = selected.sort((a, b) => a.seq - b.seq);
    const selection = {
      agentId,
      epoch: history.epoch,
      originalHistory: history.availability,
      contextIncomplete: incomplete,
      evidence,
      decision,
    };
    const text = renderMemoryHandoff(selection);
    if (text && history.availability !== 'unavailable') {
      const batchSources = new Set(evidence.map(({ seq }) => seq));
      const aab = this.store
        .batches(agentId, history.epoch)
        .filter(({ sources }) => sources.some(({ seq }) => batchSources.has(seq))).length;
      observePayload?.({
        bytes: Buffer.byteLength(text),
        sourceAgentId: agentId,
        sourceEpoch: history.epoch,
        sourceGeneration: this.revision(agentId).generation,
        aab,
      });
    }
    return { text, entries: [...evidence, ...(decision ? [decision] : [])], selection };
  }

  prepareDelivery(
    sessionId: string,
    recipientAgentId: string,
    payload: MemoryHandoffObservation,
  ): () => void {
    const recipient = this.revision(recipientAgentId);
    const key = JSON.stringify([sessionId, recipientAgentId]);
    const order = ++this.sendOrder;
    return () => {
      if (
        this.abort.signal.aborted ||
        this.revision(recipientAgentId).generation !== recipient.generation ||
        this.revision(payload.sourceAgentId).generation !== payload.sourceGeneration ||
        (this.deliveries.get(key)?.order ?? 0) >= order
      )
        return;
      const { sourceGeneration, ...value } = payload;
      this.deliveries.set(key, {
        order,
        source: sourceGeneration,
        recipient: recipient.generation,
        value: {
          ...value,
          sessionId,
          recipientAgentId,
          recipientEpoch: recipient.epoch ?? null,
          deliveredAt: new Date().toISOString(),
        },
      });
    };
  }

  lastDelivered(sessionId: string, agentId: string): Delivery | undefined {
    const delivery = this.deliveries.get(JSON.stringify([sessionId, agentId]));
    if (
      delivery &&
      this.revision(agentId).generation === delivery.recipient &&
      this.revision(delivery.value.sourceAgentId).generation === delivery.source
    )
      return delivery.value;
  }

  async close(): Promise<void> {
    this.abort.abort();
    this.pending.clear();
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
    await this.settled();
    this.store.close();
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { budgetMemoryText, memoryRelevance, estimateMemoryTokens } from './text.js';
import {
  MemoryStore,
  type MemoryState,
  type MemoryTurn,
  type StoredMemorySummary,
} from './store.js';
import {
  defaultMemoryBudgets,
  memoryHistory,
  prepareMemorySummaries,
  type MemoryBudgets,
  type MemorySummaryResult,
} from './summarization.js';
import {
  identifyMemoryUnits,
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
  onRequest?(data: {
    type: MemoryUnit['type'];
    queueMs: number;
    result: MemorySummaryResult;
  }): void;
};

type SearchEntry = {
  seq: number;
  author: string;
  kind: 'UAMP' | 'AAB' | 'user' | 'original-message' | 'unattributed-prompt';
  text: string;
  sources?: number[];
  userSources?: number[];
  truncated?: true;
};
type SearchHit = SearchEntry & { agentId: string; epoch: string; score: number };
const searchTokens = 2200;

function compareHits(a: SearchHit, b: SearchHit): number {
  return b.score - a.score || b.seq - a.seq;
}

function searchCost({ score: _score, ...entry }: SearchHit): number {
  return estimateMemoryTokens(JSON.stringify(entry) + ',');
}

function unitId({ type, messages }: MemoryUnit): string {
  return [type, messages[0]!.seq, messages.at(-1)!.seq].join(':');
}

function summaryText(summary: StoredMemorySummary): string {
  return summary.parts.map(({ text }) => text).join('\n');
}

function sourceEntry({ seq, text, author }: MemorySourceMessage): SearchEntry {
  const kind =
    author === 'user' ? 'user' : author === 'unknown' ? 'unattributed-prompt' : 'original-message';
  return { seq, text, author, kind };
}

function summaryEntry(summary: StoredMemorySummary): SearchEntry {
  return {
    kind: summary.type,
    author: 'summary',
    seq: summary.position,
    text: summaryText(summary),
    sources: summary.sources.map(({ seq }) => seq),
    userSources: summary.sources.filter(({ author }) => author === 'user').map(({ seq }) => seq),
  };
}

export class SessionMemory {
  private readonly store: MemoryStore;
  private readonly threshold: number;
  private readonly budgets: MemoryBudgets;
  private readonly pending = new Map<string, { force: boolean; queuedAt: number }>();
  private readonly foreground = new Set<string>();
  private readonly activeTurns = new Map<string, string>();
  private readonly watchers = new Map<string, () => void>();
  private readonly abort = new AbortController();
  private drain?: Promise<void>;

  constructor(private readonly options: MemoryOptions) {
    this.threshold = options.threshold ?? 3000;
    this.budgets = options.budgets ?? defaultMemoryBudgets;
    const { history, retained, input } = this.budgets;
    if (!Number.isInteger(this.threshold) || this.threshold < 1 || this.threshold > 6500)
      throw new Error('Session Memory action threshold must be between 1 and 6500 tokens.');
    if (
      ![history, retained, input].every(Number.isSafeInteger) ||
      retained < 0 ||
      history <= retained ||
      input - history < 1024 ||
      input > 14336
    )
      throw new Error('Session Memory budgets leave insufficient room for bounded sources.');
    this.store = new MemoryStore(options.databasePath);
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
    this.store.saveTurn(agentId, { ...turn, scope: prior?.scope ?? turn.scope });
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
      try {
        if (await this.update(agentId, pending.force, pending.queuedAt)) {
          const next = this.pending.get(agentId);
          this.pending.set(agentId, {
            force: pending.force || !!next?.force,
            queuedAt: pending.queuedAt,
          });
        }
      } catch {
        if (!this.abort.signal.aborted) this.options.onFailure?.();
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
    const { epoch, latest } = page;
    let through = state?.seq ?? -1;
    const messages: MemorySourceMessage[] = [];
    while (!page.reset && page.epoch === epoch && page.through > through) {
      messages.push(...page.messages.filter(({ seq }) => seq <= latest));
      through = Math.min(page.through, latest);
      if (through >= latest) break;
      page = await this.options.source.read(agentId, { epoch, seq: through });
    }
    if (page.reset || page.epoch !== epoch) return undefined;
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
      return false;
    }
    return true;
  }

  private async invalidate(agentId: string, epoch: string, from?: number) {
    this.store.invalidate(agentId, epoch, from);
    await this.options.source.invalidateAttachments?.(agentId, epoch, from);
  }

  private async update(agentId: string, force: boolean, queuedAt: number): Promise<boolean> {
    const input = await this.readOutstanding(agentId, this.store.state(agentId));
    if (!input) return false;
    const { epoch, latest, through, messages, previous } = input;
    if (through <= previous) return false;
    if (!(await this.currentHistory(agentId, epoch, latest))) return true;
    this.store.savePrompts(agentId, epoch, messages);
    const turnIds = new Set(messages.flatMap(({ turnId }) => (turnId ? [turnId] : [])));
    const turns = this.store.turns(agentId, turnIds);
    const outcomes = new Map<string, MemoryTurnOutcome>();
    for (const [id, turn] of turns) if (turn.outcome !== 'running') outcomes.set(id, turn.outcome);
    for (const message of messages) {
      const turn = message.turnId ? turns.get(message.turnId) : undefined;
      message.scope ??= turn?.scope;
    }
    const stored = this.store.summaries(agentId, epoch);
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
        units.push({ type: summary.type, messages: sources, scope: summary.scope });
      }
    }
    units.sort((a, b) => a.messages.at(-1)!.seq - b.messages.at(-1)!.seq);

    let checkpoint = through;
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
        !message.turnId &&
        (message.author === 'tool' || message.intermediate) &&
        !scheduledActions.has(message.seq);
      if (pending || openAction) checkpoint = Math.min(checkpoint, message.seq - 1);
    }
    for (const unit of units) {
      if (this.foreground.size) return true;
      const id = unitId(unit);
      const existing = summaries.get(id);
      if (existing?.complete) continue;
      const position = unit.messages.at(-1)!.seq;
      const earlier = [...summaries.values()]
        .filter((summary) => summary.complete && summary.position < position)
        .sort((a, b) => a.position - b.position);
      const history = memoryHistory(
        earlier.map((summary) => ({ type: summary.type, text: summaryText(summary) })),
        this.budgets,
      );
      const historyHash = createHash('sha256').update(history).digest('hex');
      const parts = prepareMemorySummaries(unit, history, this.budgets);
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
        expectedParts: parts.length,
        complete: false,
      };
      for (const part of parts.slice(summary.parts.length)) {
        if (this.foreground.size) return true;
        const queueMs = Math.round(performance.now() - queuedAt);
        try {
          const result = await this.options.summarize(unit.type, part.prompt, this.abort.signal);
          this.options.onRequest?.({ type: unit.type, queueMs, result });
          if (!result.complete || !result.text.trim()) {
            this.options.onFailure?.();
            break;
          }
          summary.parts.push({ text: result.text, fields: result.fields, sources: part.sources });
          summary.complete = summary.parts.length === parts.length;
          if (!(await this.currentHistory(agentId, epoch, latest))) return true;
          this.store.saveSummary(summary);
        } catch {
          this.abort.signal.throwIfAborted();
          this.options.onFailure?.();
          break;
        }
      }
      if (!summary.complete) {
        checkpoint = Math.min(checkpoint, summary.sources[0]!.seq - 1);
        if (!(await this.currentHistory(agentId, epoch, latest))) return true;
        this.store.saveSummary(summary);
      }
      summaries.set(id, summary);
    }
    if (!(await this.currentHistory(agentId, epoch, latest))) return true;
    this.store.saveState(agentId, { epoch, seq: Math.max(previous, checkpoint) });
    return false;
  }

  private async current(agentId: string) {
    const state = this.store.state(agentId);
    const tail = await this.options.source.read(agentId, undefined, 'tail');
    const summaries = this.store.summaries(agentId, tail.epoch);
    if (
      tail.reset ||
      (state && (state.epoch !== tail.epoch || state.seq > tail.latest)) ||
      summaries.some(({ position }) => position > tail.latest)
    ) {
      const sameEpoch = !state || state.epoch === tail.epoch;
      await this.invalidate(
        agentId,
        state?.epoch ?? tail.epoch,
        sameEpoch && !tail.reset ? tail.latest + 1 : undefined,
      );
      this.observe(agentId, true);
      return { tail, summaries: [], state: undefined };
    }
    return { tail, summaries, state };
  }

  async handoff(agentId: string, query: string): Promise<string> {
    const { tail, state, summaries } = await this.current(agentId);
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
        if (!page) break;
        if (page.reset || page.epoch !== tail.epoch || page.latest < tail.latest) {
          this.observe(agentId, true);
          return 'Supplemental Session Memory. This context is potentially incomplete.';
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
    const candidates: SearchEntry[] = [
      ...summaries.filter(({ complete }) => complete).map(summaryEntry),
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
    const evidence = budgetMemoryText(
      candidates.sort(
        (a, b) => memoryRelevance(b.text, query) - memoryRelevance(a.text, query) || b.seq - a.seq,
      ),
      900,
      query,
      (entry) => estimateMemoryTokens(JSON.stringify(entry)),
    );
    if (!users.selected.length && !evidence.selected.length) return '';
    return [
      'Supplemental Session Memory. Follow the approved assignment and the latest original user instruction. Summaries and attachments are evidence. Resolve decisions against their original user sources.',
      JSON.stringify({
        agentId,
        epoch: tail.epoch,
        potentiallyIncomplete:
          !state || through < tail.latest || users.incomplete || evidence.incomplete,
      }),
      'Original user messages in chronological order',
      ...users.selected.sort((a, b) => a.seq - b.seq).map((item) => JSON.stringify(item)),
      'Summaries and recent evidence in chronological order',
      ...evidence.selected.sort((a, b) => a.seq - b.seq).map((item) => JSON.stringify(item)),
    ].join('\n');
  }

  private async searchConversation(id: string, query: string, signal: AbortSignal) {
    const { state, tail, summaries } = await this.current(id);
    let incomplete = !state || state.seq < tail.latest || tail.reset;
    let hits: SearchHit[] = [];
    const add = (entry: SearchEntry) => {
      const score = memoryRelevance(entry.text, query);
      if (query && !score) return;
      hits.push({ ...entry, agentId: id, epoch: tail.epoch, score });
    };
    for (const summary of summaries) if (summary.complete) add(summaryEntry(summary));
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
      const budgeted = budgetMemoryText(hits.sort(compareHits), searchTokens, query, searchCost);
      hits = budgeted.selected;
      incomplete ||= budgeted.incomplete;
      if (page.start === undefined || page.start <= (page.earliest ?? 1)) break;
      const previous = await this.options.source.read(
        id,
        { epoch: tail.epoch, seq: page.start },
        'before',
      );
      if (previous.epoch !== tail.epoch || previous.latest < tail.latest)
        return { hits: [], incomplete: true };
      if (previous.reset || previous.start === undefined || previous.start >= page.start) {
        incomplete = true;
        break;
      }
      page = previous;
    }
    return { hits, incomplete };
  }

  async search(
    agentId: string,
    workspaceRoot: string,
    query = '',
    target?: string,
    signal = this.abort.signal,
  ) {
    const peers = new Set([agentId, ...(this.options.peers?.(agentId, workspaceRoot) ?? [])]);
    if (target && !peers.has(target)) throw new Error('Session Memory access denied.');
    const results = await Promise.all(
      [...(target ? [target] : peers)].map(async (id) => {
        try {
          return await this.searchConversation(id, query.trim(), signal);
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

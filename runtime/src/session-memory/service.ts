import { chmodSync } from 'node:fs';
import Database from 'libsql';
import {
  estimateMemoryTokens,
  memoryEntriesSchema,
  memoryRelevance,
  renderMemoryHandoff,
  selectMemoryContext,
  type MemoryEntry,
  type MemoryMessage,
} from './extraction.js';

export type MemoryCursor = { epoch: string; seq: number };
export type MemoryPage = {
  epoch: string;
  latest: number;
  start?: number;
  through: number;
  reset: boolean;
  messages: MemoryMessage[];
};

export interface MemorySource {
  read(
    agentId: string,
    cursor?: MemoryCursor,
    direction?: 'after' | 'tail' | 'before',
  ): Promise<MemoryPage>;
}

type MemoryState = { epoch: string; seq: number; entries: MemoryEntry[] };
type MemoryOptions = {
  databasePath: string;
  source: MemorySource;
  extract(
    entries: readonly MemoryEntry[],
    messages: readonly MemoryMessage[],
    signal: AbortSignal,
  ): Promise<MemoryEntry[]>;
  threshold?: number;
  peers?(agentId: string, workspaceRoot: string): readonly string[];
  onFailure?(): void;
};

const maxBatchTokens = 6500;
const maxBatchPages = 8;

export class SessionMemory {
  private readonly database: Database.Database;
  private readonly threshold: number;
  private readonly pending = new Map<string, boolean>();
  private readonly finalizeOnTurn = new Set<string>();
  private readonly abort = new AbortController();
  private drain?: Promise<void>;

  constructor(private readonly options: MemoryOptions) {
    this.threshold = options.threshold ?? 3000;
    if (!Number.isInteger(this.threshold) || this.threshold < 1 || this.threshold > maxBatchTokens)
      throw new Error('Session Memory threshold must be between 1 and 6500 tokens.');
    this.database = new Database(options.databasePath);
    if (options.databasePath !== ':memory:' && process.platform !== 'win32')
      chmodSync(options.databasePath, 0o600);
    this.database.exec(
      'CREATE TABLE IF NOT EXISTS memory (agent_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, seq INTEGER NOT NULL, entries TEXT NOT NULL)',
    );
  }

  observe(agentId: string, force = false): void {
    if (this.abort.signal.aborted) return;
    const finalTurn = this.finalizeOnTurn.delete(agentId);
    this.pending.set(agentId, this.pending.get(agentId) === true || finalTurn || force);
    this.drain ??= Promise.resolve().then(async () => {
      try {
        await this.runPending();
      } finally {
        this.drain = undefined;
      }
    });
  }

  finalize(agentId: string): void {
    this.finalizeOnTurn.add(agentId);
  }

  recover(agentIds: readonly string[]): void {
    if (this.abort.signal.aborted) return;
    for (const id of agentIds) this.observe(id, this.state(id) !== undefined);
  }

  private async runPending(): Promise<void> {
    for (const [agentId, force] of this.pending) {
      if (this.abort.signal.aborted) return;
      this.pending.delete(agentId);
      try {
        if (await this.update(agentId, force)) this.observe(agentId, force);
      } catch {
        if (!this.abort.signal.aborted) this.options.onFailure?.();
      }
    }
  }

  private state(agentId: string): MemoryState | undefined {
    const stored = this.database
      .prepare('SELECT epoch, seq, entries FROM memory WHERE agent_id = ?')
      .get(agentId) as { epoch: string; seq: number; entries: string } | undefined;
    if (stored)
      return { ...stored, entries: memoryEntriesSchema.parse(JSON.parse(stored.entries)) };
  }

  private async update(agentId: string, force: boolean): Promise<boolean> {
    const current = this.state(agentId);
    let page = await this.options.source.read(agentId, current);
    const replaced = current && (page.epoch !== current.epoch || page.reset);
    const prior = replaced ? undefined : current;
    if (replaced) {
      this.database.prepare('DELETE FROM memory WHERE agent_id = ?').run(agentId);
      page = await this.options.source.read(agentId);
    }
    const epoch = page.epoch;
    const head = page.latest;
    const messages: MemoryMessage[] = [];
    let through = prior?.seq ?? -1;
    let tokens = 0;
    for (let i = 0; i < maxBatchPages; i++) {
      if (page.epoch !== epoch || page.reset) return true;
      let overflow = false;
      for (const message of page.messages) {
        if (message.seq > head) break;
        const text =
          message.author === 'runtime'
            ? message.text.split('\n\nSupplemental Session Memory.', 1)[0]!
            : message.text;
        const cost = estimateMemoryTokens(text);
        if (tokens + cost > maxBatchTokens && messages.length) {
          overflow = true;
          break;
        }
        messages.push({ ...message, text });
        tokens += cost;
      }
      through = overflow ? messages.at(-1)!.seq : Math.min(page.through, head);
      if (overflow || through >= head || tokens >= this.threshold) break;
      const next = await this.options.source.read(agentId, { epoch, seq: through });
      if (next.through === page.through && next.epoch === page.epoch) break;
      page = next;
    }
    if (through <= (prior?.seq ?? -1)) return false;
    if (!force && messages.length && tokens < this.threshold && through >= head) return false;
    const entries = messages.some((message) => message.author !== 'runtime')
      ? await this.options.extract(prior?.entries ?? [], messages, this.abort.signal)
      : (prior?.entries ?? []);
    this.abort.signal.throwIfAborted();
    // > Recheck the provider epoch before committing both the delta and checkpoint.
    const latest = await this.options.source.read(agentId, undefined, 'tail');
    this.abort.signal.throwIfAborted();
    if (latest.epoch !== epoch || latest.latest < through) return true;
    this.database
      .prepare(
        'INSERT INTO memory VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET epoch = excluded.epoch, seq = excluded.seq, entries = excluded.entries',
      )
      .run(agentId, epoch, through, JSON.stringify(entries));
    return through < head;
  }

  private async current(agentId: string) {
    const state = this.state(agentId);
    const tail = await this.options.source.read(agentId, undefined, 'tail');
    const valid =
      state && state.epoch === tail.epoch && state.seq <= tail.latest ? state : undefined;
    if (state && !valid) {
      const current = this.state(agentId);
      if (current?.epoch === state.epoch && current.seq === state.seq) {
        this.database.prepare('DELETE FROM memory WHERE agent_id = ?').run(agentId);
      }
      this.observe(agentId, true);
    }
    return { state: valid, tail };
  }

  async handoff(agentId: string, query: string): Promise<string> {
    const { state, tail } = await this.current(agentId);
    const checkpoint = state?.seq ?? -1;
    let messages = tail.messages;
    const tailStart = tail.start;
    if (tailStart !== undefined && tailStart > Math.max(0, checkpoint) + 1) {
      // > A tool-heavy turn can push a recent user correction out of the tail window.
      const page = await this.options.source.read(agentId, state).catch(() => undefined);
      if (page && (page.reset || page.epoch !== tail.epoch)) {
        this.observe(agentId, true);
        return renderMemoryHandoff({ entries: [], recent: [], incomplete: true });
      }
      if (page) {
        messages = [...page.messages.filter(({ seq }) => seq < tailStart), ...messages];
      }
    }
    const recent = messages.filter(
      (message) => message.seq > checkpoint && message.author !== 'runtime',
    );
    const context = selectMemoryContext(
      state?.entries ?? [],
      recent,
      query,
      !state || state.seq < tail.latest,
    );
    return renderMemoryHandoff({ ...context, agentId, epoch: tail.epoch });
  }

  async search(agentId: string, workspaceRoot: string, query = '', target?: string) {
    const peers = new Set([agentId, ...(this.options.peers?.(agentId, workspaceRoot) ?? [])]);
    if (target && !peers.has(target)) throw new Error('Session Memory access denied.');
    const results = await Promise.all(
      [...(target ? [target] : peers)].map(async (id) => {
        try {
          const { state, tail } = await this.current(id);
          const entries = (state?.entries ?? [])
            .map((entry) => ({ entry, score: memoryRelevance(entry.text, query) }))
            .filter(({ score }) => !query || score)
            .sort(
              (a, b) =>
                b.score - a.score || Math.max(...b.entry.sources) - Math.max(...a.entry.sources),
            );
          return {
            incomplete: !state || state.seq < tail.latest || entries.length > 12,
            match: entries.length
              ? {
                  agentId: id,
                  epoch: tail.epoch,
                  entries: entries.slice(0, 12).map(({ entry }) => entry),
                }
              : undefined,
            score: entries[0]?.score ?? 0,
          };
        } catch {
          return { incomplete: true, match: undefined, score: 0 };
        }
      }),
    );
    const matches = results
      .sort((a, b) => b.score - a.score)
      .flatMap(({ match }) => (match ? [match] : []));
    return {
      incomplete: results.some(({ incomplete }) => incomplete) || matches.length > 8,
      matches: matches.slice(0, 8),
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
    if (page.reset || page.epoch !== reference.epoch || !message) return undefined;
    return { ...reference, ...message };
  }

  async close(): Promise<void> {
    this.abort.abort();
    this.pending.clear();
    this.finalizeOnTurn.clear();
    await this.drain;
    this.database.close();
  }
}

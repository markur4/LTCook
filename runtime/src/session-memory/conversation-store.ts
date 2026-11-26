import { chmodSync } from 'node:fs';
import Database from 'libsql';
import type {
  MemoryScope,
  MemorySourceMessage,
  MemoryTaskContext,
  MemoryTurnOutcome,
} from './units.js';

type TurnContext = { scope?: MemoryScope; task?: MemoryTaskContext };

export type MemoryTurn = TurnContext & {
  turnId: string;
  outcome: 'running' | MemoryTurnOutcome;
  changes?: (TurnContext & { at: string })[];
  epoch?: string;
  lastSeq?: number;
};

export type ConversationCursor = { epoch: string; seq: number };
type RecordingCursor = ConversationCursor & { latest: number };

export type ConversationReference = Pick<
  MemorySourceMessage,
  'seq' | 'turnId' | 'messageId' | 'author' | 'timestamp'
>;

export type ActionBatch = {
  id: string;
  position: number;
  scope?: MemoryScope;
  sources: ConversationReference[];
  attachmentSources: ConversationReference[];
  checks: { seq: number; text: string }[];
  action: {
    counts: { kind: string; count: number }[];
    files: { path: string; counts: { kind: string; count: number }[] }[];
    pathCount: number;
    fileCount: number;
    checks: { seq: number; text: string }[];
    checkCount: number;
    failureCount: number;
  };
};

export class ConversationStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_cursor (
          agent TEXT PRIMARY KEY, epoch TEXT NOT NULL, seq INTEGER NOT NULL, latest INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS conversation_turn (
          agent TEXT NOT NULL, turn TEXT NOT NULL, epoch TEXT, last_seq INTEGER,
          receipt TEXT NOT NULL, PRIMARY KEY (agent, turn)
        );
        CREATE TABLE IF NOT EXISTS conversation_aab (
          agent TEXT NOT NULL, epoch TEXT NOT NULL, position INTEGER NOT NULL,
          id TEXT NOT NULL, batch TEXT NOT NULL, PRIMARY KEY (agent, epoch, id)
        );
        CREATE INDEX IF NOT EXISTS conversation_aab_position
          ON conversation_aab(agent, epoch, position);
      `);
      if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  cursor(id: string): RecordingCursor | undefined {
    return (
      (this.db
        .prepare('SELECT epoch, seq, latest FROM conversation_cursor WHERE agent = ?')
        .get(id) as RecordingCursor | undefined) ?? undefined
    );
  }

  turn(id: string, turnId: string): MemoryTurn | undefined {
    const row = this.db
      .prepare('SELECT receipt FROM conversation_turn WHERE agent = ? AND turn = ?')
      .get(id, turnId) as { receipt: string } | undefined;
    return row ? (JSON.parse(row.receipt) as MemoryTurn) : undefined;
  }

  saveTurn(id: string, turn: MemoryTurn): void {
    this.db
      .prepare('INSERT OR REPLACE INTO conversation_turn VALUES (?, ?, ?, ?, ?)')
      .run(id, turn.turnId, turn.epoch ?? null, turn.lastSeq ?? null, JSON.stringify(turn));
  }

  batches(id: string, epoch: string, from = 0): ActionBatch[] {
    const rows = this.db
      .prepare(
        `
      SELECT batch FROM conversation_aab
      WHERE agent = ? AND epoch = ? AND position >= ? ORDER BY position
    `,
      )
      .all(id, epoch, from) as { batch: string }[];
    return rows.map(({ batch }) => JSON.parse(batch) as ActionBatch);
  }

  save(id: string, cursor: RecordingCursor, turns: MemoryTurn[], batches: ActionBatch[]): void {
    this.db.transaction(() => {
      this.db
        .prepare('INSERT OR REPLACE INTO conversation_cursor VALUES (?, ?, ?, ?)')
        .run(id, cursor.epoch, cursor.seq, cursor.latest);
      for (const turn of turns) this.saveTurn(id, turn);
      for (const batch of batches) {
        this.db
          .prepare('INSERT OR IGNORE INTO conversation_aab VALUES (?, ?, ?, ?, ?)')
          .run(id, cursor.epoch, batch.position, batch.id, JSON.stringify(batch));
      }
    })();
  }

  invalidate(id: string, epoch: string, from = 0): void {
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM conversation_aab WHERE agent = ? AND epoch = ? AND position >= ?')
        .run(id, epoch, from);
      this.db
        .prepare(
          'DELETE FROM conversation_turn WHERE agent = ? AND epoch = ? AND (last_seq IS NULL OR last_seq >= ?)',
        )
        .run(id, epoch, from);
      this.db
        .prepare('DELETE FROM conversation_cursor WHERE agent = ? AND epoch = ?')
        .run(id, epoch);
    })();
  }

  close(): void {
    this.db.close();
  }
}

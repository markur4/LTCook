import { chmodSync } from 'node:fs';
import Database from 'libsql';
import { z } from 'zod';
import type { MemorySourceMessage } from './units.js';

const scopeSchema = z.object({
  sessionId: z.string().optional(),
  planId: z.string().optional(),
  passId: z.string().optional(),
  taskId: z.string().optional(),
  stepId: z.string().optional(),
});

const sourceSchema = z.object({
  seq: z.number().int().nonnegative(),
  messageId: z.string().optional(),
  timestamp: z.string().optional(),
  author: z.enum(['user', 'agent', 'tool', 'runtime', 'unknown']),
});

const summaryPartSchema = z.object({
  text: z.string(),
  sources: z.array(z.number().int().nonnegative()),
  noUsefulInformation: z.literal(true).optional(),
  fields: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
});
const tokenCountSchema = z.number().int().nonnegative();
const durationMsSchema = z.number().int().nonnegative();

const summarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  epoch: z.string(),
  type: z.enum(['UAMP', 'AAB']),
  position: z.number().int().nonnegative(),
  sources: z.array(sourceSchema).min(1),
  scope: scopeSchema.optional(),
  createdAt: z.string(),
  originalTokens: tokenCountSchema.optional(),
  summaryTokens: tokenCountSchema.optional(),
  durationMs: durationMsSchema.optional(),
  model: z.string().optional(),
  configuration: z.string().optional(),
  historyHash: z.string(),
  parts: z.array(summaryPartSchema),
  observedChecks: z
    .array(z.object({ seq: z.number().int().nonnegative(), text: z.string() }))
    .optional(),
  expectedParts: z.number().int().positive(),
  complete: z.boolean(),
});
const catalogRowSchema = summarySchema
  .pick({ id: true, type: true, position: true, createdAt: true })
  .extend({
    originalTokens: tokenCountSchema.nullable(),
    summaryTokens: tokenCountSchema.nullable(),
    durationMs: durationMsSchema.nullable(),
    parts: z.string().nullable(),
  });
const catalogPartsSchema = z.array(summaryPartSchema.pick({ text: true, sources: true }));

export type StoredMemorySummary = z.infer<typeof summarySchema>;
export type MemorySummaryCursor = Pick<StoredMemorySummary, 'epoch' | 'position' | 'id'>;
export type MemoryState = { epoch: string; seq: number };

const taskContextSchema = z.object({
  title: z.string(),
  description: z.string(),
  acceptance: z.array(z.string()).readonly(),
  assignment: z.string().optional(),
});
const turnSchema = z.object({
  turnId: z.string(),
  outcome: z.enum(['running', 'completed', 'failed', 'canceled']),
  scope: scopeSchema.optional(),
  task: taskContextSchema.optional(),
  changes: z
    .array(
      z.object({
        at: z.string(),
        scope: scopeSchema.optional(),
        task: taskContextSchema.optional(),
      }),
    )
    .optional(),
  epoch: z.string().optional(),
  lastSeq: z.number().int().optional(),
});
export type MemoryTurn = z.infer<typeof turnSchema>;

export class MemoryStore {
  private readonly database: Database.Database;

  constructor(databasePath: string) {
    this.database = new Database(databasePath);
    if (databasePath !== ':memory:' && process.platform !== 'win32') chmodSync(databasePath, 0o600);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memory_cursor (agent TEXT PRIMARY KEY, epoch TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_turn (agent TEXT NOT NULL, turn TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(agent, turn));
      CREATE TABLE IF NOT EXISTS memory_summary (agent TEXT NOT NULL, epoch TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(agent, epoch, id));
      CREATE INDEX IF NOT EXISTS memory_summary_order ON memory_summary(agent, epoch, position);
      CREATE TABLE IF NOT EXISTS memory_prompt (agent TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(agent, epoch, seq));
      CREATE TABLE IF NOT EXISTS memory_device (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cpu_only INTEGER NOT NULL CHECK (cpu_only IN (0, 1)),
        cpu_runner INTEGER NOT NULL CHECK (cpu_runner IN (0, 1))
      );
    `);
  }

  deviceSettings() {
    const row = this.database.prepare('SELECT cpu_only, cpu_runner FROM memory_device').get() as
      { cpu_only: 0 | 1; cpu_runner: 0 | 1 } | undefined;
    return { cpuOnly: row?.cpu_only === 1, cpuRunner: row?.cpu_runner === 1 };
  }

  saveDeviceSettings({ cpuOnly, cpuRunner }: ReturnType<MemoryStore['deviceSettings']>) {
    this.database
      .prepare(
        'INSERT INTO memory_device VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET cpu_only = excluded.cpu_only, cpu_runner = excluded.cpu_runner',
      )
      .run(Number(cpuOnly), Number(cpuRunner));
  }

  state(agentId: string) {
    return this.database
      .prepare('SELECT epoch, seq FROM memory_cursor WHERE agent = ?')
      .get(agentId) as MemoryState | undefined;
  }

  saveState(agentId: string, state: MemoryState) {
    this.database
      .prepare(
        'INSERT INTO memory_cursor VALUES (?, ?, ?) ON CONFLICT(agent) DO UPDATE SET epoch = excluded.epoch, seq = excluded.seq',
      )
      .run(agentId, state.epoch, state.seq);
  }

  turns(agentId: string, turnIds: ReadonlySet<string>) {
    const select = this.database.prepare(
      'SELECT value FROM memory_turn WHERE agent = ? AND turn = ?',
    );
    return new Map(
      [...turnIds].flatMap((id) => {
        const row = select.get(agentId, id) as { value: string } | undefined;
        return row ? [[id, turnSchema.parse(JSON.parse(row.value))] as const] : [];
      }),
    );
  }

  saveTurn(agentId: string, turn: MemoryTurn) {
    this.database
      .prepare(
        'INSERT INTO memory_turn VALUES (?, ?, ?) ON CONFLICT(agent, turn) DO UPDATE SET value = excluded.value',
      )
      .run(agentId, turn.turnId, JSON.stringify(turn));
  }

  summaries(agentId: string, epoch: string) {
    const rows = this.database
      .prepare(
        'SELECT value FROM memory_summary WHERE agent = ? AND epoch = ? ORDER BY position, id',
      )
      .all(agentId, epoch) as { value: string }[];
    return rows.map(({ value }) => summarySchema.parse(JSON.parse(value)));
  }

  summaryPage(
    agentId: string,
    epoch: string,
    through: number,
    before?: MemorySummaryCursor,
    includeText = true,
  ) {
    const pageSize = 8;
    const rows = this.database
      .prepare(
        `SELECT id, position, json_extract(value, '$.type') AS type,
           json_extract(value, '$.createdAt') AS createdAt,
           json_extract(value, '$.originalTokens') AS originalTokens,
           json_extract(value, '$.summaryTokens') AS summaryTokens,
           json_extract(value, '$.durationMs') AS durationMs,
           ${includeText ? "json_extract(value, '$.parts')" : 'NULL'} AS parts
         FROM memory_summary
         WHERE agent = ? AND epoch = ? AND position <= ?
           AND json_extract(value, '$.complete') = 1
           ${before ? 'AND (position, id) < (?, ?)' : ''}
         ORDER BY position DESC, id DESC LIMIT ?`,
      )
      .all(agentId, epoch, through, ...(before ? [before.position, before.id] : []), pageSize + 1);
    const summaries = rows.slice(0, pageSize).map((row) => {
      const { parts, ...metadata } = catalogRowSchema.parse(row);
      return {
        ...metadata,
        parts: parts === null ? [] : catalogPartsSchema.parse(JSON.parse(parts)),
      };
    });
    const last = summaries.at(-1);
    return {
      summaries,
      next: rows.length > pageSize && last ? { epoch, position: last.position, id: last.id } : null,
    };
  }

  saveSummary(summary: StoredMemorySummary) {
    this.database
      .prepare(
        'INSERT INTO memory_summary VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent, epoch, id) DO UPDATE SET value = excluded.value',
      )
      .run(summary.agentId, summary.epoch, summary.id, summary.position, JSON.stringify(summary));
  }

  prompts(agentId: string, epoch: string) {
    const rows = this.database
      .prepare('SELECT seq, text FROM memory_prompt WHERE agent = ? AND epoch = ? ORDER BY seq')
      .all(agentId, epoch) as { seq: number; text: string }[];
    return rows.map((row) => ({ ...row, author: 'user' as const }));
  }

  savePrompts(agentId: string, epoch: string, messages: readonly MemorySourceMessage[]) {
    const insert = this.database.prepare(
      'INSERT INTO memory_prompt VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
    );
    this.database.transaction(() => {
      for (const { seq, text, author } of messages) {
        if (author === 'user' && text.trim()) insert.run(agentId, epoch, seq, text);
      }
    })();
  }

  invalidate(agentId: string, epoch: string, from?: number) {
    this.database.transaction(() => {
      if (from === undefined) {
        this.database
          .prepare('DELETE FROM memory_summary WHERE agent = ? AND epoch = ?')
          .run(agentId, epoch);
        this.database
          .prepare('DELETE FROM memory_prompt WHERE agent = ? AND epoch = ?')
          .run(agentId, epoch);
      } else {
        this.database
          .prepare('DELETE FROM memory_summary WHERE agent = ? AND epoch = ? AND position >= ?')
          .run(agentId, epoch, from);
        this.database
          .prepare('DELETE FROM memory_prompt WHERE agent = ? AND epoch = ? AND seq >= ?')
          .run(agentId, epoch, from);
      }
      for (const { turn, value } of this.database
        .prepare('SELECT turn, value FROM memory_turn WHERE agent = ?')
        .all(agentId) as { turn: string; value: string }[]) {
        const receipt = turnSchema.parse(JSON.parse(value));
        if (
          receipt.epoch === epoch &&
          (from === undefined || (receipt.lastSeq ?? Infinity) >= from)
        )
          this.database
            .prepare('DELETE FROM memory_turn WHERE agent = ? AND turn = ?')
            .run(agentId, turn);
      }
      this.database
        .prepare('DELETE FROM memory_cursor WHERE agent = ? AND epoch = ?')
        .run(agentId, epoch);
    })();
  }

  close() {
    this.database.close();
  }
}

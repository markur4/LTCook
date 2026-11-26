import type Database from 'libsql';
import type { MemoryCursor } from './conversation.js';

export type TrackerSource = MemoryCursor & {
  messageId?: string;
  author?: 'user' | 'agent';
  timestamp?: string;
  attachmentIds?: string[];
};

export type Evidence = TrackerSource & { digest: string };

export type TrackerStatus =
  'pending' | 'changes' | 'no-change' | 'incomplete' | 'failed' | 'paused';

export type TrackerConfig = {
  id: string;
  name: string;
  instructions: string;
  enabled: boolean;
  version: number;
};

export type Revision = {
  trackerId: string;
  itemId: string;
  text: string | null;
  manual: boolean;
  eventId?: string;
  sources: Evidence[];
  invalidated?: true;
  evidenceUnavailable?: true;
};

export type TrackerEvent = {
  id: string;
  source: Evidence;
  trackers: { trackerId: string; status: TrackerStatus }[];
  invalidated?: true;
};

export type TrackerState = {
  cursor?: MemoryCursor;
  baseline?: number;
  trackers: TrackerConfig[];
  revisions: Revision[];
  events: TrackerEvent[];
};

const defaultTracker: TrackerConfig = {
  id: 'design-decisions',
  name: 'Design Decisions',
  instructions:
    'Keep decisions the user explicitly made or accepted, with their constraints and rationale. Do not treat agent proposals, questions, intentions, silence, or ambiguous acknowledgments as decisions. When the user accepts a proposal by reference, cite both the current user message and the precise original proposal.',
  enabled: true,
  version: 0,
};

export class TrackerStore {
  constructor(private readonly database: Database.Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS tracker_conversation (agent_id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tracker_pause (started INTEGER PRIMARY KEY, ended INTEGER);
    `);
  }

  load(agentId: string): TrackerState {
    const row = this.database
      .prepare('SELECT state FROM tracker_conversation WHERE agent_id = ?')
      .get(agentId) as { state: string } | undefined;
    return row
      ? (JSON.parse(row.state) as TrackerState)
      : {
          trackers: [{ ...defaultTracker }],
          revisions: [],
          events: [],
        };
  }

  save(agentId: string, state: TrackerState): void {
    this.database
      .prepare(
        `
      INSERT INTO tracker_conversation (agent_id, state) VALUES (?, ?)
      ON CONFLICT (agent_id) DO UPDATE SET state = excluded.state
    `,
      )
      .run(agentId, JSON.stringify(state));
  }

  paused(at?: number): boolean {
    if (at === undefined) {
      return Boolean(
        this.database.prepare('SELECT 1 FROM tracker_pause WHERE ended IS NULL').get(),
      );
    }
    return Boolean(
      this.database
        .prepare(
          `
      SELECT 1 FROM tracker_pause WHERE started <= ? AND (ended IS NULL OR ended > ?) LIMIT 1
    `,
        )
        .get(at, at),
    );
  }

  setPaused(paused: boolean): void {
    if (this.paused() === paused) return;
    if (paused)
      this.database
        .prepare('INSERT OR REPLACE INTO tracker_pause (started) VALUES (?)')
        .run(Date.now());
    else
      this.database
        .prepare('UPDATE tracker_pause SET ended = ? WHERE ended IS NULL')
        .run(Date.now());
  }
}

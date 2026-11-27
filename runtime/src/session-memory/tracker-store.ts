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
  'pending' | 'changes' | 'no-change' | 'incomplete' | 'failed' | 'paused' | 'skipped';

export type TrackerGap =
  | { kind: 'budget'; inputDigest: string }
  | { kind: 'configuration' | 'authentication' | 'transient'; revision?: string; detail?: string }
  | { kind: 'source' | 'changed' | 'output' };

export type TrackerConfig = {
  id: string;
  name: string;
  instructions: string;
  enabled: boolean;
  version: number;
  disabledPeriods?: { started: number; ended?: number }[];
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
  trackers: TrackerCoverage[];
  invalidated?: true;
};

export type TrackerCoverage = {
  trackerId: string;
  status: TrackerStatus;
  gap?: TrackerGap;
  replay?: true;
};

export type TrackerState = {
  cursor?: MemoryCursor;
  baseline?: number;
  trackers: TrackerConfig[];
  revisions: Revision[];
  events: TrackerEvent[];
  historyUnavailable?: true;
};

const defaultTracker: TrackerConfig = {
  id: 'design-decisions',
  name: 'Design Decisions',
  instructions: `Keep decisions the user explicitly made or accepted, with their constraints and rationale. Do not treat agent proposals, questions, intentions, silence, or ambiguous acknowledgments as decisions. When the user accepts a proposal by reference, cite both the current user message and the precise original proposal.

## Decision Tracker — Output Style

Apply these rules alongside the existing Decision Tracker instructions. Do not change the rules for identifying, updating, or rejecting decisions.

### Structure

- Create exactly one Tracked Item per decision. Do not include Markdown bullet markers in the stored text.
- Separate decisions when either choice can be revised independently.
- Keep related conditions, reasons, and consequences in the same item.
- When the user explicitly revises an existing decision, update that Tracked Item in place.
- Use additional sentences within an item when they improve clarity.

### Writing Style

Write **concisely, but not tersely**. Prioritize clarity over brevity.

- State the decision directly, then include the context needed to understand it independently.
- Preserve meaningful constraints, exceptions, reasons, and technical details.
- Use complete, natural sentences. Avoid compressed fragments that require interpretation.
- Use established terminology consistently. Prefer specific, familiar words over vague or inflated language.
- Avoid filler, generic benefits, promotional language, mechanical transitions, and unnecessary repetition.
- Vary sentence structure naturally. Do not impose rigid templates or arbitrary length limits.
- Never invent rationale, broaden the scope, or change the certainty of the original decision.
- Remove unnecessary wording, but never remove information needed to understand the decision.

### Few-shot Examples

**1. Preserve conditions and requirements**

Input: "The runtime can start even when credentials are missing, but the affected services must be disabled and explain why."

Tracked Item:

"Allow the runtime to start when credentials are missing. Disable the affected services and report why they were disabled."

**2. Separate independent decisions**

Input: "We'll keep Explorer persistent. Also, let's use one group chat per team session."

Two Tracked Items:

"Keep Explorer persistent."

"Use one group chat per team session."

**3. Distinguish proposals from accepted decisions**

Proposal: "We could keep the previous completed ColGREP index searchable during refresh."

Response A: "Sounds promising."

Result A: No new decision. The proposal has not been accepted.

Response B: "Yes, use that approach."

Result B — one Tracked Item:

"Keep the previous completed ColGREP index searchable during refresh."

Preserve evidence linking the decision to both the proposal and its acceptance.

**4. Update explicitly revised decisions rather than duplicate them**

Existing item:

"Refresh the ColGREP index whenever a search requests it."

New decision: "Actually, indexing should run independently of search requests. Keep the previous completed index searchable until the refreshed index is ready."

Updated item:

"Run ColGREP indexing independently of search requests, keeping the previous completed index searchable until the refreshed index is ready."

The item keeps its identity. The new wording replaces its previous text.`,
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

  conversations(): string[] {
    const rows = this.database.prepare('SELECT agent_id FROM tracker_conversation').all() as {
      agent_id: string;
    }[];
    return rows.map(({ agent_id }) => agent_id);
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

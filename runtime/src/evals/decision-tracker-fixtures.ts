import type { TrackerStatus } from '../session-memory/tracker-store.js';

export type ScriptedTrackerResponse =
  | 'no-change'
  | 'context-rejection'
  | 'invalid-output'
  | { type: 'add'; text: string; sources: number[] }
  | { type: 'update'; targetSource: number; text: string; sources: number[] }
  | { type: 'retire'; targetSource: number; sources: number[] };

export type DecisionTrackerFixture = {
  id: string;
  title: string;
  mode: 'deterministic' | 'live';
  steps: {
    messages?: { seq: number; author: 'user' | 'agent'; text: string }[];
    action?: 'interrupt' | 'reopen' | 'observe' | { recover: 'skip' | 'retry'; seq: number };
    expect?: {
      coverage?: Record<number, TrackerStatus>;
      items?: { alias: string; sources: number[]; textIncludes?: string }[];
      revisions?: number;
      requests?: number;
    };
  }[];
  /** Input-token allowance relative to the production request estimate. */
  budgetOffset?: -1 | 0 | 1;
  seedItems?: string[];
  responses?: Record<number, ScriptedTrackerResponse | { attempts: ScriptedTrackerResponse[] }>;
  expectedDecisions: {
    alias: string;
    kind: 'explicit' | 'indirect';
    sources: number[];
    facts: string[];
  }[];
  /** Evidence that must be present in the request for a trigger sequence. */
  requiredEvidence?: Record<number, number[]>;
  /** Pending work that must progress without a user retry or budget change. */
  eventualProgress?: {
    seq: number;
    status: 'changes' | 'no-change';
    itemAlias?: string;
  };
  /** Makes canonical timeline pagination small enough to test source boundaries. */
  pageSize?: number;
  native?: boolean;
};

const observed = (
  status: TrackerStatus,
  items?: { alias: string; sources: number[]; textIncludes?: string }[],
) => ({
  coverage: { 1: status },
  ...(items ? { items } : {}),
});

const veryLongDecision =
  'Use the EU region for deployment. ' +
  'Current observation: the deployment team still has six endpoints to inspect. '.repeat(900);
const veryLongProposal =
  'I propose using a 30-second retry interval for the worker queue. ' +
  'The retry policy must preserve the active job and retain its diagnostic record. '.repeat(700);
const largeCollection = Array.from({ length: 34 }, (_, index) =>
  `Keep service ${index + 1} assigned to cluster-${index + 1}. Preserve its isolation boundary during maintenance. `.repeat(
    38,
  ),
);

export const decisionTrackerFixtures: DecisionTrackerFixture[] = [
  {
    id: 'budget-oversized-user-message',
    title: 'Oversized user message and later decision progress and persist automatically',
    mode: 'deterministic',
    steps: [
      {
        messages: [
          { seq: 1, author: 'user', text: veryLongDecision },
          { seq: 2, author: 'user', text: 'Keep the audit export available during rollout.' },
        ],
        expect: {
          coverage: { 1: 'changes', 2: 'changes' },
          items: [
            { alias: 'eu-deployment', sources: [1], textIncludes: 'EU region' },
            { alias: 'audit-export', sources: [2], textIncludes: 'audit export' },
          ],
        },
      },
      {
        action: 'reopen',
        expect: {
          coverage: { 1: 'changes', 2: 'changes' },
          items: [
            { alias: 'eu-deployment', sources: [1], textIncludes: 'EU region' },
            { alias: 'audit-export', sources: [2], textIncludes: 'audit export' },
          ],
          requests: 0,
        },
      },
    ],
    responses: {
      1: { type: 'add', text: 'Deploy in the EU region.', sources: [1] },
      2: { type: 'add', text: 'Keep the audit export available during rollout.', sources: [2] },
    },
    expectedDecisions: [
      {
        alias: 'eu-deployment',
        kind: 'explicit',
        sources: [1],
        facts: ['Deploy in the EU region.'],
      },
      {
        alias: 'audit-export',
        kind: 'explicit',
        sources: [2],
        facts: ['Keep the audit export available during rollout.'],
      },
    ],
    eventualProgress: { seq: 2, status: 'changes', itemAlias: 'audit-export' },
  },
  {
    id: 'budget-large-assistant-response',
    title: 'Large preceding assistant response remains attributable to evidence preparation',
    mode: 'deterministic',
    steps: [
      {
        messages: [
          { seq: 1, author: 'agent', text: veryLongProposal },
          { seq: 2, author: 'user', text: 'Yes, use that retry policy.' },
        ],
        expect: {
          coverage: { 2: 'changes' },
          items: [{ alias: 'queue-retry', sources: [1, 2], textIncludes: '30-second' }],
        },
      },
    ],
    expectedDecisions: [
      {
        alias: 'queue-retry',
        kind: 'indirect',
        sources: [1, 2],
        facts: [
          'Use a 30-second retry interval for the worker queue.',
          'Retain the active job.',
          'Keep a diagnostic record.',
        ],
      },
    ],
    requiredEvidence: { 2: [1, 2] },
    responses: {
      2: {
        type: 'add',
        text: 'Use a 30-second retry interval for the worker queue. Preserve the active job and retain a diagnostic record.',
        sources: [1, 2],
      },
    },
    eventualProgress: { seq: 2, status: 'changes', itemAlias: 'queue-retry' },
  },
  {
    id: 'budget-growing-collection',
    title: 'A large saved collection cannot silently hide a new decision',
    mode: 'deterministic',
    seedItems: largeCollection,
    steps: [
      {
        messages: [
          { seq: 1, author: 'user', text: 'Use a 90-day retention period for audit records.' },
        ],
        expect: { ...observed('changes') },
      },
    ],
    expectedDecisions: [
      {
        alias: 'audit-retention',
        kind: 'explicit',
        sources: [1],
        facts: ['Retain audit records for 90 days.'],
      },
    ],
    responses: {
      1: { type: 'add', text: 'Retain audit records for 90 days.', sources: [1] },
    },
    eventualProgress: { seq: 1, status: 'changes', itemAlias: 'audit-retention' },
  },
  {
    id: 'budget-request-one-token-over',
    title: 'A request one estimated token over budget progresses through bounded processing',
    mode: 'deterministic',
    budgetOffset: -1,
    steps: [
      {
        messages: [{ seq: 1, author: 'user', text: 'Keep API retries bounded at three attempts.' }],
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'retry-cap', sources: [1], textIncludes: 'three attempts' }],
        },
      },
    ],
    responses: { 1: { type: 'add', text: 'Limit API retries to three attempts.', sources: [1] } },
    expectedDecisions: [
      {
        alias: 'retry-cap',
        kind: 'explicit',
        sources: [1],
        facts: ['Limit API retries to three attempts.'],
      },
    ],
    eventualProgress: { seq: 1, status: 'changes', itemAlias: 'retry-cap' },
  },
  {
    id: 'budget-request-at-limit',
    title: 'A request at the estimated budget boundary reaches inference',
    mode: 'deterministic',
    budgetOffset: 0,
    steps: [
      {
        messages: [{ seq: 1, author: 'user', text: 'Keep API retries bounded at three attempts.' }],
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'retry-cap', sources: [1], textIncludes: 'three attempts' }],
          requests: 1,
        },
      },
    ],
    responses: { 1: { type: 'add', text: 'Limit API retries to three attempts.', sources: [1] } },
    expectedDecisions: [
      {
        alias: 'retry-cap',
        kind: 'explicit',
        sources: [1],
        facts: ['Limit API retries to three attempts.'],
      },
    ],
  },
  {
    id: 'budget-request-one-token-under',
    title: 'A request one estimated token under budget reaches inference',
    mode: 'deterministic',
    budgetOffset: 1,
    steps: [
      {
        messages: [{ seq: 1, author: 'user', text: 'Keep API retries bounded at three attempts.' }],
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'retry-cap', sources: [1], textIncludes: 'three attempts' }],
          requests: 1,
        },
      },
    ],
    responses: { 1: { type: 'add', text: 'Limit API retries to three attempts.', sources: [1] } },
    expectedDecisions: [
      {
        alias: 'retry-cap',
        kind: 'explicit',
        sources: [1],
        facts: ['Limit API retries to three attempts.'],
      },
    ],
  },
  {
    id: 'budget-provider-context-rejection',
    title: 'Hosted provider context rejection is classified separately from local preflight',
    mode: 'deterministic',
    steps: [
      {
        messages: [{ seq: 1, author: 'user', text: 'Keep API retries bounded at three attempts.' }],
        expect: { coverage: { 1: 'failed' }, items: [], requests: 1 },
      },
    ],
    responses: { 1: 'context-rejection' },
    expectedDecisions: [
      {
        alias: 'retry-cap',
        kind: 'explicit',
        sources: [1],
        facts: ['Limit API retries to three attempts.'],
      },
    ],
  },
  {
    id: 'budget-plausible-item-missing-proposal-evidence',
    title: 'A plausible item fails when bounded evidence omitted the accepted proposal',
    mode: 'deterministic',
    pageSize: 1,
    steps: [
      {
        messages: [
          {
            seq: 1,
            author: 'agent',
            text: 'I propose a 30-second retry interval for the worker queue.',
          },
          { seq: 2, author: 'user', text: 'Could you check the current queue state?' },
          { seq: 3, author: 'agent', text: 'The staging queue has three waiting jobs.' },
          { seq: 4, author: 'user', text: 'Is the dashboard current?' },
          { seq: 5, author: 'agent', text: 'The dashboard refreshed at 10:15 UTC.' },
          { seq: 6, author: 'user', text: 'Use the earlier approach for the worker queue.' },
        ],
        expect: {
          coverage: { 2: 'no-change', 4: 'no-change', 6: 'changes' },
          items: [{ alias: 'queue-retry', sources: [5, 6], textIncludes: '30-second' }],
          requests: 3,
        },
      },
    ],
    responses: {
      6: {
        type: 'add',
        text: 'Use a 30-second retry interval for the worker queue.',
        sources: [5, 6],
      },
    },
    expectedDecisions: [
      {
        alias: 'queue-retry',
        kind: 'indirect',
        sources: [1, 6],
        facts: ['Use a 30-second retry interval for the worker queue.'],
      },
    ],
    requiredEvidence: { 6: [1, 6] },
  },
  {
    id: 'recognition-explicit-decision',
    title: 'Explicit decision',
    mode: 'live',
    steps: [
      {
        messages: [
          { seq: 1, author: 'user', text: 'Use PostgreSQL for the service metadata store.' },
        ],
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'metadata-store', sources: [1], textIncludes: 'PostgreSQL' }],
        },
      },
    ],
    expectedDecisions: [
      {
        alias: 'metadata-store',
        kind: 'explicit',
        sources: [1],
        facts: ['Use PostgreSQL for service metadata.'],
      },
    ],
  },
  {
    id: 'recognition-indirect-commitment',
    title: 'Indirectly phrased but clear commitment',
    mode: 'live',
    steps: [
      {
        messages: [
          {
            seq: 1,
            author: 'user',
            text: 'For the first release, we are shipping behind the existing feature flag.',
          },
        ],
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'release-flag', sources: [1], textIncludes: 'feature flag' }],
        },
      },
    ],
    expectedDecisions: [
      {
        alias: 'release-flag',
        kind: 'indirect',
        sources: [1],
        facts: ['Ship the first release behind the existing feature flag.'],
      },
    ],
  },
  {
    id: 'recognition-reference-acceptance',
    title: 'Acceptance cites the identifiable proposal and user acceptance',
    mode: 'live',
    steps: [
      {
        messages: [
          { seq: 1, author: 'agent', text: 'I propose storing generated reports for 30 days.' },
          { seq: 2, author: 'user', text: 'Yes, use that retention period.' },
        ],
        expect: {
          coverage: { 2: 'changes' },
          items: [{ alias: 'report-retention', sources: [1, 2], textIncludes: '30 days' }],
        },
      },
    ],
    expectedDecisions: [
      {
        alias: 'report-retention',
        kind: 'indirect',
        sources: [1, 2],
        facts: ['Store generated reports for 30 days.'],
      },
    ],
    requiredEvidence: { 2: [1, 2] },
  },
  {
    id: 'recognition-ambiguous-acknowledgment',
    title: 'Sounds promising does not accept the proposal',
    mode: 'live',
    steps: [
      {
        messages: [
          {
            seq: 1,
            author: 'agent',
            text: 'I propose setting the queue retry interval to 30 seconds.',
          },
          { seq: 2, author: 'user', text: 'Sounds promising.' },
        ],
        expect: { coverage: { 2: 'no-change' }, items: [] },
      },
    ],
    expectedDecisions: [],
  },
  {
    id: 'recognition-positive-acceptance-pair',
    title: 'Yes, use that approach accepts the same proposal',
    mode: 'live',
    steps: [
      {
        messages: [
          {
            seq: 1,
            author: 'agent',
            text: 'I propose setting the queue retry interval to 30 seconds.',
          },
          { seq: 2, author: 'user', text: 'Yes, use that approach.' },
        ],
        expect: {
          coverage: { 2: 'changes' },
          items: [{ alias: 'queue-retry', sources: [1, 2], textIncludes: '30 seconds' }],
        },
      },
    ],
    expectedDecisions: [
      {
        alias: 'queue-retry',
        kind: 'indirect',
        sources: [1, 2],
        facts: ['Set the queue retry interval to 30 seconds.'],
      },
    ],
    requiredEvidence: { 2: [1, 2] },
  },
  {
    id: 'recognition-partial-acceptance',
    title: 'Accept one proposal while rejecting its paired proposal',
    mode: 'live',
    steps: [
      {
        messages: [
          {
            seq: 1,
            author: 'agent',
            text: 'I propose a 30-second retry interval and keeping the previous index searchable during refresh.',
          },
          {
            seq: 2,
            author: 'user',
            text: 'Use the 30-second retry interval, but do not keep the previous index searchable.',
          },
        ],
        expect: {
          coverage: { 2: 'changes' },
          items: [{ alias: 'retry-interval', sources: [1, 2], textIncludes: '30-second' }],
        },
      },
    ],
    expectedDecisions: [
      {
        alias: 'retry-interval',
        kind: 'indirect',
        sources: [1, 2],
        facts: ['Set a 30-second retry interval.'],
      },
    ],
    requiredEvidence: { 2: [1, 2] },
  },
  {
    id: 'recognition-tentative-intention',
    title: 'Tentative future intention is not a decision',
    mode: 'live',
    steps: [
      {
        messages: [
          {
            seq: 1,
            author: 'user',
            text: 'I may switch the cache to Redis after the next load test.',
          },
        ],
        expect: { coverage: { 1: 'no-change' }, items: [] },
      },
    ],
    expectedDecisions: [],
  },
  {
    id: 'recognition-rejected-proposal',
    title: 'Rejected proposal does not become a decision',
    mode: 'live',
    steps: [
      {
        messages: [
          {
            seq: 1,
            author: 'agent',
            text: 'I propose enabling automatic retries for failed migrations.',
          },
          { seq: 2, author: 'user', text: 'No, keep migration retries manual.' },
        ],
        expect: {
          coverage: { 2: 'changes' },
          items: [{ alias: 'manual-migrations', sources: [2], textIncludes: 'manual' }],
        },
      },
    ],
    expectedDecisions: [
      {
        alias: 'manual-migrations',
        kind: 'explicit',
        sources: [2],
        facts: ['Keep migration retries manual.'],
      },
    ],
  },
  {
    id: 'recognition-unaccepted-suggestion',
    title: 'An unrelated response leaves an assistant suggestion unaccepted',
    mode: 'live',
    steps: [
      {
        messages: [
          {
            seq: 1,
            author: 'agent',
            text: 'We could enable automatic cache eviction after 30 minutes.',
          },
          { seq: 2, author: 'user', text: 'The deployment is scheduled for Thursday.' },
        ],
        expect: { coverage: { 2: 'no-change' }, items: [] },
      },
    ],
    expectedDecisions: [],
  },
  {
    id: 'recognition-inferred-preference',
    title: 'A question does not establish an inferred preference',
    mode: 'live',
    steps: [
      {
        messages: [{ seq: 1, author: 'user', text: 'Would Redis make this cache faster?' }],
        expect: { coverage: { 1: 'no-change' }, items: [] },
      },
    ],
    expectedDecisions: [],
  },
  {
    id: 'structure-independent-decisions',
    title: 'One message produces separate independently revisable decisions',
    mode: 'live',
    steps: [
      {
        messages: [
          {
            seq: 1,
            author: 'user',
            text: 'Keep the public cursor opaque so the storage format can change. Also, keep maintenance mode enabled until the queue drains.',
          },
        ],
        expect: {
          coverage: { 1: 'changes' },
          items: [
            { alias: 'opaque-cursor', sources: [1], textIncludes: 'opaque' },
            { alias: 'maintenance-window', sources: [1], textIncludes: 'queue' },
          ],
        },
      },
    ],
    expectedDecisions: [
      {
        alias: 'opaque-cursor',
        kind: 'explicit',
        sources: [1],
        facts: ['Keep the public cursor opaque.', 'This permits the storage format to change.'],
      },
      {
        alias: 'maintenance-window',
        kind: 'explicit',
        sources: [1],
        facts: ['Keep maintenance mode enabled until the queue drains.'],
      },
    ],
  },
  {
    id: 'fidelity-condition-rationale-and-identifiers',
    title: 'Keep conditions, rationale, identifiers, scope, and exceptions together',
    mode: 'live',
    steps: [
      {
        messages: [
          {
            seq: 1,
            author: 'user',
            text: 'Run tenant backfills in eu-central-1 because tenant exports are pinned there. Keep audit reads available during the backfill, except for account 7F2A.',
          },
        ],
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'tenant-backfill', sources: [1], textIncludes: 'eu-central-1' }],
        },
      },
    ],
    expectedDecisions: [
      {
        alias: 'tenant-backfill',
        kind: 'explicit',
        sources: [1],
        facts: [
          'Run tenant backfills in eu-central-1.',
          'Tenant exports are pinned to that region.',
          'Keep audit reads available during the backfill.',
          'Exclude account 7F2A from audit reads during the backfill.',
        ],
      },
    ],
  },
  {
    id: 'lifecycle-explicit-revision',
    title: 'Explicit revision updates the active item while preserving its identity',
    mode: 'live',
    steps: [
      {
        messages: [{ seq: 1, author: 'user', text: 'Set the queue retry interval to 20 seconds.' }],
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'retry-interval', sources: [1], textIncludes: '20 seconds' }],
          revisions: 1,
        },
      },
      {
        messages: [
          {
            seq: 2,
            author: 'user',
            text: 'Revise the earlier retry decision to use 35 seconds instead of 20 seconds.',
          },
        ],
        expect: {
          coverage: { 2: 'changes' },
          items: [{ alias: 'retry-interval', sources: [1, 2], textIncludes: '35 seconds' }],
          revisions: 2,
        },
      },
    ],
    responses: {
      1: { type: 'add', text: 'Set the queue retry interval to 20 seconds.', sources: [1] },
      2: {
        type: 'update',
        targetSource: 1,
        text: 'Set the queue retry interval to 35 seconds.',
        sources: [1, 2],
      },
    },
    expectedDecisions: [
      {
        alias: 'retry-interval',
        kind: 'explicit',
        sources: [1, 2],
        facts: ['Set the queue retry interval to 35 seconds.'],
      },
    ],
    requiredEvidence: { 2: [1, 2] },
  },
  {
    id: 'lifecycle-separate-same-topic',
    title: 'Separate decisions about the same queue retain independent identities',
    mode: 'deterministic',
    steps: [
      {
        messages: [{ seq: 1, author: 'user', text: 'Use Redis for the worker queue.' }],
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'queue-store', sources: [1], textIncludes: 'Redis' }],
          revisions: 1,
        },
      },
      {
        messages: [{ seq: 2, author: 'user', text: 'Keep queue events for 14 days.' }],
        expect: {
          coverage: { 2: 'changes' },
          items: [
            { alias: 'queue-store', sources: [1], textIncludes: 'Redis' },
            { alias: 'event-retention', sources: [2], textIncludes: '14 days' },
          ],
          revisions: 2,
        },
      },
    ],
    responses: {
      1: { type: 'add', text: 'Use Redis for the worker queue.', sources: [1] },
      2: { type: 'add', text: 'Keep queue events for 14 days.', sources: [2] },
    },
    expectedDecisions: [
      {
        alias: 'queue-store',
        kind: 'explicit',
        sources: [1],
        facts: ['Use Redis for the worker queue.'],
      },
      {
        alias: 'event-retention',
        kind: 'explicit',
        sources: [2],
        facts: ['Keep queue events for 14 days.'],
      },
    ],
  },
  {
    id: 'lifecycle-retraction',
    title: 'Retraction retires the item and retains revision history',
    mode: 'live',
    steps: [
      {
        messages: [
          { seq: 1, author: 'user', text: 'Keep the legacy endpoint available during rollout.' },
        ],
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'legacy-endpoint', sources: [1], textIncludes: 'legacy endpoint' }],
          revisions: 1,
        },
      },
      {
        messages: [
          {
            seq: 2,
            author: 'user',
            text: 'Retract the earlier decision. The legacy endpoint can be removed.',
          },
        ],
        expect: { coverage: { 2: 'changes' }, items: [], revisions: 2 },
      },
    ],
    responses: {
      1: { type: 'add', text: 'Keep the legacy endpoint available during rollout.', sources: [1] },
      2: { type: 'retire', targetSource: 1, sources: [1, 2] },
    },
    expectedDecisions: [],
  },
  {
    id: 'lifecycle-replay-idempotent',
    title: 'Reobserving committed input creates no duplicate items or revisions',
    mode: 'deterministic',
    steps: [
      {
        messages: [{ seq: 1, author: 'user', text: 'Use a 24-hour session timeout.' }],
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'session-timeout', sources: [1], textIncludes: '24-hour' }],
          revisions: 1,
        },
      },
      {
        action: 'observe',
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'session-timeout', sources: [1], textIncludes: '24-hour' }],
          revisions: 1,
          requests: 0,
        },
      },
    ],
    responses: { 1: { type: 'add', text: 'Use a 24-hour session timeout.', sources: [1] } },
    expectedDecisions: [
      {
        alias: 'session-timeout',
        kind: 'explicit',
        sources: [1],
        facts: ['Use a 24-hour session timeout.'],
      },
    ],
  },
  {
    id: 'lifecycle-suffix-recompute',
    title: 'Retrying a skipped message invalidates and recomputes a committed suffix',
    mode: 'deterministic',
    steps: [
      {
        messages: [
          { seq: 1, author: 'user', text: 'Keep the search cursor opaque.' },
          { seq: 2, author: 'user', text: 'Set the retry interval to 30 seconds.' },
        ],
        expect: {
          coverage: { 1: 'changes', 2: 'failed' },
          items: [{ alias: 'opaque-cursor', sources: [1], textIncludes: 'opaque' }],
          revisions: 1,
        },
      },
      {
        action: { recover: 'skip', seq: 2 },
        expect: {
          coverage: { 2: 'skipped' },
          items: [{ alias: 'opaque-cursor', sources: [1], textIncludes: 'opaque' }],
          revisions: 1,
        },
      },
      {
        messages: [{ seq: 3, author: 'user', text: 'Keep queue events for 14 days.' }],
        expect: {
          coverage: { 3: 'changes' },
          items: [
            { alias: 'opaque-cursor', sources: [1], textIncludes: 'opaque' },
            { alias: 'queue-retention-first', sources: [3], textIncludes: '14 days' },
          ],
          revisions: 2,
        },
      },
      {
        action: { recover: 'retry', seq: 2 },
        expect: {
          coverage: { 2: 'changes', 3: 'changes' },
          items: [
            { alias: 'opaque-cursor', sources: [1], textIncludes: 'opaque' },
            { alias: 'queue-retry', sources: [2], textIncludes: '30 seconds' },
            { alias: 'queue-retention-replayed', sources: [3], textIncludes: '14 days' },
          ],
          revisions: 4,
        },
      },
    ],
    responses: {
      1: { type: 'add', text: 'Keep the search cursor opaque.', sources: [1] },
      2: {
        attempts: [
          'context-rejection',
          { type: 'add', text: 'Set the retry interval to 30 seconds.', sources: [2] },
        ],
      },
      3: { type: 'add', text: 'Keep queue events for 14 days.', sources: [3] },
    },
    expectedDecisions: [
      {
        alias: 'opaque-cursor',
        kind: 'explicit',
        sources: [1],
        facts: ['Keep the search cursor opaque.'],
      },
      {
        alias: 'queue-retry',
        kind: 'explicit',
        sources: [2],
        facts: ['Set the retry interval to 30 seconds.'],
      },
      {
        alias: 'queue-retention-replayed',
        kind: 'explicit',
        sources: [3],
        facts: ['Keep queue events for 14 days.'],
      },
    ],
  },
  {
    id: 'recovery-interruption-and-restart',
    title: 'Interruption retains pending evidence for automatic processing after restart',
    mode: 'deterministic',
    steps: [
      {
        messages: [{ seq: 1, author: 'user', text: 'Use an opaque cursor for pagination.' }],
        action: 'interrupt',
        expect: { coverage: { 1: 'pending' }, items: [], revisions: 0 },
      },
      {
        action: 'reopen',
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'opaque-cursor', sources: [1], textIncludes: 'opaque' }],
          revisions: 1,
        },
      },
    ],
    responses: { 1: { type: 'add', text: 'Use an opaque cursor for pagination.', sources: [1] } },
    expectedDecisions: [
      {
        alias: 'opaque-cursor',
        kind: 'explicit',
        sources: [1],
        facts: ['Use an opaque cursor for pagination.'],
      },
    ],
    eventualProgress: { seq: 1, status: 'changes', itemAlias: 'opaque-cursor' },
  },
  {
    id: 'recovery-decision-across-evidence-page',
    title: 'Accepted decision remains recognizable when relevant evidence crosses a page boundary',
    mode: 'live',
    pageSize: 1,
    steps: [
      {
        messages: [
          {
            seq: 1,
            author: 'agent',
            text: 'I propose keeping the previous index readable until refresh finishes.',
          },
          { seq: 2, author: 'user', text: 'What is the refresh schedule?' },
          { seq: 3, author: 'agent', text: 'The refresh schedule runs at 02:00 UTC.' },
          { seq: 4, author: 'user', text: 'Use the proposal from earlier.' },
        ],
        expect: {
          coverage: { 4: 'changes' },
          items: [{ alias: 'index-readability', sources: [1, 4], textIncludes: 'previous index' }],
        },
      },
    ],
    expectedDecisions: [
      {
        alias: 'index-readability',
        kind: 'indirect',
        sources: [1, 4],
        facts: ['Keep the previous index readable until refresh finishes.'],
      },
    ],
    requiredEvidence: { 4: [1, 4] },
  },
  {
    id: 'recovery-long-no-decision',
    title: 'Long stretches without decisions retain complete no-change coverage',
    mode: 'deterministic',
    steps: [
      {
        messages: Array.from({ length: 40 }, (_, index) => ({
          seq: index + 1,
          author: 'user' as const,
          text: `Question ${index + 1}: is the test run still in progress?`,
        })),
        expect: {
          coverage: Object.fromEntries(
            Array.from({ length: 40 }, (_, index) => [index + 1, 'no-change']),
          ),
          items: [],
          requests: 40,
        },
      },
    ],
    responses: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [index + 1, 'no-change' as const]),
    ),
    expectedDecisions: [],
  },
  {
    id: 'native-pi-paseo-timeline',
    title: 'Native Pi conversation reaches persisted Tracker Notebook state',
    mode: 'deterministic',
    native: true,
    steps: [
      {
        messages: [
          { seq: 1, author: 'user', text: 'Use signed opaque cursors for result pagination.' },
        ],
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'signed-cursor', sources: [1], textIncludes: 'signed opaque cursor' }],
          revisions: 1,
        },
      },
      {
        action: 'reopen',
        expect: {
          coverage: { 1: 'changes' },
          items: [{ alias: 'signed-cursor', sources: [1], textIncludes: 'signed opaque cursor' }],
          revisions: 1,
          requests: 0,
        },
      },
    ],
    responses: {
      1: { type: 'add', text: 'Use signed opaque cursors for result pagination.', sources: [1] },
    },
    expectedDecisions: [
      {
        alias: 'signed-cursor',
        kind: 'explicit',
        sources: [1],
        facts: ['Use signed opaque cursors for result pagination.'],
      },
    ],
  },
];

export const decisionTrackerFixtureRevision = '1';

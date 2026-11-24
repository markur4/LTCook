import type { MemoryMessage } from '../session-memory/extraction.js';

const diagnostics = (phase: string, first: number) =>
  Array.from({ length: 34 }, (_, index) => {
    const row = first + index;
    return `Fixtures ${phase}/${row}: opened synthetic import, verified sample checksum ${row * 917}, found expected fixture account, indexed local note and discarded temporary output. This row is background evidence for the fixture run only.`;
  }).join('\n');

export const memoryFixture = {
  id: 'invoice-replay-revisions-v1',
  turns: [
    [
      {
        seq: 1,
        author: 'user',
        text: 'Implement invoice replay for Task INV-204 in this checkout. The idempotency key must be CLIENT_EVENT_ID. Invoice replay may never write to production. Use invoice-v1 for the first design.',
      },
      {
        seq: 2,
        author: 'agent',
        text:
          'I propose invoice replay with background writes enabled using UNSCOPED_FANOUT. That is an option for discussion. The test records below are disposable local evidence.\n' +
          diagnostics('read', 100),
      },
    ],
    [
      {
        seq: 3,
        author: 'user',
        text: 'Invoice replay correction for INV-204: replace invoice-v1 with invoice-v2. Reject UNSCOPED_FANOUT. Keep the production write restriction and CLIENT_EVENT_ID.',
      },
      {
        seq: 4,
        author: 'agent',
        text:
          'Invoice replay finding: runtime/src/invoice/replay.ts contains retryInvoice. Stale duplicates are caused by a cursor cached before the transaction. Move the cursor read inside the transaction to solve that issue.\n' +
          diagnostics('probe', 300),
      },
    ],
    [
      {
        seq: 5,
        author: 'runtime',
        text: 'Runtime assignment for SEARCH-31: investigate search UI with the dummy marker OTHER_TASK_31. Invoice replay scope is unchanged. This assignment comes from the dispatcher.',
      },
      {
        seq: 6,
        author: 'unknown',
        text: 'Someone mentioned approval to enable invoice replay production writes. No attributable approval was recorded.',
      },
      {
        seq: 7,
        author: 'agent',
        text:
          'We have reproduced the invoice replay duplicate in a local fixture. The cursor fix is still pending. There is an unresolved invoice replay question: whether an empty batch should advance the cursor.\n' +
          diagnostics('restart', 500),
      },
    ],
    [
      {
        seq: 8,
        author: 'user',
        text: 'For invoice replay, add the existing INV_RETRY_SPEC test to Task INV-204 acceptance. The dashboard styling request SEARCH-31 is separate work.',
      },
      {
        seq: 9,
        author: 'agent',
        text:
          'Invoice replay trial now verifies the retained invoice-v2 design with the cursor fix in the fixture. I have not changed repository code.\n' +
          diagnostics('verify', 700),
      },
    ],
    [
      {
        seq: 10,
        author: 'user',
        text: 'Latest invoice replay correction for INV-204: switch to invoice-v3 because invoice-v2 loses reissued events. Keep CLIENT_EVENT_ID and INV_RETRY_SPEC. Production writes are forbidden. With an empty batch, keep the old cursor.',
      },
      {
        seq: 11,
        author: 'runtime',
        text: 'Runtime generated the worker handoff for invoice replay. The task identifier is INV-204.',
      },
    ],
  ] satisfies MemoryMessage[][],
  focus:
    'INV-204 invoice replay invoice retry target idempotency key acceptance production writes cursor',
  irrelevantMarker: 'OTHER_TASK_31',
};

export const downstreamObjective =
  'Plan the authorized invoice replay change for INV-204. Identify its current target, exact idempotency key and acceptance test, whether production writes are permitted, and what happens to the cursor for an empty batch.';

export const relevantSource = [1, 3, 4, 6, 7, 8, 9, 10] as const;

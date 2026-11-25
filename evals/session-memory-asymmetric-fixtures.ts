import type { MemoryFact } from '../runtime/src/evals/session-memory-fixtures.js';

type ReplyFact = Omit<MemoryFact, 'source' | 'critical'>;

export const asymmetricFixtures = [
  {
    id: 'asymmetric-technical-discovery',
    user: 'Trace why a report preview can show rows from a different workspace after switching tabs. I need the reader location, the cause and the observed check results for the incident review. Keep this diagnostic read-only. Leave the cache contents and preview API untouched.',
    reply: `The stale value enters at \`readPreviewSnapshot\` in \`runtime/src/reports/preview-store.ts\`. The method looks up a snapshot by report ID alone. Two workspaces can carry the same report ID, so switching tabs can reuse the other workspace's snapshot. The API response already contains a workspace ID, but the cache lookup runs before that response is read. The affected path is the initial preview render. The explicit Refresh action bypasses the snapshot cache and goes straight to the current workspace's reader.

I traced the call through the preview panel and the export drawer. Both open through the same store, which explains why the symptom appears in two UI surfaces. The header's workspace name comes from the current tab, separately from the cached rows. Seeing the right workspace name is therefore compatible with seeing the wrong rows under it. The reproduction uses two local workspaces with different row values and the same report ID. It starts by opening the first preview and switching to the second without clicking Refresh.

The same-workspace case reported PREVIEW_SAME_WORKSPACE PASS. It reopened a preview with matching rows, so ordinary snapshot reuse still works. The switch case reported PREVIEW_CROSS_WORKSPACE FAIL. It stopped at the first stale-row assertion, so there is no result on later pagination assertions. I only inspected the code and ran the two local checks. I made no source changes, did not clear the cache and left the preview API untouched. Existing cached rows should remain available if the incident team wants to inspect the local reproduction.`,
    facts: [
      {
        label: 'exact snapshot reader and implementation path',
        kind: 'reference',
        expected: /runtime\/src\/reports\/preview-store\.ts/,
        identifiers: ['readPreviewSnapshot'],
      },
      {
        label: 'keyed by report ID alone, crossing workspace boundaries',
        kind: 'reference',
        expected:
          /(?:report ID|report identifier)[\s\S]{0,160}(?:alone|only|same|workspace)|(?:only|solely|same)[\s\S]{0,120}report ID/i,
        contradicts:
          /(?:key(?:s|ed)?|look(?:s)? up)[^.\n]{0,55}(?:using|by|with)[^.\n]{0,30}workspace ID|(?:issue|bug) (?:is|was|has been) (?:fixed|resolved)/i,
      },
      {
        label: 'same-workspace check passed',
        kind: 'progress',
        check: 'PREVIEW_SAME_WORKSPACE',
        checkStatus: 'pass',
        expected: /PREVIEW_SAME_WORKSPACE[^\n]*pass|pass[^\n]*PREVIEW_SAME_WORKSPACE/i,
      },
      {
        label: 'cross-workspace check failed',
        kind: 'progress',
        check: 'PREVIEW_CROSS_WORKSPACE',
        checkStatus: 'fail',
        expected: /PREVIEW_CROSS_WORKSPACE[^\n]*fail|fail[^\n]*PREVIEW_CROSS_WORKSPACE/i,
      },
      {
        label: 'later pagination assertions did not run',
        kind: 'progress',
        expected:
          /(?:no result|did not|didn't|never|before)[^.\n]{0,90}pagination|pagination[^.\n]{0,70}(?:not|unverified|unknown|untested)/i,
        contradicts: /pagination[^.\n]{0,28}(?:passed|succeeded|verified successfully)/i,
      },
    ] satisfies ReplyFact[],
  },
  {
    id: 'asymmetric-planning-execution',
    user: 'Prepare an import replay plan for review. You may add and run a local fixture to capture current behavior. Keep the external API signature stable, require explicit approval for any runtime change and leave the production queue alone. Tell me separately what you finished and what decisions are still open.',
    reply: `I added a local fixture at \`tests/import/replay-doctor.test.ts\`. It records the current behavior with two jobs that share an import ID but have different batch IDs. IMPORT_DUPLICATE_BATCH PASS confirmed the fixture can reproduce that both jobs are currently queued. In this check, passing means that the existing behavior was reproduced. It does not mean duplicate handling has been fixed. The only committed work in this exchange is the fixture. No runtime code changed, and the production queue was untouched.

For the runtime change, I propose extending \`prepareImportReplay\` to check both the import ID and batch ID before enqueueing. The external API signature would stay as it is. This would keep jobs for different batches distinct while catching a repeat of the same batch. I would put the check in the existing preparation step so the worker can keep using the stored job payload. I have not implemented the new check or obtained approval for it. Once the proposal is approved, I plan to add a regression for an exact retry of the same batch and make sure the worker never sees a second payload in that case.

The open decision is the retention period for a completed batch's key. Seven days is an option, but it has not been approved. If the retention period is too short, an old repeat could be accepted again. If it is too long, maintenance and storage grow even when retries are rare. Support needs to tell us how long their manual retries typically span. I would bring that answer back to review before choosing a value or writing a cleanup policy. Nothing in the local fixture depends on the retention decision.`,
    facts: [
      {
        label: 'completed local fixture at the exact path',
        kind: 'progress',
        expected:
          /(?:added|created|completed|implemented|wrote|committed)[^.\n]{0,120}tests\/import\/replay-doctor\.test\.ts|tests\/import\/replay-doctor\.test\.ts[^\n]{0,100}(?:added|created|completed|committed)/i,
        contradicts:
          /(?:duplicate handling|runtime check)[^.\n]{0,24}(?:is fixed|was fixed|is implemented|was implemented)/i,
      },
      {
        label: 'local duplicate-batch check passed',
        kind: 'progress',
        check: 'IMPORT_DUPLICATE_BATCH',
        checkStatus: 'pass',
        expected: /IMPORT_DUPLICATE_BATCH[^\n]*pass|pass[^\n]*IMPORT_DUPLICATE_BATCH/i,
        contradicts:
          /(?:duplicate handling|runtime check)[^.\n]{0,24}(?:is fixed|was fixed|is implemented|was implemented)/i,
      },
      {
        label: 'prepareImportReplay check remains proposed and unimplemented',
        kind: 'decision',
        identifiers: ['prepareImportReplay'],
        expected:
          /\b(?:propos(?:e|es|ed|al)|would|plan(?:s|ned)?|not implemented|pending approval)\b/i,
        contradicts:
          /(?:implemented|deployed|shipped|approved)[^.\n]{0,35}prepareImportReplay|prepareImportReplay[^.\n]{0,35}(?:was implemented|has been approved)|\bcheck (?:was |is |has been )?implemented in (?:the )?existing preparation step/i,
      },
      {
        label: 'seven-day key retention remains undecided',
        kind: 'question',
        expected:
          /(?:retention|seven days|7 days)[^\n]{0,120}(?:open|unresolved|unknown|undecided|option|not (?:yet )?approved|await|needs?)|(?:open|unresolved|undecided|option|await)[^\n]{0,100}(?:retention|seven days|7 days)/i,
        contradicts: /(?:approved|agreed|selected|set to)\s+(?:a\s+)?(?:7|seven)[- ]day/i,
      },
      {
        label: 'production queue was untouched',
        kind: 'progress',
        expected:
          /production queue[^.\n]{0,50}(?:untouched|unchanged|not)|(?:no|never|did not|didn't|leave|left)[^.\n]{0,70}production queue/i,
        contradicts:
          /production queue (?:was|has been) (?:updated|cleared|changed)|(?:^|[.;\n]\s*)(?:(?:I|we) )?(?:updated|cleared|changed|wrote to) (?:the )?production queue/i,
      },
    ] satisfies ReplyFact[],
  },
] as const;

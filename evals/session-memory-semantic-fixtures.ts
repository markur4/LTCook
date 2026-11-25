import type { MemoryFixture } from '../runtime/src/evals/session-memory-fixtures.js';
import type { MemoryScope, MemorySourceMessage } from '../runtime/src/session-memory/units.js';

function discussion(
  turnId: string,
  seq: number,
  question: string,
  reply: string,
  scope?: MemoryScope,
): MemorySourceMessage[] {
  return [
    { seq, turnId, author: 'user', text: question, scope },
    { seq: seq + 1, turnId, author: 'agent', text: reply, scope },
  ];
}

export const semanticMemoryFixtures: readonly MemoryFixture[] = [
  {
    id: 'semantic-export-header',
    turns: [
      discussion(
        'investigate',
        1,
        'The export preview sometimes turns the first record into column names. Please trace the preview reader and tell me where that decision is made. We need the implementation location for the review. I also need to know whether the quoted fixture succeeded and whether the missing header case succeeded. Feel free to report an incomplete result if either check did not run. This is a diagnosis request. Leave the files and the export defaults alone until we understand the cause.',
        'The decision is in parsePreviewHeader at runtime/src/export/preview-reader.ts. It uses the first nonblank row as the header when the saved delimiter is missing. That makes an ordinary row look like column names even though it has already passed delimiter detection. The same shortcut exists in both the preview tab and the details panel because they share the reader. EXPORT_QUOTED_ROW PASS was reported by the quoted fixture. EXPORT_MISSING_HEADER FAIL was reported by the fixture with no column names. The failure came from the header assertion, before any comparison of the remaining rows. I did not edit the reader or change an export setting.',
      ),
      [{ seq: 3, author: 'user', text: 'Prepare the preview diagnosis for review.' }],
    ],
    flushAfter: [2],
    originalSources: [1, 2],
    correctionSources: [],
    focus:
      'parsePreviewHeader runtime/src/export/preview-reader.ts EXPORT_QUOTED_ROW EXPORT_MISSING_HEADER',
    task: {
      prompt: 'Give the reader location and the observed result of each named check.',
      expected: {
        symbol: 'parsePreviewHeader',
        path: 'runtime/src/export/preview-reader.ts',
        quotedRow: 'pass',
        missingHeader: 'fail',
      },
    },
    facts: [
      {
        label: 'exact reader location',
        kind: 'reference',
        source: 2,
        critical: true,
        expected: /runtime\/src\/export\/preview-reader\.ts/i,
      },
      {
        label: 'exact header parser',
        kind: 'reference',
        source: 2,
        critical: true,
        expected: /\bparsePreviewHeader\b/,
      },
      {
        label: 'quoted row passed',
        kind: 'progress',
        source: 2,
        critical: true,
        check: 'EXPORT_QUOTED_ROW',
        expected: /EXPORT_QUOTED_ROW.*pass|pass.*EXPORT_QUOTED_ROW/i,
      },
      {
        label: 'missing header failed',
        kind: 'progress',
        source: 2,
        critical: true,
        check: 'EXPORT_MISSING_HEADER',
        checkStatus: 'fail',
        expected: /EXPORT_MISSING_HEADER.*fail|fail.*EXPORT_MISSING_HEADER/i,
      },
    ],
  },
  {
    id: 'semantic-retry-correction',
    turns: [
      discussion(
        'correction',
        1,
        'Correction to the earlier retry proposal. I approve a 45-second retry delay for the reporting job. Keep the limit at three attempts. I reject deleting queued reports when the last attempt fails. Keep the failed report visible so operations can inspect it. The older 10-second value was only a sketch and should be dropped from the implementation notes. This approval covers the reporting job. The import job has a different owner, so leave its delay and failure handling outside this change. Write down the scope before editing.',
        'Understood. The approved reporting retry delay is 45 seconds and the maximum remains three attempts. I will remove the outdated 10-second proposal from the implementation notes. Deletion of queued reports was rejected. After a final failure, the report should still be visible for investigation. I will keep this change scoped to reporting and leave the import job alone. The implementation notes should also distinguish a failed report that remains visible from a successful report that was sent. I have only captured the decision so far. There is no code change, queue deletion, or test result to report yet.',
      ),
      [
        {
          seq: 3,
          author: 'user',
          text: 'Give the implementation team the corrected retry decision.',
        },
      ],
    ],
    flushAfter: [2],
    originalSources: [1, 2],
    correctionSources: [1],
    focus:
      'reporting retry delay 45 seconds three attempts rejected deletion queued reports final failure',
    task: {
      prompt: 'State the approved retry delay and limit, and what happens to a failed report.',
      expected: { delaySeconds: 45, attempts: 3, deleteAfterFailure: false },
    },
    facts: [
      {
        label: 'corrected delay is 45 seconds',
        kind: 'decision',
        source: 1,
        critical: true,
        expected: /\b45[- ‐‑‒–—](?:sec|seconds?)\b\b/i,
        contradicts: /(?:approved|current|set to)\s+(?:a\s+)?10[- ‐‑‒–—](?:sec|seconds?)\b/i,
      },
      {
        label: 'retain three attempts',
        kind: 'decision',
        source: 1,
        critical: true,
        expected: /\b(?:3|three)(?: retry| total| maximum)? attempts\b/i,
      },
      {
        label: 'deleting queued reports was rejected',
        kind: 'decision',
        source: 1,
        critical: true,
        expected:
          /(?:reject\w*|do not|no)\b[^.\n]{0,65}delet|delet[^.\n]{0,65}(?:reject|not approved)|(?:keep|retain)[^.\n]{0,70}(?:failed report|queued reports?)/i,
        contradicts:
          /(?:approved|authorized)\s+(?:the\s+)?(?:deletion of|deleting)\s+queued reports/i,
      },
    ],
  },
  {
    id: 'semantic-manifest-reference',
    taskContext: {
      title: 'Manifest refresh',
      description: 'Implement the approved manifest refresh behavior.',
      acceptance: ['Keep the exporter API stable.'],
    },
    turns: [
      discussion(
        'proposal',
        1,
        'Can we make the manifest refresh cheaper for unchanged exports? The current job rebuilds the manifest even if the saved export identifier and source revision both still match. Please assess using reuseExportManifest for that case. I want to discuss the shape before we decide. The path still needs to work for a first export, when there is no saved manifest, and we have to keep old export clients working during rollout. Tell me what the fallback would be if the saved manifest no longer matches. The support team uses the manifest to compare two exports for the same account, so make sure the proposal keeps the fields they already read.',
        'The proposal is to use reuseExportManifest only when the saved export identifier and source revision both match. The existing builder would handle a first export and a changed source revision. This keeps the fallback behavior straightforward and does not require a change to the exporter API. An old client would continue to read the current manifest fields. I would add a focused check for each mismatch before considering any cleanup of existing files. This is a proposal awaiting your decision. I have not implemented or verified it.',
        { sessionId: 'exports' },
      ),
      discussion(
        'clarification',
        3,
        'Would that still allow an old client to refresh an export?',
        'Yes. The proposal keeps the current manifest format and exporter API.',
        { sessionId: 'exports' },
      ),
      discussion(
        'approval',
        5,
        'Implement that proposal. Keep the exporter API stable, including the current method signature and the response fields older clients read. I reject deleting old manifests in this change. Operations may need to inspect the earlier exports during rollout. Keep the existing builder for a first export and for a revision mismatch. Before asking for review, write down how you will check the matching case and both fallbacks. There is no approval to change the export format, update clients, or add a background cleanup job.',
        'I will carry out the approved manifest refresh and keep the exporter API as it is today. The existing builder remains the fallback for first exports and changed revisions. I will check the matching case separately from a first export and a revision mismatch, and document the outcomes before review. Old manifests will stay in place. There is no client change or background cleanup in this plan. I have recorded the approval and scope. For the mismatch case, I will start with an existing manifest tagged with a different source revision so the fallback is exercised directly. I have made no code changes and run no checks in this discussion.',
        { sessionId: 'exports', taskId: 'manifest-refresh' },
      ),
      [
        {
          seq: 7,
          author: 'user',
          scope: { sessionId: 'exports', taskId: 'manifest-refresh' },
          text: 'Hand off the approved manifest refresh work.',
        },
      ],
    ],
    flushAfter: [6],
    originalSources: [1, 2, 3, 4, 5, 6],
    correctionSources: [5],
    focus:
      'reuseExportManifest approved manifest refresh proposal stable exporter API rejected deleting old manifests',
    task: {
      prompt: 'Give the approved implementation referent, API constraint, and rejected cleanup.',
      expected: { symbol: 'reuseExportManifest', keepApi: true, deleteOldManifests: false },
    },
    facts: [
      {
        label: 'manifest reuse initially remained a proposal',
        kind: 'decision',
        source: 1,
        critical: true,
        expected:
          /(?:propos\w*|consider\w*)[^\n]{0,125}reuseExportManifest|reuseExportManifest[^\n]{0,125}(?:propos\w*|consider\w*)/i,
        contradicts:
          /reuseExportManifest[^.\n]{0,80}\b(?:is|was) approved\b|\buser approved\b[^.\n]{0,80}reuseExportManifest/i,
      },
      {
        label: 'the later approval names the proposed implementation',
        kind: 'decision',
        source: 5,
        critical: true,
        expected:
          /(?:approv\w*|implement\w*|agreed|accepted)[^\n]{0,125}reuseExportManifest|reuseExportManifest[^\n]{0,125}(?:approv\w*|agreed|accepted)/i,
        contradicts: /(?:reject\w*|declined)\s+(?:using\s+)?reuseExportManifest/i,
      },
      {
        label: 'keep the exporter API stable',
        kind: 'decision',
        source: 5,
        critical: true,
        expected:
          /(?:keep|preserv|unchanged|stable)[^.\n]{0,48}(?:exporter )?API|API[^.\n]{0,48}(?:unchanged|stable|as it is)/i,
      },
      {
        label: 'reject deleting old manifests',
        kind: 'decision',
        source: 5,
        critical: true,
        expected:
          /(?:reject\w*|no|do not)\b[^.\n]{0,65}(?:delet\w*|cleanup)|(?:retain|preserve|keep)[^.\n]{0,48}old manifests|old manifests[^.\n]{0,48}(?:stay|remain)/i,
        contradicts: /(?:approved|authorized)\s+(?:deleting|deletion of)\s+old manifests/i,
      },
    ],
  },
];

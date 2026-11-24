import type { MemoryEntry, MemoryMessage } from './session-memory-extractive.js';
import type { MemorySourceMessage, MemoryTaskContext } from '../session-memory/units.js';

export type MemoryFact = {
  label: string;
  expected: RegExp;
  identifiers?: readonly string[];
  source: number;
  kind: Exclude<MemoryEntry['kind'], 'user'>;
  critical?: boolean;
  contradicts?: RegExp;
};

export type MemoryFixture = {
  id: string;
  turns: readonly (readonly MemorySourceMessage[])[];
  flushAfter: readonly number[];
  originalSources: readonly number[];
  correctionSources: readonly number[];
  focus: string;
  task: { prompt: string; expected: Record<string, string | number | boolean> };
  facts: readonly MemoryFact[];
  taskContext?: MemoryTaskContext;
};

export const memoryFixtures: readonly MemoryFixture[] = [
  {
    id: 'invoice-replay-revisions',
    turns: [
      [
        {
          seq: 1,
          author: 'user',
          text: 'Implement invoice replay for Task INV-204. Use invoice-v1 for the initial design. The idempotency key must be CLIENT_EVENT_ID. Invoice replay may never write to production.',
        },
        {
          seq: 2,
          author: 'agent',
          text: 'I propose UNSCOPED_FANOUT as a possible write strategy. It has not been approved. I will trace the replay code before making changes.',
        },
      ],
      [
        {
          seq: 3,
          author: 'user',
          text: 'Invoice replay correction for INV-204: replace invoice-v1 with invoice-v2 and reject UNSCOPED_FANOUT. Keep the production write restriction and CLIENT_EVENT_ID.',
        },
        {
          seq: 4,
          author: 'agent',
          text: 'Invoice replay finding: runtime/src/invoice/replay.ts contains retryInvoice. The cursor is read outside its transaction, so a retry can reuse an out-of-date cursor. I can reproduce this with two delivery attempts using the same event ID.',
        },
      ],
      [
        {
          seq: 5,
          author: 'runtime',
          text: 'Unrelated task SEARCH-31: look into a dashboard style issue. This does not change invoice replay.',
        },
        {
          seq: 6,
          author: 'unknown',
          text: 'Someone said production writes are allowed; no attributable approval was recorded.',
        },
        {
          seq: 7,
          author: 'agent',
          text: 'An empty replay batch raises an open question about advancing the cursor. I have left that behavior unchanged pending the decision.',
        },
      ],
      [
        {
          seq: 8,
          author: 'user',
          text: 'For invoice replay add INV_RETRY_SPEC to acceptance. The dashboard style task is separate.',
        },
        {
          seq: 9,
          author: 'tool',
          text: 'Invoice replay test result: DUPLICATE_REPLAY_CASE PASS with the cursor read inside the transaction in the local fixture.',
        },
      ],
      [
        {
          seq: 10,
          author: 'user',
          text: 'Latest invoice replay correction for INV-204: use invoice-v3. Keep CLIENT_EVENT_ID and INV_RETRY_SPEC. Production writes are forbidden. For an empty batch keep the existing cursor.',
        },
      ],
    ],
    flushAfter: [4, 9],
    originalSources: [1, 3, 4, 7, 8, 9, 10],
    correctionSources: [10],
    focus: 'INV-204 invoice replay design acceptance retryInvoice DUPLICATE_REPLAY_CASE cursor',
    task: {
      prompt:
        'Handoff task INV-204. Report designVersion (an invoice version string), idempotencyKey, acceptanceTest, productionWrites (boolean), and emptyBatchCursor (keep or advance).',
      expected: {
        designVersion: 'invoice-v3',
        idempotencyKey: 'CLIENT_EVENT_ID',
        acceptanceTest: 'INV_RETRY_SPEC',
        productionWrites: false,
        emptyBatchCursor: 'keep',
      },
    },
    facts: [
      {
        label: 'replay source path',
        expected: /runtime\/src\/invoice\/replay\.ts/,
        identifiers: ['runtime/src/invoice/replay.ts'],
        source: 4,
        kind: 'reference',
        critical: true,
      },
      {
        label: 'replay function name',
        expected: /\bretryInvoice\b/,
        identifiers: ['retryInvoice'],
        source: 4,
        kind: 'reference',
        critical: true,
      },
      {
        label: 'cursor transaction hazard',
        expected:
          /cursor.*(?:outside|out.of.date|stale).*transaction|transaction.*(?:outside|stale|cursor)/i,
        source: 4,
        kind: 'issue',
      },
      {
        label: 'empty batch decision was open',
        expected: /empty.*(?:question|pending|open)|(?:question|pending|open).*empty/i,
        source: 7,
        kind: 'question',
      },
      {
        label: 'duplicate replay result',
        expected: /DUPLICATE_REPLAY_CASE.*pass|pass.*DUPLICATE_REPLAY_CASE/i,
        identifiers: ['DUPLICATE_REPLAY_CASE'],
        contradicts: /DUPLICATE_REPLAY_CASE.*fail|fail.*DUPLICATE_REPLAY_CASE/i,
        source: 9,
        kind: 'progress',
        critical: true,
      },
    ],
  },
  {
    id: 'paseo-rewind-triage',
    turns: [
      [
        {
          seq: 1,
          author: 'user',
          text: 'Investigate stale Session Memory citations after Pi/Paseo rewind. Test Codex as well for the first pass.',
        },
        {
          seq: 2,
          author: 'agent',
          text: 'The first failing assertion is in tests/runtime/system/paseo-leader-acceptance.ts. The native rewind needs the timeline provider message ID to find the captured Pi tree entry.',
        },
      ],
      [
        {
          seq: 3,
          author: 'tool',
          text: 'paseo-leader-acceptance result: PI_REWIND_PROVIDER_ID PASS. PRUNED_CITATION_LOOKUP PASS. The native fixture observed a new timeline epoch.',
        },
        {
          seq: 4,
          author: 'user',
          text: 'Revise the rewind test plan. Use Pi only for native acceptance. Preserve the shared MCP TeamInstance access boundary.',
        },
      ],
      [
        {
          seq: 5,
          author: 'agent',
          text: 'In runtime/src/integrations/paseo-memory.ts the canonical timeline returns both the epoch and sequence. A lookup using the old epoch must fail after rewind. A lookup using matching epoch and sequence can return the stored source.',
        },
        {
          seq: 6,
          author: 'agent',
          text: 'Remaining implementation question: should the tool show a specific stale-reference label, or keep using its existing unavailable result?',
        },
      ],
      [
        {
          seq: 7,
          author: 'user',
          text: 'For this rewind fix, keep the existing unavailable result for stale citations. Acceptance remains Pi native, with authorized team sharing unchanged.',
        },
      ],
    ],
    flushAfter: [3, 6],
    originalSources: [1, 2, 3, 4, 5, 6, 7],
    correctionSources: [7],
    focus: 'Pi Paseo rewind old epoch stale citation test PI_REWIND_PROVIDER_ID TeamInstance',
    task: {
      prompt:
        'Prepare the rewind verification handoff. Report nativeHarness (Pi or Codex), staleCitationResult (unavailable or available), teamSharing (unchanged or removed), and providerIdCheck (pass or fail for PI_REWIND_PROVIDER_ID).',
      expected: {
        nativeHarness: 'Pi',
        staleCitationResult: 'unavailable',
        teamSharing: 'unchanged',
        providerIdCheck: 'pass',
      },
    },
    facts: [
      {
        label: 'native acceptance test path',
        expected: /tests\/runtime\/system\/paseo-leader-acceptance\.ts/,
        identifiers: ['tests/runtime/system/paseo-leader-acceptance.ts'],
        source: 2,
        kind: 'reference',
      },
      {
        label: 'rewind provider ID verification',
        expected: /PI_REWIND_PROVIDER_ID.*pass|pass.*PI_REWIND_PROVIDER_ID/i,
        identifiers: ['PI_REWIND_PROVIDER_ID'],
        contradicts: /PI_REWIND_PROVIDER_ID.*fail|fail.*PI_REWIND_PROVIDER_ID/i,
        source: 3,
        kind: 'progress',
        critical: true,
      },
      {
        label: 'rewind invalidates the previous epoch',
        expected:
          /(?:old|prior|previous).*epoch.*(?:fail|invalid|stale)|(?:fail|invalid|stale).*epoch/i,
        source: 5,
        kind: 'finding',
        critical: true,
      },
      {
        label: 'stale reference presentation question',
        expected: /stale.*(?:label|unavailable)/i,
        source: 6,
        kind: 'question',
      },
    ],
  },
  {
    id: 'runtime-rebuild-and-cache-recovery',
    taskContext: {
      title: 'Cache recovery',
      description: 'Implement the restart and cache recovery work in the initiating instructions.',
      acceptance: ['Record actual checks and preserve the existing cache on incompatible input.'],
    },
    turns: [
      [
        {
          seq: 1,
          author: 'user',
          scope: { taskId: 'runtime-rebuild-and-cache-recovery' },
          text: 'Reduce restart latency for the LTCook repository search cache. The initial plan may include rebuilding the cache automatically. Keep the runtime-owned SQLite file in AppRC state and preserve the local Ollama setup.',
        },
        {
          seq: 2,
          author: 'agent',
          scope: { taskId: 'runtime-rebuild-and-cache-recovery' },
          text: 'I traced runtime startup before testing changes. The deployment launches a worker after AppRC resolution and the worker resolves its cache state from the selected workspace. This creates a useful boundary between workspace selection and cache IO. Repo search and artifact preparation currently happen through different commands, and neither should infer authority from whatever directories happen to exist.',
        },
        {
          seq: 3,
          author: 'tool',
          scope: { taskId: 'runtime-rebuild-and-cache-recovery' },
          text: 'Traditional Tests check CACHE_OPEN_RESTART FAIL. fixture version marker=3, supported version=4; SQLite reports SQLITE_SCHEMA on first restart. CACHE_CLEAN_START PASS. No network connections were opened.',
        },
      ],
      [
        {
          seq: 4,
          author: 'user',
          scope: { taskId: 'runtime-rebuild-and-cache-recovery' },
          text: 'Cache recovery correction: reject automatic rebuilding for this pass. Leave unsupported cache files unchanged. Report an explicit reset instruction. Preserve local Ollama settings and keep the acceptance path offline.',
        },
        {
          seq: 5,
          author: 'agent',
          scope: { taskId: 'runtime-rebuild-and-cache-recovery' },
          text: 'The cache opener is openWorkspaceCache in runtime/src/tools/repository-evidence-text.ts. Startup selected the correct workspace. The cache owner saw a version mismatch and returned a schema error before creating a fresh cache. Adding a clear message there avoids changing the installer or workspace resolution. No cache file was edited in this check.',
        },
        {
          seq: 6,
          author: 'agent',
          scope: { taskId: 'runtime-rebuild-and-cache-recovery' },
          text: 'I considered a repair job with a queue and retry, then set it aside. Typical sessions can already start once the cache is compatible, and retrying a version mismatch would only hide the actionable error. I will keep the first check to the restart path, then verify that the error path has no disk writes.',
        },
      ],
      [
        {
          seq: 7,
          author: 'user',
          scope: { taskId: 'runtime-rebuild-and-cache-recovery' },
          text: 'Document the reset guidance in docs/Development.md. The task is a cache startup behavior and docs fix. It does not change the public session architecture, installer privileges, or model provisioning.',
        },
        {
          seq: 8,
          author: 'tool',
          scope: { taskId: 'runtime-rebuild-and-cache-recovery' },
          text: 'Follow-up fixture CACHE_VERSION_GUARD PASS. Old cache bytes SHA256 match before and after startup. ERROR_RESET_HINT PASS. The new file was created only in the synthetic compatible-cache variant.',
        },
        {
          seq: 9,
          author: 'agent',
          scope: { taskId: 'runtime-rebuild-and-cache-recovery' },
          text: 'The workspace test now covers the unsupported version and prints a reset message. Local inspection shows the incompatible file was preserved. I have not invoked the installer or contacted a service. A short setup guide could make the same boundary explicit to an operator who sees only the startup log.',
        },
      ],
      [
        {
          seq: 10,
          author: 'runtime',
          text: 'Unrelated docs task: rename the browser settings menu link. Use this as a separate pass.',
        },
        {
          seq: 11,
          author: 'user',
          scope: { taskId: 'runtime-rebuild-and-cache-recovery' },
          text: 'Final cache decision: use the manual reset instruction in docs/Development.md and preserve the existing file. Do not change the Ollama configuration or create network dependencies. The required verification is CACHE_VERSION_GUARD.',
        },
      ],
    ],
    flushAfter: [3, 9],
    originalSources: [1, 3, 4, 5, 7, 8, 9, 11],
    correctionSources: [11],
    focus:
      'cache startup version mismatch reset CACHE_VERSION_GUARD openWorkspaceCache docs/Development.md preserve offline',
    task: {
      prompt:
        'Prepare the restart-cache handoff. Report recoveryMode as manual or automatic, retainOldCache (boolean), docsPath, verificationCheck, and networkAllowed (boolean).',
      expected: {
        recoveryMode: 'manual',
        retainOldCache: true,
        docsPath: 'docs/Development.md',
        verificationCheck: 'CACHE_VERSION_GUARD',
        networkAllowed: false,
      },
    },
    facts: [
      {
        label: 'failing restart reports schema mismatch',
        expected: /SQLITE_SCHEMA/i,
        source: 3,
        kind: 'issue',
      },
      {
        label: 'cache opener location',
        expected: /runtime\/src\/tools\/repository-evidence-text\.ts/,
        identifiers: ['runtime/src/tools/repository-evidence-text.ts'],
        source: 5,
        kind: 'reference',
        critical: true,
      },
      {
        label: 'cache opener symbol',
        expected: /\bopenWorkspaceCache\b/,
        identifiers: ['openWorkspaceCache'],
        source: 5,
        kind: 'reference',
        critical: true,
      },
      {
        label: 'cache version guard result',
        expected: /CACHE_VERSION_GUARD.*pass|pass.*CACHE_VERSION_GUARD/i,
        identifiers: ['CACHE_VERSION_GUARD'],
        contradicts: /CACHE_VERSION_GUARD.*fail|fail.*CACHE_VERSION_GUARD/i,
        source: 8,
        kind: 'progress',
        critical: true,
      },
      {
        label: 'old cache bytes preserved by follow-up',
        expected: /old cache.*(?:match|unchanged|preserv)|SHA256.*match/i,
        source: 8,
        kind: 'finding',
      },
    ],
  },
];

// > A longer companion workflow with interleaved reports from an unrelated docs pass.
// > Use the same cache task, critical facts and matched control as the short version.
export function memoryCadenceFixture(): MemoryFixture {
  const base = memoryFixtures.find(({ id }) => id === 'runtime-rebuild-and-cache-recovery')!;
  const areas = [
    ['workspace navigation', 'team selector', 'session picker'],
    ['quick-start links', 'command reference', 'shortcut table'],
    ['status screen', 'error messages', 'confirmation dialog'],
    ['contributor overview', 'component index', 'glossary'],
    ['accessibility copy', 'keyboard navigation', 'focus outline'],
    ['Ubuntu screenshots', 'macOS screenshots', 'terminal examples'],
    ['sidebar labels', 'search filters', 'results headings'],
    ['settings labels', 'language selector', 'help links'],
    ['example captions', 'table alignment', 'section titles'],
  ];
  type Report = Omit<MemoryMessage, 'seq'>;
  const reports = areas.map((sections): Report[] =>
    sections.flatMap((section) => [
      {
        author: 'agent',
        text: `Parallel documentation pass for ${section}. I checked the visible UI labels against the maintained examples and located differences in title case, singular wording and how the surrounding paragraph refers to the action. The guide uses those labels as literal directions, so the running interface is the correct reference. I recorded the link destinations and checked that the first actionable verb survives the shortening.`,
      },
      {
        author: 'agent',
        text: `Follow-up on ${section}. The copy reviewer compared the proposed wording with the printed example and found two duplicated phrases. The screenshot captions can refer to the action once and keep enough text to distinguish the collapsed and expanded states. I left the installed UI and its translations alone. The remaining check is whether the heading can be shortened without breaking the existing anchor.`,
      },
      {
        author: 'tool',
        text: `Documentation review for ${section}: link check passed. The generated heading anchor matched the incoming table of contents, the label appeared on the expected page and the prose linter found no duplicate word.`,
      },
    ]),
  );
  let seq = 0;
  const sources = new Map<number, number>();
  const turns = base.turns.flatMap((turn, index) => {
    const relevant = turn.map(({ seq: original, ...message }) => {
      sources.set(original, ++seq);
      return { seq, ...message, turnId: `cache-${index}`, scope: { taskId: base.id } };
    });
    const interleaved = reports.slice(index * 3, (index + 1) * 3);
    return [
      relevant,
      ...interleaved.map((report, reportIndex) =>
        report.map((message) => ({
          seq: ++seq,
          ...message,
          turnId: `documentation-${index}-${reportIndex}`,
          scope: { taskId: `documentation-${index}-${reportIndex}` },
        })),
      ),
    ];
  });
  return {
    ...base,
    id: `${base.id}-cadence`,
    turns,
    flushAfter: [],
    originalSources: base.originalSources.map((source) => sources.get(source)!),
    correctionSources: base.correctionSources.map((source) => sources.get(source)!),
    facts: base.facts.map((fact) => ({ ...fact, source: sources.get(fact.source)! })),
  };
}

export function memoryAttachmentFixture(): MemoryFixture {
  const base = memoryFixtures.find(({ id }) => id === 'paseo-rewind-triage')!;
  const first = base.turns[0]![0]!;
  const path = 'runtime/src/integrations/paseo-memory.ts';
  const attachment =
    Array.from(
      { length: 18 },
      (_, index) =>
        `Draft documentation note ${index + 1}. The previous workspace review inspected user-visible copy and guide navigation. Record documentation observations separately from the verified Agent Actions.`,
    ).join('\n') +
    '\nVerification reference: PASEO_REWIND_SOURCE completed against ' +
    path +
    '.';
  const initial: MemorySourceMessage = {
    ...first,
    text:
      first.text +
      ' The attached review contains the exact rewind verification name and source path. Keep both for the next Discussion.',
    attachments: [{ id: 'fixture-reference', name: 'Rewind notes', text: attachment }],
  };
  return {
    ...base,
    id: 'paseo-rewind-with-pasted-reference',
    turns: [[initial, ...base.turns[0]!.slice(1)], ...base.turns.slice(1)],
    facts: [
      ...base.facts,
      {
        label: 'attached rewind verification name and source path',
        source: first.seq,
        expected: /PASEO_REWIND_SOURCE[\s\S]{0,200}runtime\/src\/integrations\/paseo-memory\.ts/,
        identifiers: ['PASEO_REWIND_SOURCE', 'runtime/src/integrations/paseo-memory.ts'],
        critical: true,
        kind: 'reference',
      },
    ],
  };
}

/** New labels for qualification after prompt development on the original cache fixtures. */
export const memoryHeldOutFixture: MemoryFixture = {
  id: 'held-out-index-restore',
  turns: [
    [
      {
        seq: 1,
        turnId: 'restore',
        author: 'user',
        scope: { taskId: 'restore' },
        text: 'Restore the workspace index without creating a replacement cache. Preserve the existing index and document only observed outcomes.',
      },
      {
        seq: 2,
        turnId: 'restore',
        author: 'tool',
        scope: { taskId: 'restore' },
        text: 'INDEX_RESTORE_FAILSAFE PASS. The previous index retained 37 entries. No files were created.',
      },
      {
        seq: 3,
        turnId: 'restore',
        author: 'agent',
        scope: { taskId: 'restore' },
        text: 'restoreIndexSnapshot in runtime/src/repository/index-restore.ts retained the previous index with 37 entries.',
      },
    ],
    [
      {
        seq: 4,
        turnId: 'docs',
        author: 'runtime',
        scope: { taskId: 'docs' },
        text: 'Separate documentation assignment for the installation heading.',
      },
      {
        seq: 5,
        turnId: 'docs',
        author: 'agent',
        scope: { taskId: 'docs' },
        text: 'I proposed changing the heading and left it as it was.',
      },
    ],
    [
      {
        seq: 6,
        author: 'user',
        text: 'Give me the observed index restore check, retained entry count and exact implementation symbol.',
      },
    ],
  ],
  flushAfter: [3],
  originalSources: [1, 2, 3, 6],
  correctionSources: [6],
  focus:
    'INDEX_RESTORE_FAILSAFE restoreIndexSnapshot runtime/src/repository/index-restore.ts 37 retained entries',
  task: {
    prompt: 'Report check and retained count.',
    expected: { check: 'INDEX_RESTORE_FAILSAFE', retained: 37 },
  },
  facts: [
    {
      label: 'observed restore outcome',
      source: 2,
      kind: 'progress',
      critical: true,
      identifiers: ['INDEX_RESTORE_FAILSAFE'],
      expected: /INDEX_RESTORE_FAILSAFE.*(?:pass|success)/i,
      contradicts: /INDEX_RESTORE_FAILSAFE.*fail(?:ed|ure)?\b/i,
    },
    {
      label: 'retained index size',
      source: 2,
      kind: 'finding',
      critical: true,
      expected: /\b37\b.*entries/i,
    },
    {
      label: 'implementation',
      source: 3,
      kind: 'reference',
      critical: true,
      identifiers: ['restoreIndexSnapshot', 'runtime/src/repository/index-restore.ts'],
      expected: /restoreIndexSnapshot|index-restore/,
    },
  ],
};

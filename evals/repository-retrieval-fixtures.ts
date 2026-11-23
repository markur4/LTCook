export type SourceRange = { path: string; startLine: number; endLine: number };

export type RetrievalQuestion = {
  id: string;
  group: 'lexical' | 'conceptual';
  category:
    | 'identifier'
    | 'concept'
    | 'distractor'
    | 'keyword-overlap'
    | 'multi-file'
    | 'answerless'
    | 'lifecycle'
    | 'limited';
  source: 'fixture' | 'ltcook';
  query: string;
  queryLanguage?: 'de';
  expected: SourceRange[];
  limit?: number;
};

export const repositoryFixturePaths = [
  'runtime/src/repository/workspace.ts',
  'runtime/src/repository/filesystem.ts',
  'runtime/src/repository/discovery.ts',
  'src/ltcook_dev/packaging/package_assets.py',
] as const;

const moveSource = 'fixture/src/banner.ts';
const moveDestination = 'fixture/src/banner-moved.ts';

function fixtureSource(...lines: string[]) {
  return `${lines.join('\n')}\n`;
}

const fixture = {
  'fixture/src/ledger.ts': fixtureSource(
    'export function allocateTicket(occupied: Set<number>, id: number) {',
    '  if (occupied.has(id)) return false;',
    '  occupied.add(id);',
    '  return true;',
    '}',
  ),
  'fixture/src/preview.ts': fixtureSource(
    'export function allocateTicketPreview(occupied: Set<number>, id: number) {',
    '  return !occupied.has(id);',
    '}',
  ),
  'fixture/src/cart.ts': fixtureSource(
    'import { allocateTicket } from "./ledger";',
    '',
    'export function checkout(occupied: Set<number>, id: number) {',
    '  return allocateTicket(occupied, id);',
    '}',
  ),
  'fixture/tests/ledger.test.ts': fixtureSource(
    'import { allocateTicket } from "../src/ledger";',
    '',
    'test("repeated claim", () => {',
    '  expect(allocateTicket(new Set([7]), 7)).toBe(false);',
    '});',
  ),
  'fixture/src/brightness.ts': fixtureSource(
    'export function clampChannel(n: number) {',
    '  return Math.min(255, Math.max(0, n));',
    '}',
  ),
  'fixture/src/brightness-preview.ts': fixtureSource(
    'export function clampChannelPreview(n: number) {',
    '  return n.toFixed(0);',
    '}',
  ),
  'fixture/src/billing-preview.ts': fixtureSource(
    'export function formatCreditCardNumber(value: string) {',
    '  return value.replace(/\\D/g, "").replace(/(.{4})/g, "$1 ").trim();',
    '}',
    'export function receiptChecksum(payload: string) {',
    '  return payload.length % 97;',
    '}',
  ),
  'fixture/src/retry.py': fixtureSource(
    'MAX_RETRY_SECONDS = 30',
    '',
    'def bounded_retry_delay(attempt: int) -> int:',
    '    return min(2 ** attempt, MAX_RETRY_SECONDS)',
  ),
  'fixture/src/dispatch.py': fixtureSource(
    'from .retry import bounded_retry_delay',
    '',
    'def dispatch_retry_in(failures: int) -> int:',
    '    return bounded_retry_delay(failures)',
  ),
  'fixture/src/retry_preview.py': fixtureSource(
    'def preview_retry_delay(attempt: int) -> int:',
    '    return 2 ** attempt',
  ),
  'fixture/tests/test_retry.py': fixtureSource(
    'from fixture.src.retry import bounded_retry_delay',
    '',
    'def test_retry_delay_stops_growing():',
    '    assert bounded_retry_delay(12) == 30',
  ),
  [moveSource]: fixtureSource('export const inventoryBannerAmber = "standard";'),
};

const editedBanner = fixtureSource(
  '// Revised display text',
  '',
  'export const inventoryBannerIndigo = "expanded";',
);

export function sourceAnchor(files: ReadonlyMap<string, string>, path: string, text: string) {
  const lines = files.get(path)?.split(/\r?\n/) ?? [];
  const indices = lines.flatMap((line, index) => (line.includes(text) ? [index + 1] : []));
  if (indices.length !== 1) throw new Error(`Expected one benchmark anchor in ${path}: ${text}`);
  return { path, startLine: indices[0]!, endLine: indices[0]! };
}

function lifecycleQuestion(id: string, query: string, expected: SourceRange[]): RetrievalQuestion {
  return { id, query, expected, source: 'fixture', group: 'lexical', category: 'lifecycle' };
}

/** Each mutation changes both the materialized corpus and its independent evidence labels. */
export function retrievalCorpus(repositoryFiles: ReadonlyMap<string, string>) {
  const files = new Map([...Object.entries(fixture), ...repositoryFiles]);
  const anchor = (path: string, text: string) => sourceAnchor(files, path, text);
  const ticketEvidence = [
    anchor('fixture/src/ledger.ts', 'export function allocateTicket('),
    anchor('fixture/src/cart.ts', 'return allocateTicket('),
    anchor('fixture/tests/ledger.test.ts', 'expect(allocateTicket('),
  ];
  const [workspace, filesystem, discovery, packaging] = repositoryFixturePaths;
  const retryCeiling = anchor(
    'fixture/src/retry.py',
    'return min(2 ** attempt, MAX_RETRY_SECONDS)',
  );
  const questions: RetrievalQuestion[] = [
    {
      id: 'exact-identifier',
      source: 'fixture',
      group: 'lexical',
      category: 'identifier',
      query: 'clampChannel',
      expected: [anchor('fixture/src/brightness.ts', 'export function clampChannel(')],
    },
    {
      id: 'color-bounds',
      source: 'fixture',
      group: 'conceptual',
      category: 'distractor',
      query: 'Where is a pixel intensity constrained to the legal eight-bit interval?',
      expected: [anchor('fixture/src/brightness.ts', 'Math.min(255, Math.max(0, n))')],
    },
    {
      id: 'claim-once',
      source: 'fixture',
      group: 'conceptual',
      category: 'concept',
      query: 'Which routine refuses to issue the same numbered permit twice?',
      expected: [anchor('fixture/src/ledger.ts', 'if (occupied.has(id))')],
    },
    {
      id: 'definition-caller-test',
      source: 'fixture',
      group: 'lexical',
      category: 'multi-file',
      query: 'allocateTicket',
      expected: ticketEvidence,
    },
    {
      id: 'deliberately-limited',
      source: 'fixture',
      group: 'lexical',
      category: 'limited',
      query: 'allocateTicket',
      limit: 1,
      expected: ticketEvidence,
    },
    {
      id: 'absent-identifier',
      source: 'fixture',
      group: 'lexical',
      category: 'answerless',
      query: 'serializeLunarEphemeris',
      expected: [],
    },
    {
      id: 'absent-concept',
      source: 'fixture',
      group: 'conceptual',
      category: 'answerless',
      query: 'Where do we validate credit card checksums?',
      expected: [],
    },
    {
      id: 'ltcook-map-implementation-and-caller',
      source: 'ltcook',
      group: 'lexical',
      category: 'multi-file',
      query: 'readRepositoryMap',
      expected: [
        anchor(filesystem, 'export async function readRepositoryMap('),
        anchor(discovery, 'const map = await readRepositoryMap('),
      ],
    },
    {
      id: 'ltcook-linked-target',
      source: 'ltcook',
      group: 'conceptual',
      category: 'concept',
      query: 'What forbids a junction from aliasing a requested location?',
      expected: [anchor(workspace, 'path.relative(absolute, actual) !==')],
    },
    {
      id: 'python-retry-definition-caller-test',
      source: 'fixture',
      group: 'lexical',
      category: 'multi-file',
      query: 'bounded_retry_delay',
      expected: [
        anchor('fixture/src/retry.py', 'def bounded_retry_delay('),
        anchor('fixture/src/dispatch.py', 'return bounded_retry_delay('),
        anchor('fixture/tests/test_retry.py', 'assert bounded_retry_delay('),
      ],
    },
    {
      id: 'python-retry-ceiling',
      source: 'fixture',
      group: 'conceptual',
      category: 'distractor',
      query: 'Where does the retry delay grow exponentially while staying under a maximum?',
      expected: [retryCeiling],
    },
    {
      id: 'python-retry-ceiling-de',
      source: 'fixture',
      group: 'conceptual',
      category: 'distractor',
      query: 'Wo wächst die Wartezeit für Wiederholungen exponentiell bis zu einer Obergrenze?',
      queryLanguage: 'de',
      expected: [retryCeiling],
    },
    {
      id: 'retry-cap-with-keywords',
      source: 'fixture',
      group: 'conceptual',
      category: 'keyword-overlap',
      query: 'Where is the retry attempt capped by the maximum retry seconds?',
      expected: [retryCeiling],
    },
    {
      id: 'occupied-ticket-with-keywords',
      source: 'fixture',
      group: 'conceptual',
      category: 'keyword-overlap',
      query: 'Where does issuing a ticket return false for an already occupied id?',
      expected: [anchor('fixture/src/ledger.ts', 'if (occupied.has(id))')],
    },
    {
      id: 'absent-retry-jitter',
      source: 'fixture',
      group: 'conceptual',
      category: 'answerless',
      query: 'Where does the retry delay add randomized jitter?',
      expected: [],
    },
    {
      id: 'ltcook-archive-link-protection',
      source: 'ltcook',
      group: 'conceptual',
      category: 'concept',
      query: 'Where does packaging reject symlinks in the archive destination or its parents?',
      expected: [anchor(packaging, 'if any(part.is_symlink() for part in (path, *path.parents))')],
    },
    lifecycleQuestion('before-edits', 'inventoryBannerAmber', [
      anchor(moveSource, 'inventoryBannerAmber'),
    ]),
  ];
  const edited = new Map(files).set(moveSource, editedBanner);
  const renamed = new Map(edited);
  renamed.delete(moveSource);
  renamed.set(moveDestination, editedBanner);
  return {
    files,
    questions,
    transitions: [
      {
        kind: 'modify' as const,
        path: moveSource,
        contents: editedBanner,
        questions: [
          lifecycleQuestion('shifted-and-edited', 'inventoryBannerIndigo', [
            sourceAnchor(edited, moveSource, 'inventoryBannerIndigo'),
          ]),
          lifecycleQuestion('superseded-text', 'inventoryBannerAmber', []),
        ],
      },
      {
        kind: 'rename' as const,
        path: moveSource,
        destination: moveDestination,
        questions: [
          lifecycleQuestion('new-path', 'inventoryBannerIndigo', [
            sourceAnchor(renamed, moveDestination, 'inventoryBannerIndigo'),
          ]),
        ],
      },
      {
        kind: 'delete' as const,
        path: moveDestination,
        questions: [lifecycleQuestion('deleted-text', 'inventoryBannerIndigo', [])],
      },
    ],
  };
}

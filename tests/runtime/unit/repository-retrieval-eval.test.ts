import { expect, test } from 'bun:test';
import {
  firstVerifiedCitationMs,
  gradeRepositoryCitations,
} from '../../../evals/repository-citations.js';
import {
  gradeRepositoryRetrieval,
  rankKeywordHits,
  retrievalKeywords,
  retrievalObservationFailed,
} from '../../../evals/repository-retrieval.js';
import type { RetrievalQuestion } from '../../../evals/repository-retrieval-fixtures.js';
import type { RepositoryRetrieval } from '../../../runtime/src/repository/results.js';

const files = new Map([
  ['src/ledger.ts', 'const extra = 0;\r\nexport function allocate() {\r\n  return 42;\r\n}\r\n'],
  ['test/ledger.ts', 'test("allocates", () => allocate());\n'],
  ['src/distractor.ts', 'export const allocatePreview = 0;\n'],
]);
const question: RetrievalQuestion = {
  id: 'definition-and-test',
  source: 'fixture',
  category: 'multi-file',
  group: 'lexical',
  query: 'allocate',
  expected: [
    { path: 'src/ledger.ts', startLine: 2, endLine: 2 },
    { path: 'test/ledger.ts', startLine: 1, endLine: 1 },
  ],
};

test('agent citations can combine adjacent verified hits but cannot span a gap', () => {
  const site = question.expected[0]!;
  const source = [
    { ...site, excerpt: 'export function allocate() {' },
    { ...site, startLine: 3, endLine: 3, excerpt: '  return 42;' },
  ];
  const adjacent = { ...site, path: `./${site.path}`, endLine: 3 };
  const gap = { ...site, endLine: 4 };
  expect(gradeRepositoryCitations([adjacent, gap], [site], source, files)).toEqual({
    supported: [{ ...site, endLine: 3 }],
    unsupported: [gap],
    missing: [],
  });
  expect(
    gradeRepositoryCitations(
      [adjacent],
      [site],
      [
        source[0]!,
        {
          ...source[1]!,
          excerpt: 'changed',
        },
      ],
      files,
    ),
  ).toMatchObject({ supported: [], missing: [site] });
});

test('citation timing uses reply completion and waits for every cited line', () => {
  const site = question.expected[0]!;
  const citation = { ...site, endLine: 3 };
  const declaration = { ...site, excerpt: 'export function allocate() {' };
  const body = { ...site, startLine: 3, endLine: 3, excerpt: '  return 42;' };
  const replies = [
    { elapsedMs: 30, hits: [body] },
    { elapsedMs: 10, hits: [{ ...body, excerpt: '  return 41;' }] },
    { elapsedMs: 20, hits: [declaration] },
  ];

  expect(firstVerifiedCitationMs([citation], [site], replies, files)).toBe(30);
  expect(firstVerifiedCitationMs([citation], [site], replies.slice(1), files)).toBeNull();
  expect(firstVerifiedCitationMs([], [site], replies, files)).toBeNull();
  expect(firstVerifiedCitationMs([citation], [], replies, files)).toBeNull();
});

function result(hits: RepositoryRetrieval['value']['hits']): RepositoryRetrieval {
  return {
    provider: 'fixture-provider',
    capturedAt: '2026-01-01T00:00:00.000Z',
    freshness: 'cached',
    diagnostics: [],
    partial: false,
    truncated: false,
    value: { kind: 'ranked', status: 'ready', hits },
  };
}

test('retrieval evaluation credits unique labeled ranges and uses the first relevant rank', () => {
  const definition = {
    path: 'src/ledger.ts',
    startLine: 2,
    endLine: 4,
    excerpt: 'export function allocate() {\n  return 42;\n}',
  };
  const retrieved = result([
    {
      path: 'src/distractor.ts',
      startLine: 1,
      endLine: 1,
      excerpt: 'export const allocatePreview = 0;',
    },
    definition,
    definition,
    {
      path: 'test/ledger.ts',
      startLine: 1,
      endLine: 1,
      excerpt: 'test("allocates", () => allocate());',
    },
  ]);
  expect(gradeRepositoryRetrieval(question, retrieved, files)).toMatchObject({
    recallAtK: 1,
    reciprocalRank: 0.5,
    expectedFilesFound: 2,
    falsePositives: 1,
    invalidEvidence: 0,
    missingEvidence: [],
  });
  retrieved.value.kind = 'exhaustive';
  retrieved.value.hits.pop();
  expect(gradeRepositoryRetrieval(question, retrieved, files)).toMatchObject({
    recallAtK: 0.5,
    reciprocalRank: null,
    missingEvidence: [question.expected[1]],
  });
});

test('retrieval evaluation rejects changed evidence, missing files, and invalid ranges', () => {
  const retrieved = result([
    { path: 'src/ledger.ts', startLine: 2, endLine: 2, excerpt: 'const oldValue = 1;' },
    { path: 'src/ledger.ts', startLine: 1, endLine: 1, excerpt: 'const extra = 0;' },
    {
      path: 'test/ledger.ts',
      startLine: 1,
      endLine: 3,
      excerpt: 'test("allocates", () => allocate());',
    },
    { path: 'src/deleted.ts', startLine: 1, endLine: 1, excerpt: 'const oldValue = 1;' },
  ]);
  retrieved.freshness = 'stale';
  retrieved.partial = true;
  retrieved.diagnostics.push({
    source: 'fixture-provider',
    code: 'source-changed',
    message: 'stale excerpt',
  });
  const grade = gradeRepositoryRetrieval(question, retrieved, files);
  expect(grade).toMatchObject({
    freshness: 'stale',
    diagnostics: [{ source: 'fixture-provider', code: 'source-changed' }],
    incomplete: true,
    expectedFilesFound: 1,
    recallAtK: 0,
    reciprocalRank: 0,
    falsePositives: 1,
    invalidEvidence: 3,
  });
  expect(retrievalObservationFailed(grade)).toBe(true);
  expect(
    grade.results.map(({ evidence, fileMatch, matches }) => ({ evidence, fileMatch, matches })),
  ).toEqual([
    { evidence: 'excerpt-mismatch', fileMatch: true, matches: [] },
    { evidence: 'valid', fileMatch: true, matches: [] },
    { evidence: 'invalid-range', fileMatch: true, matches: [] },
    { evidence: 'invalid-path', fileMatch: false, matches: [] },
  ]);
});

test('keyword retrieval ranks distinct query terms and retains scan order on ties', () => {
  const keywords = retrievalKeywords('Wo ist die RETRY-Wartezeit für Retry auf 30 begrenzt?');
  expect(keywords).toEqual(['retry', 'wartezeit', '30', 'begrenzt']);
  const first = { path: 'a.ts', startLine: 1, endLine: 1, excerpt: 'retry(); retry();' };
  const second = { path: 'b.py', startLine: 1, endLine: 1, excerpt: 'retry_interval = 30' };
  const third = { path: 'c.py', startLine: 1, endLine: 1, excerpt: 'retry_interval = 60' };
  expect(rankKeywordHits([first, second, third], keywords)).toEqual([second, first, third]);
});

test('an empty clipped excerpt fails evidence integrity', () => {
  const grade = gradeRepositoryRetrieval(
    question,
    result([
      { path: 'src/ledger.ts', startLine: 1, endLine: 1, excerpt: '', excerptTruncated: true },
    ]),
    files,
  );
  expect(grade.invalidEvidence).toBe(1);
  expect(retrievalObservationFailed(grade)).toBe(true);
});

test('the top-K budget limits recall without hiding invalid candidates', () => {
  const retrieved = result([
    { path: 'src/ledger.ts', startLine: 2, endLine: 2, excerpt: 'export function allocate() {' },
    {
      path: 'test/ledger.ts',
      startLine: 1,
      endLine: 1,
      excerpt: 'test("allocates", () => allocate());',
    },
  ]);
  const bounded = gradeRepositoryRetrieval(question, retrieved, files, 1);
  expect(bounded).toMatchObject({ recallAtK: 0.5, candidateCount: 2, incomplete: true });
  expect(bounded.results).toHaveLength(1);
  expect(retrievalObservationFailed(bounded)).toBe(false);

  retrieved.value.hits[1]!.excerpt = 'stale test text';
  const invalid = gradeRepositoryRetrieval(question, retrieved, files, 1);
  expect(invalid).toMatchObject({
    recallAtK: 0.5,
    status: 'ready',
    invalidEvidence: 1,
    invalidCandidates: [{ path: 'test/ledger.ts', evidence: 'excerpt-mismatch' }],
  });
  expect(retrievalObservationFailed(invalid)).toBe(true);
});

test('a truncated excerpt supports only the complete labeled lines it retains', () => {
  const retrieved = result([
    {
      path: 'src/ledger.ts',
      startLine: 1,
      endLine: 4,
      excerpt: 'const extra = 0;\nexport funct',
      excerptTruncated: true,
    },
  ]);
  retrieved.truncated = true;
  expect(gradeRepositoryRetrieval(question, retrieved, files)).toMatchObject({
    truncated: true,
    incomplete: true,
    invalidEvidence: 0,
    expectedFilesFound: 1,
    recallAtK: 0,
  });
  retrieved.value.hits[0]!.excerpt = 'const extra = 0;\nexport function allocate() {';
  expect(gradeRepositoryRetrieval(question, retrieved, files).recallAtK).toBe(0.5);
});

test('an answerless question requires a completed empty response', () => {
  const missing = { ...question, expected: [] };
  const retrieved = result([]);
  expect(gradeRepositoryRetrieval(missing, retrieved, files)).toMatchObject({
    cleanNegative: true,
    recallAtK: null,
    reciprocalRank: null,
  });
  for (const status of ['unavailable', 'indexing'] as const) {
    retrieved.value.status = status;
    const grade = gradeRepositoryRetrieval(missing, retrieved, files);
    expect(grade).toMatchObject({
      status,
      cleanNegative: false,
      incomplete: true,
    });
    expect(retrievalObservationFailed(grade)).toBe(true);
  }
});

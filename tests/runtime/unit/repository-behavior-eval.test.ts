import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Static } from 'typebox';
import {
  addVerifiedSourceLines,
  gradeRepositoryBehavior,
  searchesForCreditCardValidation,
  type RepositoryBehaviorAnswer,
} from '../../../evals/repository-behavior-grade.js';
import { allRequiredEvidenceMs } from '../../../evals/repository-citations.js';
import {
  repositoryTraversalCases,
  repositoryTraversalSnapshot,
} from '../../../evals/repository-traversal-fixtures.js';
import type { RepositoryHit } from '../../../runtime/src/repository/results.js';
import { repositorySearchStop } from '../../../evals/repository-behavior-pi.js';

const definition = { path: 'src/value.ts', startLine: 1, endLine: 1 };
const check = { path: 'test/value.ts', startLine: 1, endLine: 1 };
const expected = [
  { id: 'limit', value: 30, evidence: definition },
  { id: 'supported', value: true, evidence: check },
];
const source = 'export const maximumWait = 30;';
const testLine = 'expect(accepts(maximumWait)).toBe(true);';
const files = new Map([
  [definition.path, `${source}\n`],
  [check.path, `${testLine}\n`],
  ['src/preview.ts', 'export const previewWait = 30;\n'],
]);
const hits: RepositoryHit[] = [
  { ...definition, excerpt: source },
  { ...check, excerpt: testLine },
];
const complete = {
  status: 'ready',
  kind: 'exhaustive',
  freshness: 'current',
  partial: false,
  truncated: false,
  results: hits,
} as const;

test('Pi stops a completed repeat with the same evidence and allows new evidence', () => {
  const first = {
    finished: 1,
    requestKey: 'same',
    searches: [{ result: { status: 'ready', results: [hits[0]!] } }],
  } as const;
  expect(repositorySearchStop([first], 1, 1)).toBeUndefined();
  const repeat = [first, { ...first, finished: 2 }];
  expect(repositorySearchStop(repeat, 2, 1)).toBe('repeated-search');
  expect(repositorySearchStop(repeat, 2, 2)).toBeUndefined();
  expect(
    repositorySearchStop([first, { ...first, finished: 2, requestKey: 'different' }], 2, 1),
  ).toBeUndefined();
  expect(
    repositorySearchStop(
      [
        first,
        {
          ...first,
          finished: 2,
          searches: [{ result: complete }],
        },
      ],
      2,
      1,
    ),
  ).toBeUndefined();
});

test('Pi permits a fallback after one unavailable attempt and distinguishes indexing', () => {
  const unavailable = { finished: 1, searches: [{ result: { status: 'unavailable' } }] } as const;
  const indexing = { finished: 2, searches: [{ result: { status: 'indexing' } }] } as const;
  expect(repositorySearchStop([unavailable], 1, 1)).toBeUndefined();
  expect(repositorySearchStop([unavailable, indexing], 2, 1)).toBeUndefined();
  expect(repositorySearchStop([indexing, { ...unavailable, finished: 3 }], 2, 1)).toBeUndefined();
  expect(repositorySearchStop([unavailable, { ...unavailable, finished: 2 }], 2, 1)).toBe(
    'retrieval-unavailable',
  );
  const unavailablePair = [unavailable, { ...unavailable, finished: 3 }];
  expect(repositorySearchStop(unavailablePair, 2, 2)).toBe('retrieval-unavailable');
  expect(
    repositorySearchStop(
      [...unavailablePair, { finished: 2, searches: [{ result: complete }] }],
      3,
      3,
    ),
  ).toBeUndefined();
});

test('Pi stops repeat traversals only when they add no source evidence', () => {
  const initial = {
    searches: [],
    extraEvidence: [hits[0]!],
    requestKey: 'trace',
    finished: 1,
  };
  const repeat = { ...initial, finished: 2 };
  expect(repositorySearchStop([initial, repeat], 2, 1)).toBe('repeated-search');
  expect(repositorySearchStop([initial, { ...repeat, extraEvidence: hits }], 2, 1)).toBeUndefined();
  const empty = { ...initial, extraEvidence: [], traceStatus: 'ready' as const };
  expect(repositorySearchStop([empty, { ...empty, finished: 2 }], 2, 1)).toBe('repeated-search');
  const unavailable = { ...empty, traceStatus: 'unavailable' as const };
  expect(repositorySearchStop([unavailable, { ...unavailable, finished: 2 }], 2, 1)).toBe(
    'retrieval-unavailable',
  );
});

test('evidence completion requires verified source for every label', () => {
  const labels = [definition, check];
  const first = { elapsedMs: 5, hits: [hits[0]!] };
  const stale = { elapsedMs: 8, hits: [{ ...check, excerpt: 'expect(false).toBe(true);' }] };
  const second = { elapsedMs: 13, hits: [hits[1]!] };
  expect(allRequiredEvidenceMs(labels, [second, stale, first], files)).toBe(13);
  expect(allRequiredEvidenceMs(labels, [first, stale], files)).toBeNull();
  expect(allRequiredEvidenceMs([], [first, second], files)).toBeNull();
});

const checkout = path.resolve(import.meta.dir, '../../..');
test.skipIf(!Bun.which('git') || !existsSync(path.join(checkout, '.git')))(
  'traversal cases have source evidence in the committed archive and keep their labels outside it',
  async () => {
    const { files } = await repositoryTraversalSnapshot(checkout);
    const cases = repositoryTraversalCases(files);
    expect(cases.length).toBeGreaterThanOrEqual(3);
    for (const { expectedFacts } of cases)
      expect(new Set(expectedFacts.map(({ evidence }) => evidence.path)).size).toBeGreaterThan(2);
    expect([...files.keys()].some((file) => file.startsWith('evals/'))).toBe(false);
  },
);

test('Pi applies the safeguard when the native completions never reach the provider', () => {
  expect(repositorySearchStop([], 15, 1)).toBeUndefined();
  expect(repositorySearchStop([], 16, 1)).toBe('tool-budget');
  expect(repositorySearchStop([], 18, 3)).toBe('tool-budget');
});

type Answer = Static<typeof RepositoryBehaviorAnswer>;
const correct: Answer = {
  outcome: 'answered',
  facts: [
    { id: 'limit', value: 30, citations: [definition] },
    { id: 'supported', value: true, citations: [check] },
  ],
};

test('correct and adequately cited facts pass with incomplete retrieval and no prescribed mode', () => {
  expect(
    gradeRepositoryBehavior({
      answer: correct,
      expected,
      searches: [{ ...complete, freshness: 'stale', partial: true, truncated: true }],
      files,
    }),
  ).toMatchObject({
    factualCorrectness: 'correct',
    evidenceValidity: 'valid',
    taskSuccess: 'passed',
    retrieval: { expected: 2, covered: 2, recall: 1, reviewedEvidence: false },
  });
});

test('real labeled citations cannot pass incorrect, missing, or extra facts', () => {
  const wrong: Answer = {
    outcome: 'answered',
    facts: [
      { id: 'limit', value: 29, citations: [definition] },
      { id: 'supported', value: true, citations: [check] },
    ],
  };
  expect(
    gradeRepositoryBehavior({ answer: wrong, expected, searches: [complete], files }),
  ).toMatchObject({
    factualCorrectness: 'incorrect',
    evidenceValidity: 'valid',
    taskSuccess: 'failed',
  });
  const duplicate = { ...correct, facts: [...correct.facts, ...correct.facts] };
  const extra = {
    ...correct,
    facts: [...correct.facts, { id: 'unasked', value: true, citations: [check] }],
  };
  for (const answer of [duplicate, extra, { ...correct, facts: correct.facts.slice(1) }]) {
    expect(
      gradeRepositoryBehavior({ answer, expected, searches: [complete], files }),
    ).toMatchObject({
      factualCorrectness: 'incorrect',
      taskSuccess: 'failed',
    });
  }
});

test('a claim needs its own evidence and cannot borrow the evidence cited for a different fact', () => {
  const swapped: Answer = {
    outcome: 'answered',
    facts: [
      { id: 'limit', value: 30, citations: [check] },
      { id: 'supported', value: true, citations: [definition] },
    ],
  };
  expect(
    gradeRepositoryBehavior({ answer: swapped, expected, searches: [complete], files }),
  ).toMatchObject({
    factualCorrectness: 'correct',
    evidenceValidity: 'unverified',
    taskSuccess: 'unverified',
    retrieval: { recall: 1 },
  });
});

test('same-file adjacent lines remain distinct evidence for each fact', () => {
  const path = 'src/retries.ts';
  const stable = { path, startLine: 1, endLine: 1 };
  const preview = { path, startLine: 2, endLine: 2 };
  const excerpt = 'const stableRetries = 12;\nconst previewRetries = 48;';
  const answer: Answer = {
    outcome: 'answered',
    facts: [
      { id: 'stable', value: 12, citations: [preview] },
      { id: 'preview', value: 48, citations: [stable] },
    ],
  };
  expect(
    gradeRepositoryBehavior({
      answer,
      expected: [
        { id: 'stable', value: 12, evidence: stable },
        { id: 'preview', value: 48, evidence: preview },
      ],
      searches: [{ ...complete, results: [{ path, startLine: 1, endLine: 2, excerpt }] }],
      files: new Map([[path, `${excerpt}\n`]]),
    }),
  ).toMatchObject({
    factualCorrectness: 'correct',
    taskSuccess: 'unverified',
    factGrades: [
      { id: 'stable', citedExpectedRange: false },
      { id: 'preview', citedExpectedRange: false },
    ],
    retrieval: { recall: 1 },
  });
});

test('stale source output is an integrity failure even when separate valid evidence supports the answer', () => {
  const staleHit = { ...definition, excerpt: 'export const maximumWait = 60;' };
  const results = [staleHit, ...hits];
  expect(
    gradeRepositoryBehavior({
      answer: correct,
      expected,
      searches: [{ ...complete, results }],
      files,
    }),
  ).toMatchObject({
    taskSuccess: 'passed',
    evidenceValidity: 'valid',
    retrieval: { invalidEvidence: 1 },
  });
  expect(
    gradeRepositoryBehavior({
      answer: correct,
      expected,
      searches: [{ ...complete, results: [staleHit, hits[1]!] }],
      files,
    }),
  ).toMatchObject({
    factualCorrectness: 'correct',
    evidenceValidity: 'invalid',
    taskSuccess: 'failed',
    retrieval: { invalidEvidence: 1, recall: 0.5 },
  });
});

test('negative answers distinguish reviewed irrelevant evidence and unavailable retrieval', () => {
  const results = [
    { path: 'src/preview.ts', startLine: 1, endLine: 1, excerpt: 'export const previewWait = 30;' },
  ];
  const ranked = {
    ...complete,
    kind: 'ranked',
    freshness: 'cached',
    truncated: true,
    relevantToNegative: true,
    results,
  } as const;
  const negative: Answer = { outcome: 'not-found', facts: [] };
  const insufficient: Answer = { outcome: 'insufficient-evidence', facts: [] };
  expect(
    gradeRepositoryBehavior({ answer: negative, expected: [], searches: [ranked], files }),
  ).toMatchObject({
    factualCorrectness: 'correct',
    evidenceValidity: 'valid',
    taskSuccess: 'passed',
    retrieval: { recall: null, reviewedEvidence: true },
  });
  expect(
    gradeRepositoryBehavior({
      answer: negative,
      expected: [],
      searches: [{ ...complete, results: [], relevantToNegative: false }],
      files,
    }),
  ).toMatchObject({
    evidenceValidity: 'unverified',
    taskSuccess: 'unverified',
    retrieval: { reviewedEvidence: false },
  });
  for (const answer of [negative, insufficient]) {
    expect(
      gradeRepositoryBehavior({
        answer,
        expected: [],
        searches: [{ ...complete, status: 'unavailable', results: [] }],
        files,
      }),
    ).toMatchObject({
      answerOutcome: answer.outcome,
      evidenceValidity: 'unverified',
      taskSuccess: 'unverified',
    });
  }
  expect(
    gradeRepositoryBehavior({ answer: insufficient, expected, searches: [], files }),
  ).toMatchObject({ factualCorrectness: 'unverified', taskSuccess: 'unverified' });
  expect(
    gradeRepositoryBehavior({ answer: correct, expected: [], searches: [ranked], files }),
  ).toMatchObject({ factualCorrectness: 'incorrect', taskSuccess: 'failed' });
});

test('negative fixture relevance can be established without prescribing a search mode', () => {
  expect(
    searchesForCreditCardValidation('Does this repository validate credit card checksums?'),
  ).toBe(true);
  expect(searchesForCreditCardValidation('validateCreditCardChecksum')).toBe(true);
  expect(searchesForCreditCardValidation('luhn')).toBe(true);
  expect(searchesForCreditCardValidation('computeReleaseChecksum')).toBe(false);
  expect(searchesForCreditCardValidation('allocateTicket')).toBe(false);
});

test('only new, complete verified lines count toward the tool yield', () => {
  const seen = new Set<string>();
  expect(addVerifiedSourceLines(seen, [hits[0]!, hits[0]!], files)).toBe(1);
  expect(
    addVerifiedSourceLines(
      seen,
      [
        { ...hits[1]!, excerpt: testLine.slice(0, 12), excerptTruncated: true },
        { ...hits[0]!, excerpt: 'stale' },
      ],
      files,
    ),
  ).toBe(0);
  expect(addVerifiedSourceLines(seen, hits, files)).toBe(1);
});

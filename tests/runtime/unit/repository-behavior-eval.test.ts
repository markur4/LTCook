import { expect, test } from 'bun:test';
import type { Static } from 'typebox';
import {
  addVerifiedSourceLines,
  gradeRepositoryBehavior,
  type RepositoryBehaviorAnswer,
} from '../../../evals/repository-behavior-grade.js';
import type { RepositoryHit } from '../../../runtime/src/repository/results.js';

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

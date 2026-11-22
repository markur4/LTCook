import { expect, test } from 'bun:test';
import {
  createSummarizeTool,
  SUMMARY_MAX_INPUT_BYTES,
  summaryInputLimit,
} from '../../../runtime/src/tools/summarize.js';
import {
  CORE_SUMMARIZATION_CASES,
  DOWNSTREAM_CASE,
  fullSummarizationCases,
  SUMMARIZATION_CALIBRATION,
} from '../../../runtime/src/evals/summarization-fixtures.js';
import {
  calibrationMatches,
  gradingModelsIndependent,
  validateSummaryGrade,
} from '../../../runtime/src/evals/summarization-grader.js';
import {
  missingExactFacts,
  qualificationVerdict,
} from '../../../runtime/src/evals/summarization.js';

test('fixture requirements fit the real tool input budget and cite their source', () => {
  const cases = [
    ...CORE_SUMMARIZATION_CASES,
    ...fullSummarizationCases(SUMMARY_MAX_INPUT_BYTES),
    DOWNSTREAM_CASE,
  ];
  expect(new Set(cases.map(({ id }) => id)).size).toBe(cases.length);
  for (const fixture of cases) {
    expect(Buffer.byteLength(fixture.source)).toBeLessThanOrEqual(SUMMARY_MAX_INPUT_BYTES);
    expect(new Set(fixture.facts.map(({ id }) => id)).size).toBe(fixture.facts.length);
    for (const fact of fixture.facts) {
      expect(fixture.source).toContain(fact.sourceQuote);
      expect(fact.statement.length).toBeGreaterThan(0);
    }
  }
  const nearLimit = fullSummarizationCases(SUMMARY_MAX_INPUT_BYTES).find(
    ({ id }) => id === 'near-limit-exception',
  )!;
  expect(Buffer.byteLength(nearLimit.source)).toBeGreaterThanOrEqual(SUMMARY_MAX_INPUT_BYTES - 4);
  expect(nearLimit.source.indexOf(nearLimit.facts[0]!.sourceQuote)).toBeGreaterThan(
    SUMMARY_MAX_INPUT_BYTES / 3,
  );
});

test('exact-missing checks catch changed names, paths and numeric lookalikes', () => {
  const migration = CORE_SUMMARIZATION_CASES.find(({ id }) => id === 'migration-failure')!;
  expect(missingExactFacts(migration, migration.source)).toEqual([]);
  expect(
    missingExactFacts(
      migration,
      'M-04 failed with exit 123 in ops/db.py.bak. Ynez decided to wait.',
    ).map(({ fact, values }) => ({ fact, values })),
  ).toEqual([
    { fact: 'migration-failed', values: ['ops/db.py', '23'] },
    { fact: 'decision', values: ['Inez'] },
  ]);
  expect(
    missingExactFacts(
      migration,
      'M-04 passed with exit code 23 in ops/db.py. Inez decided to wait.',
    ),
  ).toEqual([]);
});

test('grade evidence permits absent text for omissions and inventions and rejects fabricated quotations', () => {
  const example = SUMMARIZATION_CALIBRATION.find(({ id }) => id === 'negation-and-missing-fact')!;
  const grade = {
    facts: [
      {
        id: 'no-deletion',
        verdict: 'contradicted',
        sourceQuote: 'No artifacts were deleted.',
        summaryQuote: 'The artifacts were deleted.',
      },
      {
        id: 'move',
        verdict: 'preserved',
        sourceQuote: example.document.facts[1]!.sourceQuote,
        summaryQuote: 'Ada moved 3 files to reports/weekly.',
      },
      {
        id: 'issue',
        verdict: 'missing',
        sourceQuote: example.document.facts[2]!.sourceQuote,
        summaryQuote: null,
      },
    ],
    claims: [
      {
        verdict: 'contradicted',
        sourceQuote: 'No artifacts were deleted.',
        summaryQuote: 'The artifacts were deleted.',
      },
      {
        verdict: 'supported',
        sourceQuote: example.document.facts[1]!.sourceQuote,
        summaryQuote: 'Ada moved 3 files to reports/weekly.',
      },
    ],
  };
  const validated = validateSummaryGrade(grade, example.document, example.summary);
  expect(calibrationMatches(validated, example)).toBe(true);
  expect(
    calibrationMatches(
      { ...validated, facts: validated.facts.map((item) => ({ ...item, verdict: 'preserved' })) },
      example,
    ),
  ).toBe(false);
  expect(() =>
    validateSummaryGrade(
      {
        ...grade,
        facts: [
          { ...grade.facts[0], sourceQuote: example.document.facts[1]!.sourceQuote },
          ...grade.facts.slice(1),
        ],
      },
      example.document,
      example.summary,
    ),
  ).toThrow('unsupported fact citation');
  expect(() =>
    validateSummaryGrade(
      { ...grade, claims: [{ ...grade.claims[0], sourceQuote: 'Deletion was approved.' }] },
      example.document,
      example.summary,
    ),
  ).toThrow('invalid evidence');
  expect(() =>
    validateSummaryGrade(
      { ...grade, facts: grade.facts.slice(1) },
      example.document,
      example.summary,
    ),
  ).toThrow('omitted a required fact');
  expect(() =>
    validateSummaryGrade(
      {
        ...grade,
        claims: [
          {
            verdict: 'unsupported',
            summaryQuote: 'The artifacts were deleted.',
            sourceQuote: null,
          },
        ],
      },
      example.document,
      example.summary,
    ),
  ).not.toThrow();
  expect(() =>
    validateSummaryGrade(
      { ...grade, claims: [{ ...grade.claims[0], verdict: 'unsupported' }] },
      example.document,
      example.summary,
    ),
  ).toThrow('invalid evidence');
});

test('held-out calibration requires finding the actual unsupported claim', () => {
  const example = SUMMARIZATION_CALIBRATION.find(({ id }) => id === 'unsupported-material-claim')!;
  const draft = {
    facts: example.document.facts.map(({ id, sourceQuote }) => ({
      id,
      verdict: 'preserved',
      sourceQuote,
      summaryQuote:
        id === 'correction'
          ? 'The network was ruled out, and the cause is unknown.'
          : 'Kim proposed a retry, which Ada did not approve.',
    })),
    claims: [{ verdict: 'unsupported', summaryQuote: 'The incident cost $50,000.' }],
  };
  const correct = validateSummaryGrade(draft, example.document, example.summary);
  expect(calibrationMatches(correct, example)).toBe(true);
  const misplaced = validateSummaryGrade(
    { ...draft, claims: [{ verdict: 'unsupported', summaryQuote: 'The network was ruled out' }] },
    example.document,
    example.summary,
  );
  expect(calibrationMatches(misplaced, example)).toBe(false);
});

test('qualification keeps confirmed failures ahead of blocked checks and requires independent weights', () => {
  expect(qualificationVerdict(['passed', 'blocked', 'failed'])).toBe('failed');
  expect(qualificationVerdict(['passed', 'blocked'])).toBe('blocked');
  expect(qualificationVerdict([])).toBe('blocked');
  expect(qualificationVerdict(['passed', 'passed'])).toBe('passed');
  const candidate = { name: 'candidate:latest', digest: 'manifest-1', weightsDigest: 'model-1' };
  expect(
    gradingModelsIndependent(candidate, { ...candidate, name: 'alias', digest: 'manifest-2' }),
  ).toBe(false);
  expect(gradingModelsIndependent(candidate, { name: 'other', digest: 'manifest-2' })).toBe(false);
  expect(
    gradingModelsIndependent(candidate, {
      name: 'other',
      digest: 'manifest-2',
      weightsDigest: 'model-2',
    }),
  ).toBe(true);
});

test('oversized input is rejected before inference with a reduced generation context', async () => {
  const generation = {
    think: false,
    options: { num_ctx: 4096, num_predict: 128, temperature: 0.1 },
  };
  const focus = 'Preserve operational outcomes.';
  const limit = summaryInputLimit(generation, focus);
  expect(limit).toBeLessThan(4096 - 128);
  expect(limit).toBeLessThan(summaryInputLimit(generation));
  const tool = createSummarizeTool({
    model: 'fixture-model',
    endpoint: 'http://127.0.0.1:0',
    keepAlive: 0,
    generation: JSON.stringify(generation),
  });
  await expect(
    tool.execute(
      { text: 'a'.repeat(limit + 1), focus },
      {
        agentId: 'fixture',
        workspaceRoot: process.cwd(),
        workspaceFileAccess: false,
        signal: new AbortController().signal,
      },
    ),
  ).rejects.toThrow('exceeds the ' + limit + ' byte limit');
});

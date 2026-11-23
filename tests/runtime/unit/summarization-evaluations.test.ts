import { expect, test } from 'bun:test';
import {
  createSummarizeTool,
  SUMMARY_MAX_INPUT_BYTES,
  summaryInputLimit,
} from '../../../runtime/src/tools/summarize.js';
import {
  CODING_SESSION_CASE,
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

test('ticket hyphens are interchangeable only in the designated whole ticket ID', () => {
  const nearLimit = fullSummarizationCases(SUMMARY_MAX_INPUT_BYTES).find(
    ({ id }) => id === 'near-limit-exception',
  )!;
  const fact = nearLimit.facts[0]!;
  for (const id of ['AUTH-17', 'AUTH\u201017', 'AUTH\u201117']) {
    expect(missingExactFacts(nearLimit, fact.sourceQuote.replace('AUTH-17', id))).toEqual([]);
  }
  for (const id of ['AUTH-71', 'AUTH\u201317', 'PRE-AUTH\u201117', 'AUTH\u201117-1']) {
    expect(missingExactFacts(nearLimit, fact.sourceQuote.replace('AUTH-17', id))).toMatchObject([
      { values: ['AUTH-17'] },
    ]);
  }
  const migration = CORE_SUMMARIZATION_CASES.find(({ id }) => id === 'migration-failure')!;
  expect(missingExactFacts(migration, migration.source.replace('M-04', 'M\u201104'))).toMatchObject(
    [{ values: ['M-04'] }],
  );
  const changedPath = CODING_SESSION_CASE.source.replace('reconcile-cache', 'reconcile\u2011cache');
  expect(missingExactFacts(CODING_SESSION_CASE, changedPath)).toMatchObject([
    { values: ['tests/package/reconcile-cache.test.ts'] },
  ]);
});

test('the grader can cite a normalized ticket while the report preserves the original hyphen', () => {
  const nearLimit = fullSummarizationCases(SUMMARY_MAX_INPUT_BYTES).find(
    ({ id }) => id === 'near-limit-exception',
  )!;
  const { id, sourceQuote } = nearLimit.facts[0]!;
  const grade = {
    facts: [{ id, verdict: 'preserved', sourceQuote, summaryQuote: sourceQuote }],
    claims: [{ verdict: 'supported', sourceQuote, summaryQuote: sourceQuote }],
  };
  const summary = sourceQuote.replace('AUTH-17', 'AUTH\u201117');
  const result = validateSummaryGrade(grade, nearLimit, summary);
  expect(result.facts[0]?.summaryQuote).toBe(summary);
  expect(result.claims[0]?.summaryQuote).toBe(summary);
  expect(() => validateSummaryGrade(grade, nearLimit, summary.replace('17', '71'))).toThrow(
    'invalid summary evidence',
  );
});

test('the grader can cite an emphasized Markdown label without its markers', () => {
  const nearLimit = fullSummarizationCases(SUMMARY_MAX_INPUT_BYTES).find(
    ({ id }) => id === 'near-limit-exception',
  )!;
  const { id, sourceQuote } = nearLimit.facts[0]!;
  const summary = sourceQuote + '\n- *Ticket status:* blocked';
  const grade = {
    facts: [{ id, verdict: 'preserved', sourceQuote, summaryQuote: sourceQuote }],
    claims: [{ verdict: 'supported', sourceQuote, summaryQuote: 'Ticket status: blocked' }],
  };
  expect(validateSummaryGrade(grade, nearLimit, summary).claims[0]?.summaryQuote).toBe(
    'Ticket status:* blocked',
  );
  expect(() =>
    validateSummaryGrade(
      grade,
      nearLimit,
      summary.replace('status:* blocked', 'status:* approved'),
    ),
  ).toThrow('invalid evidence for a material claim');
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
  ).toThrow('material claim (1, source) · "Deletion was approved."');
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

test('citations with Markdown, wrapping and typographic spacing retain the exact summary excerpt', () => {
  const [scope, decision] = DOWNSTREAM_CASE.facts;
  const formattedScope = scope!.sourceQuote.replace(
    'read-only smoke checks',
    '**read-only\nsmoke\u202fchecks**',
  );
  const decisionQuote = decision!.sourceQuote;
  const wrapped = decisionQuote.replace('. Inez', '.  \n3. Inez');
  const summary = '1. ' + formattedScope + '  \n2. ' + wrapped;
  const grade = {
    facts: [
      {
        id: scope!.id,
        verdict: 'preserved',
        sourceQuote: scope!.sourceQuote,
        summaryQuote: scope!.sourceQuote,
      },
      {
        id: decision!.id,
        verdict: 'preserved',
        sourceQuote: decisionQuote,
        summaryQuote: decisionQuote,
      },
    ],
    claims: [{ verdict: 'supported', sourceQuote: decisionQuote, summaryQuote: decisionQuote }],
  };
  const result = validateSummaryGrade(grade, DOWNSTREAM_CASE, summary);
  expect(result.facts[0]?.summaryQuote).toBe(formattedScope);
  expect(result.facts[1]?.summaryQuote).toBe(wrapped);
  expect(result.claims[0]?.summaryQuote).toBe(wrapped);
  expect(() =>
    validateSummaryGrade(grade, DOWNSTREAM_CASE, summary.replace('declined', 'approved')),
  ).toThrow('invalid summary evidence for a required fact (decision)');
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

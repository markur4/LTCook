import { Type, type Static } from 'typebox';
import type { RepositoryHit } from '../runtime/src/repository/results.js';
import type { RepositorySearchOutputSchema } from '../runtime/src/tools/repo-search.js';
import { gradeRepositoryCitations } from './repository-citations.js';
import type { SourceRange } from './repository-retrieval-fixtures.js';
import { checkRetrievedEvidence } from './repository-retrieval.js';

export const RepositoryCitation = Type.Object(
  { path: Type.String(), startLine: Type.Integer(), endLine: Type.Integer() },
  { additionalProperties: false },
);

const FactValue = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

export const RepositoryBehaviorAnswer = Type.Object(
  {
    outcome: Type.Union([
      Type.Literal('answered'),
      Type.Literal('not-found'),
      Type.Literal('insufficient-evidence'),
    ]),
    facts: Type.Array(
      Type.Object(
        { id: Type.String(), value: FactValue, citations: Type.Array(RepositoryCitation) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type ExpectedRepositoryFact = {
  id: string;
  value: Static<typeof FactValue>;
  evidence: SourceRange;
};

type ObservedSearch = Pick<
  Static<typeof RepositorySearchOutputSchema>,
  'status' | 'kind' | 'freshness' | 'partial' | 'truncated' | 'results'
> & { relevantToNegative?: boolean };

/** Check whether the negative fixture's search addresses card validation. */
export function searchesForCreditCardValidation(query: string): boolean {
  const normalized = query
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  return (
    /\bluhn\b/.test(normalized) ||
    (/\b(?:card|pan)\b/.test(normalized) &&
      /\b(?:checksums?|validat\w*|check digits?)\b/.test(normalized))
  );
}

export function gradeRepositoryBehavior({
  answer,
  expected,
  searches,
  files,
  extraEvidence = [],
}: {
  answer: Static<typeof RepositoryBehaviorAnswer> | undefined;
  expected: readonly ExpectedRepositoryFact[];
  searches: readonly ObservedSearch[];
  files: ReadonlyMap<string, string>;
  extraEvidence?: readonly RepositoryHit[];
}) {
  const hits = [...searches.flatMap((search) => search.results ?? []), ...extraEvidence];
  const readyHits = [
    ...searches.flatMap((search) => (search.status === 'ready' ? (search.results ?? []) : [])),
    ...extraEvidence,
  ];
  const factGrades = expected.map(({ id, value, evidence }) => {
    const claims = answer?.facts.filter((fact) => fact.id === id) ?? [];
    const citations = gradeRepositoryCitations(
      claims.flatMap((claim) => claim.citations),
      [evidence],
      readyHits,
      files,
    );
    return {
      id,
      correct: claims.length === 1 && claims[0]?.value === value,
      citedExpectedRange: !citations.missing.length,
    };
  });
  const unexpectedFacts =
    answer?.facts.filter((fact) => !expected.some(({ id }) => id === fact.id)).length ?? 0;
  const citations = gradeRepositoryCitations(
    answer?.facts.flatMap((fact) => fact.citations) ?? [],
    [],
    readyHits,
    files,
  );
  const invalidHits = hits.filter((hit) => checkRetrievedEvidence(hit, files).status !== 'valid');
  const unsupported = citations.unsupported;
  const labeledRanges = [
    ...new Map(
      expected.map(({ evidence }) => [
        JSON.stringify([evidence.path, evidence.startLine, evidence.endLine]),
        evidence,
      ]),
    ).values(),
  ];
  const retrieved = gradeRepositoryCitations(labeledRanges, labeledRanges, readyHits, files);
  const reviewedEvidence = searches.some(
    (search) =>
      search.status === 'ready' &&
      (expected.length > 0 || search.relevantToNegative === true) &&
      (search.freshness === 'current' || search.freshness === 'cached') &&
      !search.partial &&
      (search.kind === 'ranked' || !search.truncated) &&
      (search.results ?? []).every((hit) => !invalidHits.includes(hit)),
  );

  const affirmative = answer?.outcome === 'answered';
  const abstained = Boolean(answer && !affirmative && !answer.facts.length);
  const factValuesMatch = !unexpectedFacts && factGrades.every(({ correct }) => correct);
  const factualCorrectness = !answer
    ? 'unverified'
    : expected.length
      ? affirmative
        ? factValuesMatch
          ? 'correct'
          : 'incorrect'
        : abstained
          ? 'unverified'
          : 'incorrect'
      : abstained
        ? 'correct'
        : 'incorrect';
  const evidenceValidity = unsupported.length
    ? 'invalid'
    : expected.length
      ? affirmative && factGrades.every(({ citedExpectedRange }) => citedExpectedRange)
        ? 'valid'
        : 'unverified'
      : abstained && answer?.outcome === 'not-found' && reviewedEvidence
        ? 'valid'
        : 'unverified';
  const taskSuccess =
    factualCorrectness === 'incorrect' || evidenceValidity === 'invalid'
      ? 'failed'
      : factualCorrectness === 'correct' && evidenceValidity === 'valid'
        ? 'passed'
        : 'unverified';
  return {
    taskSuccess,
    factualCorrectness,
    evidenceValidity,
    answerOutcome: answer?.outcome ?? null,
    factGrades,
    unexpectedFacts,
    unsupportedCitations: unsupported,
    citations: citations.supported,
    retrieval: {
      expected: labeledRanges.length,
      covered: labeledRanges.length - retrieved.missing.length,
      recall: labeledRanges.length ? 1 - retrieved.missing.length / labeledRanges.length : null,
      missing: retrieved.missing,
      invalidEvidence: invalidHits.length,
      reviewedEvidence,
    },
  };
}

/** Count current, complete source lines newly shown by a finished reply. */
export function addVerifiedSourceLines(
  seen: Set<string>,
  hits: readonly RepositoryHit[],
  files: ReadonlyMap<string, string>,
): number {
  const before = seen.size;
  for (const hit of hits) {
    const evidence = checkRetrievedEvidence(hit, files);
    if (evidence.status !== 'valid') continue;
    for (let line = hit.startLine; line <= evidence.throughLine; line++)
      seen.add(JSON.stringify([hit.path, line]));
  }
  return seen.size - before;
}

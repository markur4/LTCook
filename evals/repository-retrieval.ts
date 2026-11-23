import type { RepositoryHit, RepositoryRetrieval } from '../runtime/src/repository/results.js';
import type { RetrievalQuestion } from './repository-retrieval-fixtures.js';

const keywordStopWords = new Set(
  (
    'a an and are as at be by can do does for from how in is it of on or that the this to we what when where which who with ' +
    'auf aus bis das dem den der die ein eine einer für im in ist mit nach oder und von was welche wie wo zu'
  ).split(' '),
);

/** Extract a bounded set of distinct query words for a case-insensitive ripgrep candidate scan. */
export function retrievalKeywords(query: string): string[] {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
  const keywords = words.filter((word) => !keywordStopWords.has(word));
  return (keywords.length ? keywords : words).slice(0, 12);
}

/** Rank lexical candidates by distinct keyword overlap, retaining scan order on ties. */
export function rankKeywordHits(hits: readonly RepositoryHit[], keywords: readonly string[]) {
  return hits
    .map((hit) => {
      const text = hit.excerpt.toLowerCase();
      return { hit, score: keywords.filter((word) => text.includes(word)).length };
    })
    .sort((left, right) => right.score - left.score)
    .map(({ hit }) => hit);
}

type EvidenceCheck =
  | { status: 'valid'; throughLine: number }
  | { status: 'invalid-path' | 'invalid-range' | 'excerpt-mismatch' };

export function checkRetrievedEvidence(
  hit: RepositoryHit,
  files: ReadonlyMap<string, string>,
): EvidenceCheck {
  const source = files.get(hit.path);
  if (source === undefined) return { status: 'invalid-path' };
  const lines = source
    .replace(/^\uFEFF/, '')
    .replace(/\r?\n$/, '')
    .split(/\r?\n/);
  if (
    !Number.isSafeInteger(hit.startLine) ||
    !Number.isSafeInteger(hit.endLine) ||
    hit.startLine < 1 ||
    hit.endLine < hit.startLine ||
    hit.endLine > lines.length
  ) {
    return { status: 'invalid-range' };
  }
  const expected = lines.slice(hit.startLine - 1, hit.endLine).join('\n');
  if (!hit.excerptTruncated && hit.excerpt === expected) {
    return { status: 'valid', throughLine: hit.endLine };
  }
  if (
    hit.excerptTruncated &&
    hit.excerpt.length > 0 &&
    hit.excerpt.length < expected.length &&
    expected.startsWith(hit.excerpt)
  ) {
    // > A clipped excerpt supports only the complete lines still present in it.
    const completeLines =
      hit.excerpt.split('\n').length - Number(!expected.startsWith(`${hit.excerpt}\n`));
    return { status: 'valid', throughLine: hit.startLine + completeLines - 1 };
  }
  return { status: 'excerpt-mismatch' };
}

/** Score returned evidence against the fixture snapshot independently of provider verification. */
export function gradeRepositoryRetrieval(
  question: RetrievalQuestion,
  result: RepositoryRetrieval,
  files: ReadonlyMap<string, string>,
  k = result.value.hits.length,
) {
  const { expected } = question;
  const { status, kind, hits } = result.value;
  const matched = new Set<number>();
  const foundPaths = new Set<string>();
  const candidates = hits.map((hit, index) => {
    const evidence = checkRetrievedEvidence(hit, files);
    const matches: number[] = [];
    const fileMatch = expected.some(({ path }) => path === hit.path);
    if (index < k && evidence.status === 'valid') {
      if (fileMatch) foundPaths.add(hit.path);
      expected.forEach(({ path, startLine, endLine }, index) => {
        if (path === hit.path && hit.startLine <= startLine && evidence.throughLine >= endLine) {
          matched.add(index);
          matches.push(index);
        }
      });
    }
    return {
      path: files.has(hit.path) ? hit.path : null,
      startLine: hit.startLine,
      endLine: hit.endLine,
      evidence: evidence.status,
      fileMatch,
      matches,
    };
  });
  const results = candidates.slice(0, k);
  const invalidCandidates = candidates.filter(({ evidence }) => evidence !== 'valid');
  const firstRelevant = results.findIndex(({ matches }) => matches.length > 0);
  const truncated = result.truncated || candidates.length > k;
  const incomplete = status !== 'ready' || result.partial || truncated;
  return {
    status,
    kind,
    capturedAt: result.capturedAt,
    freshness: result.freshness,
    diagnostics: result.diagnostics.map(({ source, code }) => ({ source, code })),
    partial: result.partial,
    truncated,
    incomplete,
    resultBytes: Buffer.byteLength(
      JSON.stringify({ ...result, truncated, value: { ...result.value, hits: hits.slice(0, k) } }),
    ),
    candidateCount: candidates.length,
    candidateResultBytes: Buffer.byteLength(JSON.stringify(result)),
    providerTruncated: result.truncated,
    results,
    falsePositives: results.filter(
      ({ matches, evidence }) => evidence === 'valid' && !matches.length,
    ).length,
    invalidEvidence: invalidCandidates.length,
    invalidCandidates,
    expectedFilesFound: foundPaths.size,
    missingEvidence: expected.filter((_, index) => !matched.has(index)),
    recallAtK: expected.length ? matched.size / expected.length : null,
    reciprocalRank:
      kind === 'ranked' && expected.length
        ? firstRelevant >= 0
          ? 1 / (firstRelevant + 1)
          : 0
        : null,
    cleanNegative: expected.length ? null : !incomplete && hits.length === 0,
  };
}

/** Treat invalid evidence as an integrity failure even when the provider was ready. */
export function retrievalObservationFailed({
  status,
  invalidEvidence,
}: Pick<ReturnType<typeof gradeRepositoryRetrieval>, 'status' | 'invalidEvidence'>): boolean {
  return status !== 'ready' || invalidEvidence > 0;
}

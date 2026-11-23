import type { RepositoryHit, RepositoryRetrieval } from '../runtime/src/repository/results.js';
import type { RetrievalQuestion } from './repository-retrieval-fixtures.js';

type EvidenceCheck =
  | { status: 'valid'; throughLine: number }
  | { status: 'invalid-path' | 'invalid-range' | 'excerpt-mismatch' };

function checkEvidence(hit: RepositoryHit, files: ReadonlyMap<string, string>): EvidenceCheck {
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
) {
  const { expected } = question;
  const { status, kind, hits } = result.value;
  const matched = new Set<number>();
  const foundPaths = new Set<string>();
  const results = hits.map((hit) => {
    const evidence = checkEvidence(hit, files);
    const matches: number[] = [];
    const fileMatch = expected.some(({ path }) => path === hit.path);
    if (evidence.status === 'valid') {
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
  const firstRelevant = results.findIndex(({ matches }) => matches.length > 0);
  const incomplete = status !== 'ready' || result.partial || result.truncated;
  return {
    status,
    kind,
    capturedAt: result.capturedAt,
    freshness: result.freshness,
    diagnostics: result.diagnostics.map(({ source, code }) => ({ source, code })),
    partial: result.partial,
    truncated: result.truncated,
    incomplete,
    resultBytes: Buffer.byteLength(JSON.stringify(result)),
    results,
    falsePositives: results.filter(({ matches }) => matches.length === 0).length,
    invalidEvidence: results.filter(({ evidence }) => evidence !== 'valid').length,
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

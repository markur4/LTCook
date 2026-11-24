import type { RepositoryHit } from '../runtime/src/repository/results.js';
import type { SourceRange } from './repository-retrieval-fixtures.js';
import { checkRetrievedEvidence } from './repository-retrieval.js';

/** Verify citations against the union of the source lines actually shown to the agent. */
export function gradeRepositoryCitations(
  citations: readonly SourceRange[],
  expected: readonly SourceRange[],
  hits: readonly RepositoryHit[],
  files: ReadonlyMap<string, string>,
) {
  const verified = hits
    .flatMap((hit) => {
      const evidence = checkRetrievedEvidence(hit, files);
      return evidence.status === 'valid' ? [{ ...hit, endLine: evidence.throughLine }] : [];
    })
    .sort((left, right) => left.startLine - right.startLine);
  const supported: SourceRange[] = [];
  const unsupported: (Omit<SourceRange, 'path'> & { path: string | null })[] = [];
  for (const citation of citations) {
    const normalized = { ...citation, path: citation.path.replace(/^(?:\.\/)+/, '') };
    let nextLine = normalized.startLine;
    if (
      Number.isSafeInteger(nextLine) &&
      nextLine > 0 &&
      Number.isSafeInteger(normalized.endLine) &&
      normalized.endLine >= nextLine
    ) {
      for (const hit of verified) {
        if (hit.path === normalized.path && hit.startLine <= nextLine && hit.endLine >= nextLine)
          nextLine = hit.endLine + 1;
      }
      if (nextLine > normalized.endLine) {
        supported.push(normalized);
        continue;
      }
    }
    unsupported.push({ ...normalized, path: files.has(normalized.path) ? normalized.path : null });
  }
  const missing = expected.filter(
    (label) =>
      !supported.some(
        (citation) =>
          citation.path === label.path &&
          citation.startLine <= label.startLine &&
          citation.endLine >= label.endLine,
      ),
  );
  return { supported, unsupported, missing };
}

/** Measure when completed replies first supported a correct citation in the final answer. */
export function firstVerifiedCitationMs(
  citations: readonly SourceRange[],
  expected: readonly SourceRange[],
  replies: readonly { elapsedMs: number; hits: readonly RepositoryHit[] }[],
  files: ReadonlyMap<string, string>,
): number | null {
  if (!citations.length || !expected.length) return null;
  const hits: RepositoryHit[] = [];
  for (const reply of replies.toSorted((left, right) => left.elapsedMs - right.elapsedMs)) {
    hits.push(...reply.hits);
    const { missing } = gradeRepositoryCitations(citations, expected, hits, files);
    if (missing.length < expected.length) return reply.elapsedMs;
  }
  return null;
}

/** Measure when the agent has received every labeled source range, regardless of its answer. */
export function allRequiredEvidenceMs(
  expected: readonly SourceRange[],
  replies: readonly { elapsedMs: number; hits: readonly RepositoryHit[] }[],
  files: ReadonlyMap<string, string>,
): number | null {
  if (!expected.length) return null;
  const hits: RepositoryHit[] = [];
  for (const reply of replies.toSorted((left, right) => left.elapsedMs - right.elapsedMs)) {
    hits.push(...reply.hits);
    if (!gradeRepositoryCitations(expected, expected, hits, files).missing.length)
      return reply.elapsedMs;
  }
  return null;
}

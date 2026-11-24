import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { MAX_SOURCE_EXCERPT, type RepositoryHit } from './results.js';
import type { RepositoryWorkspace } from './workspace.js';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

type SourceRange = Pick<RepositoryHit, 'startLine' | 'endLine' | 'name'>;
type EvidenceFailure = 'source-unavailable' | 'source-missing' | 'source-changed';

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function sourceText(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
}

function missingFile(error: unknown): boolean {
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

/** Verify the provider's text at a reported range before returning any source evidence. */
export async function verifySourceEvidence(
  workspace: RepositoryWorkspace,
  input: { path: string; excerpt: string; ranges: readonly SourceRange[]; contextAfter?: number },
  signal: AbortSignal,
): Promise<RepositoryHit | EvidenceFailure> {
  signal.throwIfAborted();
  try {
    const target = await workspace.resolvePath(input.path, { kind: 'file' });
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const file = await open(target.absolute, flags);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_SOURCE_BYTES)) return 'source-unavailable';

      // > Recheck the pathname after opening so a moved file cannot stand in for the authorized path.
      await workspace.resolvePath(input.path, { kind: 'file' });
      if (!sameFile(before, await lstat(target.absolute, { bigint: true })))
        return 'source-changed';

      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) return 'source-changed';
        offset += bytesRead;
      }
      if (!sameFile(before, await file.stat({ bigint: true }))) return 'source-changed';
      await workspace.resolvePath(input.path, { kind: 'file' });
      if (!sameFile(before, await lstat(target.absolute, { bigint: true })))
        return 'source-changed';
      signal.throwIfAborted();

      const source = sourceText(bytes);
      if (!source || source.includes('\0')) return 'source-unavailable';
      const lines = source.replace(/\n$/, '').split('\n');
      const excerpt = input.excerpt.replaceAll('\r\n', '\n');
      for (const range of input.ranges) {
        const { startLine, endLine, name } = range;
        if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) continue;
        if (startLine < 1 || endLine < startLine || endLine > lines.length) continue;
        const current = lines.slice(startLine - 1, endLine).join('\n');
        if (excerpt !== current && excerpt !== `${current}\n`) continue;
        const contextEnd = Math.min(lines.length, endLine + (input.contextAfter ?? 0));
        const evidence =
          contextEnd === endLine ? current : lines.slice(startLine - 1, contextEnd).join('\n');
        const excerptTruncated = evidence.length > MAX_SOURCE_EXCERPT;
        return {
          path: target.relative,
          startLine,
          endLine: contextEnd,
          excerpt: evidence.slice(0, MAX_SOURCE_EXCERPT).replace(/[\uD800-\uDBFF]$/, ''),
          ...(excerptTruncated ? { excerptTruncated: true } : {}),
          ...(name ? { name: name.slice(0, 200) } : {}),
        };
      }
      return 'source-changed';
    } finally {
      await file.close();
    }
  } catch (error) {
    signal.throwIfAborted();
    return missingFile(error) ? 'source-missing' : 'source-unavailable';
  }
}

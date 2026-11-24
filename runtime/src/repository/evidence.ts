import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { MAX_SOURCE_EXCERPT, type RepositoryHit } from './results.js';
import type { RepositoryWorkspace } from './workspace.js';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_SOURCE_BYTES = 32 * 1024 * 1024;

type SourceRange = Pick<RepositoryHit, 'startLine' | 'endLine' | 'name'>;
type EvidenceFailure = 'source-unavailable' | 'source-missing' | 'source-changed';

export interface SourceSnapshot {
  path: string;
  text: string;
  lines: readonly string[];
}

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

export function sourceExcerpt(
  source: SourceSnapshot,
  { startLine, endLine, name }: SourceRange,
): RepositoryHit {
  const text = source.lines.slice(startLine - 1, endLine).join('\n');
  const excerpt = text.slice(0, MAX_SOURCE_EXCERPT).replace(/[\uD800-\uDBFF]$/, '');
  const excerptTruncated = excerpt.length < text.length;
  return {
    path: source.path,
    startLine,
    endLine,
    excerpt,
    ...(excerptTruncated ? { excerptTruncated: true } : {}),
    ...(name ? { name: name.slice(0, 200) } : {}),
  };
}

/** Read file bytes at most once per request and reject a cached snapshot if its file changes. */
export class RepositorySourceReader {
  private readonly snapshots = new Map<
    string,
    Promise<{ source: SourceSnapshot; identity: BigIntStats } | EvidenceFailure>
  >();
  private bytesRead = 0;

  constructor(private readonly workspace: RepositoryWorkspace) {}

  private async capture(
    target: Awaited<ReturnType<RepositoryWorkspace['resolvePath']>>,
    signal: AbortSignal,
  ): Promise<{ source: SourceSnapshot; identity: BigIntStats } | EvidenceFailure> {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    const file = await open(target.absolute, flags);
    try {
      const identity = await file.stat({ bigint: true });
      if (!identity.isFile() || identity.size > BigInt(MAX_SOURCE_BYTES))
        return 'source-unavailable';
      const size = Number(identity.size);
      if (this.bytesRead + size > MAX_REQUEST_SOURCE_BYTES) return 'source-unavailable';
      this.bytesRead += size;

      await this.workspace.resolvePath(target.relative, { kind: 'file' });
      if (!sameFile(identity, await lstat(target.absolute, { bigint: true })))
        return 'source-changed';

      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
        if (!bytesRead) return 'source-changed';
        offset += bytesRead;
      }
      if (!sameFile(identity, await file.stat({ bigint: true }))) return 'source-changed';

      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
      if (!text || text.includes('\0')) return 'source-unavailable';
      const lines = text.replace(/\n$/, '').split('\n');
      return { source: { path: target.relative, text, lines }, identity };
    } finally {
      await file.close();
    }
  }

  async read(
    path: string,
    signal: AbortSignal,
    allows?: (path: string) => boolean,
  ): Promise<SourceSnapshot | EvidenceFailure> {
    signal.throwIfAborted();
    try {
      const target = await this.workspace.resolvePath(path, { kind: 'file' });
      if (allows && !allows(target.relative)) return 'source-unavailable';
      let capture = this.snapshots.get(target.relative);
      if (!capture) {
        capture = this.capture(target, signal);
        this.snapshots.set(target.relative, capture);
      }
      const snapshot = await capture;
      signal.throwIfAborted();
      if (typeof snapshot === 'string') return snapshot;
      await this.workspace.resolvePath(target.relative, { kind: 'file' });
      return sameFile(snapshot.identity, await lstat(target.absolute, { bigint: true }))
        ? snapshot.source
        : 'source-changed';
    } catch (error) {
      signal.throwIfAborted();
      const cause = error instanceof Error ? (error.cause ?? error) : error;
      return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
        ? 'source-missing'
        : 'source-unavailable';
    }
  }

  /** Verify the provider's text at a reported range before returning any source evidence. */
  async verify(
    input: { path: string; excerpt: string; ranges: readonly SourceRange[]; contextAfter?: number },
    signal: AbortSignal,
  ): Promise<RepositoryHit | EvidenceFailure> {
    const source = await this.read(input.path, signal);
    if (typeof source === 'string') return source;
    const excerpt = input.excerpt.replaceAll('\r\n', '\n');
    for (const { startLine, endLine, name } of input.ranges) {
      if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) continue;
      if (startLine < 1 || endLine < startLine || endLine > source.lines.length) continue;
      const current = source.lines.slice(startLine - 1, endLine).join('\n');
      if (excerpt !== current && excerpt !== `${current}\n`) continue;
      const contextEnd = Math.min(source.lines.length, endLine + (input.contextAfter ?? 0));
      return sourceExcerpt(source, { startLine, endLine: contextEnd, name });
    }
    return 'source-changed';
  }
}

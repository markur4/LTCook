import type { BigIntStats } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isWithin } from '../path-containment.js';

type PathKind = 'file' | 'directory';
type RepositoryPath = { absolute: string; relative: string; kind: PathKind };

export interface RepositoryWorkspace {
  readonly root: string;
  readonly identity: string;
  readonly cacheIdentity: string;
  assertUnchanged(): Promise<void>;
  resolvePath(
    input: string,
    options?: { kind?: PathKind; allowRoot?: boolean },
  ): Promise<RepositoryPath>;
}

/** Match a live directory observation to the authorization granted for it. */
export function repositoryWorkspaceIdentity(info: Pick<BigIntStats, 'dev' | 'ino'>): string {
  return `${info.dev}:${info.ino}`;
}

async function directoryIdentity(directory: string) {
  const info = await stat(directory, { bigint: true });
  if (!info.isDirectory())
    throw new Error('Repository discovery requires an existing workspace directory');
  const live = repositoryWorkspaceIdentity(info);
  // > Mount device numbers can change across boots, including for WSL's ext4 disk.
  const birth = info.ino > 0n && info.birthtimeNs > 0n ? info.birthtimeNs : undefined;
  // > Without a birth time, avoid reusing persisted evidence of uncertain origin.
  const cache = birth === undefined ? `stat:${live}:${info.ctimeNs}` : `birth:${info.ino}:${birth}`;
  return { live, cache, birth };
}

/** Open a root supplied by an already authenticated workspace/session binding. */
export async function openRepositoryWorkspace(root: string): Promise<RepositoryWorkspace> {
  const canonical = await realpath(root);
  const identity = await directoryIdentity(canonical);

  return {
    root: canonical,
    identity: identity.live,
    cacheIdentity: identity.cache,
    async assertUnchanged() {
      const unchanged = await Promise.all([realpath(canonical), directoryIdentity(canonical)])
        .then(
          ([current, observed]) =>
            current === canonical &&
            observed.live === identity.live &&
            observed.birth === identity.birth,
        )
        .catch(() => false);
      if (!unchanged) throw new Error('The authorized workspace changed during repository search.');
    },
    async resolvePath(input, { kind, allowRoot = false } = {}) {
      if (
        !input ||
        input.includes('\0') ||
        path.isAbsolute(input) ||
        path.win32.isAbsolute(input) ||
        /^[a-z]:/i.test(input) ||
        input.split(path.sep === '\\' ? /[\\/]/ : '/').includes('..')
      ) {
        throw new Error('Repository target must be a workspace-relative path without traversal');
      }
      const absolute = path.resolve(canonical, input);
      if (!isWithin(canonical, absolute, allowRoot))
        throw new Error('Repository target is outside the authorized workspace');

      const actual = await realpath(absolute).catch((cause: unknown) => {
        throw new Error('Repository target does not exist', { cause });
      });
      if (path.relative(absolute, actual) !== '' || !isWithin(canonical, actual, allowRoot))
        throw new Error('Repository targets cannot traverse symbolic links or junctions');

      const info = await lstat(absolute);
      const actualKind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : undefined;
      if (!actualKind || (kind && kind !== actualKind))
        throw new Error('Repository target is not a supported file or directory');
      const relative = path.relative(canonical, actual).split(path.sep).join('/') || '.';
      return { absolute: actual, relative, kind: actualKind };
    },
  };
}

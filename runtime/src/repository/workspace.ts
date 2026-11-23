import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isWithin } from '../path-containment.js';

type PathKind = 'file' | 'directory';
type RepositoryPath = { absolute: string; relative: string; kind: PathKind };

export interface RepositoryWorkspace {
  readonly root: string;
  resolvePath(
    input: string,
    options?: { kind?: PathKind; allowRoot?: boolean },
  ): Promise<RepositoryPath>;
}

/** Open a root supplied by an already authenticated workspace/session binding. */
export async function openRepositoryWorkspace(root: string): Promise<RepositoryWorkspace> {
  const canonical = await realpath(root);
  if (!(await stat(canonical)).isDirectory())
    throw new Error('Repository discovery requires an existing workspace directory');

  return {
    root: canonical,
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

      const actual = await realpath(absolute).catch(() => undefined);
      if (!actual) throw new Error('Repository target does not exist');
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

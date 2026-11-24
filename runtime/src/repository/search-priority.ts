import { posix } from 'node:path';
import { readGit } from './providers/git.js';
import type { RepositoryDiagnostic } from './results.js';
import type { RepositoryWorkspace } from './workspace.js';

export interface RepositorySearchPriority {
  base?: { reference: string; commit: string };
  prioritize?: (path: string) => boolean;
  diagnostics: RepositoryDiagnostic[];
  partial: boolean;
}

export function isTestSource(path: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__|specs?)\/|(?:^|\/)test_[^/]+$|[._-](?:test|spec)\.[^/]+$/.test(
    path,
  );
}

function sourceStem(path: string) {
  return posix.basename(path, posix.extname(path)).replace(/^test_|[._-](?:test|spec)$/, '');
}

export async function repositorySearchPriority(
  workspace: RepositoryWorkspace,
  base: string,
  signal: AbortSignal,
): Promise<RepositorySearchPriority> {
  const { value, diagnostics, partial } = await readGit(workspace, process.env.PATH ?? '', {
    base,
    includeWorktreePaths: true,
    signal,
  });
  if (!value.base) return { diagnostics, partial: true };
  const paths = new Set([
    ...value.base.changedFiles.map(({ path }) => path),
    ...(value.changedFiles ?? []).map(({ path }) => path),
    ...(value.untrackedFiles ?? []),
  ]);
  const stems = new Set([...paths].filter((path) => !isTestSource(path)).map(sourceStem));
  return {
    base: { reference: value.base.reference, commit: value.base.commit },
    diagnostics,
    partial,
    prioritize: (path) => paths.has(path) || (isTestSource(path) && stems.has(sourceStem(path))),
  };
}

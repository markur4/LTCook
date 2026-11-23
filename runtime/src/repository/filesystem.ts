import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RepositoryResult } from './results.js';
import { openRepositoryWorkspace, type RepositoryWorkspace } from './workspace.js';

const excludedDirectories = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.venv',
  '.next',
  '.ssh',
  '.aws',
  'node_modules',
  '__pycache__',
  'coverage',
  'dist',
  'build',
  'target',
  'vendor',
]);

function excluded(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    excludedDirectories.has(lower) ||
    lower === '.env' ||
    lower.startsWith('.env.') ||
    ['.npmrc', '.netrc', '.pypirc', '.git-credentials', 'id_rsa', 'id_ed25519'].includes(lower) ||
    /\.(?:key|pem|p12|pfx)$/.test(lower)
  );
}

type TreeEntry = { path: string; kind: 'directory' | 'file' };

type WalkOptions = { maxDepth: number; maxEntries: number };

async function walk(
  workspace: RepositoryWorkspace,
  target: string,
  { maxDepth, maxEntries }: WalkOptions,
): Promise<{ entries: TreeEntry[]; truncated: boolean; partial: boolean }> {
  const entries: TreeEntry[] = [];
  let partial = false;
  let truncated = false;
  let scanned = 0;
  const directories = [{ relative: target, depth: 0 }];

  scan: for (const { relative, depth } of directories) {
    try {
      const directory = await workspace.resolvePath(relative, {
        kind: 'directory',
        allowRoot: true,
      });
      for await (const entry of await opendir(directory.absolute)) {
        if (++scanned > maxEntries) {
          truncated = true;
          break scan;
        }
        if (excluded(entry.name) || !(entry.isFile() || entry.isDirectory())) continue;
        if (depth >= maxDepth) {
          truncated = true;
          break;
        }
        const child = relative === '.' ? entry.name : `${relative}/${entry.name}`;
        const kind = entry.isDirectory() ? 'directory' : 'file';
        entries.push({ path: child, kind });
        if (kind === 'directory') directories.push({ relative: child, depth: depth + 1 });
      }
    } catch {
      partial = true;
    }
  }

  return { entries, truncated, partial };
}

export function assertRepositoryPathVisible(target: string): void {
  if (target.split('/').some(excluded))
    throw new Error('Repository target is excluded from discovery');
}

export async function readRepositoryMap(
  workspace: RepositoryWorkspace,
  target: string,
  options: WalkOptions,
): Promise<RepositoryResult<{ target: string; entries: TreeEntry[] }>> {
  const capturedAt = new Date().toISOString();
  const { relative } = await workspace.resolvePath(target, { kind: 'directory', allowRoot: true });
  assertRepositoryPathVisible(relative);
  const { entries, partial, truncated: scanTruncated } = await walk(workspace, relative, options);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let bytes = 0;
  let truncated = scanTruncated;
  const bounded = entries.filter((entry) => {
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (bytes <= 24 * 1024) return true;
    truncated = true;
    return false;
  });
  return {
    provider: 'filesystem',
    value: { target: relative, entries: bounded },
    capturedAt,
    freshness: 'current',
    partial,
    truncated,
    diagnostics: [
      ...(partial
        ? [
            {
              source: 'filesystem',
              code: 'unreadable',
              message: 'Some directories could not be read',
            },
          ]
        : []),
      ...(truncated
        ? [
            {
              source: 'filesystem',
              code: 'map-limit',
              message: 'Directory map reached its scan or depth limit',
            },
          ]
        : []),
    ],
  };
}

/** Read bytes from a provider path already resolved against the workspace. */
export async function readBoundedFile(
  absolute: string,
  limit: number,
): Promise<Buffer | undefined> {
  const entry = await lstat(absolute, { bigint: true });
  if (!entry.isFile()) throw new Error('Repository file changed during discovery');
  if (entry.size > limit) return;
  const file = await open(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await file.stat({ bigint: true });
    if (
      !info.isFile() ||
      info.ino !== entry.ino ||
      info.dev !== entry.dev ||
      path.relative(absolute, await realpath(absolute)) !== ''
    ) {
      throw new Error('Repository file changed during discovery');
    }
    if (info.size > limit) return;
    const buffer = Buffer.alloc(Number(info.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > info.size) return;
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

/** Stage only regular authorized files so external providers cannot follow workspace links. */
export async function stageRepositoryFiles(
  workspace: RepositoryWorkspace,
  {
    target = '.',
    maxDepth = 8,
    maxEntries = 10000,
    maxFiles = 10000,
    maxFileBytes = 4 * 1024 * 1024,
    maxBytes = 24 * 1024 * 1024,
    extensions,
  }: {
    target?: string;
    maxDepth?: number;
    maxEntries?: number;
    maxFiles?: number;
    maxFileBytes?: number;
    maxBytes?: number;
    extensions?: ReadonlySet<string>;
  } = {},
): Promise<{
  workspace: RepositoryWorkspace;
  relativeTarget: string;
  fileCount: number;
  truncated: boolean;
  partial: boolean;
  dispose(): Promise<void>;
}> {
  const selected = await workspace.resolvePath(target, { allowRoot: true });
  assertRepositoryPathVisible(selected.relative);
  const scan =
    selected.kind === 'file'
      ? {
          entries: [{ path: selected.relative, kind: 'file' as const }],
          truncated: false,
          partial: false,
        }
      : await walk(workspace, selected.relative, { maxDepth, maxEntries });
  let { truncated, partial } = scan;
  const stage = await mkdtemp(path.join(tmpdir(), 'ltcook-repository-'));
  const dispose = () => rm(stage, { recursive: true, force: true });
  try {
    const stagedWorkspace = await openRepositoryWorkspace(stage);
    let fileCount = 0;
    let bytes = 0;
    for (const entry of scan.entries) {
      if (entry.kind !== 'file') continue;
      if (extensions && !extensions.has(path.extname(entry.path).toLowerCase())) continue;
      if (fileCount >= maxFiles || bytes >= maxBytes) {
        truncated = true;
        break;
      }
      try {
        const { absolute } = await workspace.resolvePath(entry.path, { kind: 'file' });
        const data = await readBoundedFile(absolute, Math.min(maxFileBytes, maxBytes - bytes));
        if (!data) {
          truncated = true;
          continue;
        }
        const destination = path.join(stagedWorkspace.root, entry.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, data, { flag: 'wx', mode: 0o600 });
        fileCount++;
        bytes += data.length;
      } catch {
        partial = true;
      }
    }
    return {
      workspace: stagedWorkspace,
      relativeTarget: selected.relative,
      fileCount,
      truncated,
      partial,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

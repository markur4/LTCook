import { constants } from 'node:fs';
import { lstat, open, opendir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { isRepositoryPathVisible } from '../filesystem.js';
import type { RepositoryWorkspace } from '../workspace.js';

type SourceFile = [path: string, modified: string, size: string, changed: string, inode: string];
export type ColgrepSourceSnapshot = SourceFile[];

const MAX_SOURCE_FILES = 250_000;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

export function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Capture the files that can contribute repository evidence before starting a native write. */
export async function captureColgrepSource(
  workspace: RepositoryWorkspace,
  signal: AbortSignal,
): Promise<ColgrepSourceSnapshot> {
  const files: ColgrepSourceSnapshot = [];
  const directories = ['.'];
  let scanned = 0;
  for (const relative of directories) {
    signal.throwIfAborted();
    const directory = await workspace.resolvePath(relative, { kind: 'directory', allowRoot: true });
    for await (const entry of await opendir(directory.absolute)) {
      signal.throwIfAborted();
      if (++scanned > MAX_SOURCE_FILES) {
        throw new Error('The worktree exceeds the repository index scan limit.');
      }
      const child = relative === '.' ? entry.name : relative + '/' + entry.name;
      if (!isRepositoryPathVisible(child)) continue;
      if (entry.isDirectory()) {
        directories.push(child);
      } else if (entry.isFile()) {
        const info = await lstat(path.join(directory.absolute, entry.name), { bigint: true }).catch(
          (error: unknown) => {
            if (!missing(error)) throw error;
          },
        );
        if (info?.isFile()) {
          files.push([
            child,
            String(info.mtimeNs),
            String(info.size),
            String(info.ctimeNs),
            String(info.ino),
          ]);
        }
      }
    }
  }
  await workspace.assertUnchanged();
  return files.sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1));
}

export function sameColgrepSource(
  left: ColgrepSourceSnapshot,
  right: ColgrepSourceSnapshot,
): boolean {
  return (
    left.length === right.length &&
    left.every((file, index) => file.every((value, field) => value === right[index]?.[field]))
  );
}

/** ColGREP skips hashing a file whose mtime and size match, even after its content changed. */
export function requiresFreshColgrepBuild(
  before: ColgrepSourceSnapshot,
  after: ColgrepSourceSnapshot,
): boolean {
  const previous = new Map(before.map((file) => [file[0], file]));
  return after.some(([name, modified, size, changed, inode]) => {
    const old = previous.get(name);
    return (
      old && old[1] === modified && old[2] === size && (old[3] !== changed || old[4] !== inode)
    );
  });
}

function snapshotPath(indices: string): string {
  return path.join(path.dirname(indices), 'source.json');
}

export async function readColgrepSource(
  indices: string,
): Promise<ColgrepSourceSnapshot | undefined> {
  const file = await open(
    snapshotPath(indices),
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  ).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES)
      throw new Error('Invalid ColGREP source receipt.');
    const input: unknown = JSON.parse(await file.readFile({ encoding: 'utf8' }));
    if (
      !Array.isArray(input) ||
      input.some(
        (file) =>
          !Array.isArray(file) ||
          file.length !== 5 ||
          file.some((value) => typeof value !== 'string'),
      )
    )
      throw new Error('Invalid ColGREP source receipt.');
    return input as ColgrepSourceSnapshot;
  } finally {
    await file.close();
  }
}

export async function writeColgrepSource(
  indices: string,
  snapshot: ColgrepSourceSnapshot,
): Promise<void> {
  const file = snapshotPath(indices);
  const temporary = file + '.' + randomUUID() + '.tmp';
  const data = JSON.stringify(snapshot);
  if (Buffer.byteLength(data) > MAX_SNAPSHOT_BYTES)
    throw new Error('The worktree exceeds the repository index receipt limit.');
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

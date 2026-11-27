import { constants } from 'node:fs';
import { lstat, open, opendir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { isRepositoryPathVisible, readBoundedFile } from '../filesystem.js';
import { findRepositoryExecutable, runRepositoryCommand } from '../process.js';
import type { RepositoryWorkspace } from '../workspace.js';

type SourceFile = [
  path: string,
  modified: string,
  size: string,
  changed: string,
  inode: string,
  digest?: string,
];
export interface ColgrepSourceSnapshot {
  files: SourceFile[];
  complete: boolean;
}

const MAX_SOURCE_FILES = 250_000;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024;

type SourcePaths = { paths: string[]; complete: boolean };

async function sourcePaths(
  workspace: RepositoryWorkspace,
  signal: AbortSignal,
): Promise<SourcePaths> {
  const executablePath = process.env.PATH ?? '';
  const ripgrep = findRepositoryExecutable('rg', executablePath, workspace);
  const listed =
    ripgrep &&
    (await runRepositoryCommand(
      ripgrep,
      ['--files', '--hidden', '--null', '--glob=!.git', '--no-ignore-global', '--', '.'],
      workspace,
      executablePath,
      { timeoutMs: 5000, maxBytes: MAX_SNAPSHOT_BYTES, signal },
    ).catch(() => undefined));
  signal.throwIfAborted();
  if (listed && (listed.code === 0 || listed.code === 1)) {
    const paths = listed.stdout
      .split('\0')
      .filter(Boolean)
      .map((file) =>
        path.relative(workspace.root, path.resolve(workspace.root, file)).split(path.sep).join('/'),
      )
      .filter(isRepositoryPathVisible)
      .sort();
    return { paths: paths.slice(0, MAX_SOURCE_FILES), complete: paths.length <= MAX_SOURCE_FILES };
  }

  const paths: string[] = [];
  const directories = ['.'];
  let scanned = 0;
  for (const relative of directories) {
    signal.throwIfAborted();
    const directory = await workspace
      .resolvePath(relative, { kind: 'directory', allowRoot: true })
      .then(({ absolute }) => opendir(absolute))
      .catch(() => undefined);
    if (!directory) continue;
    try {
      for await (const entry of directory) {
        signal.throwIfAborted();
        if (++scanned > MAX_SOURCE_FILES) {
          return { paths: paths.sort(), complete: false };
        }
        const child = relative === '.' ? entry.name : relative + '/' + entry.name;
        if (!isRepositoryPathVisible(child)) continue;
        if (entry.isDirectory()) directories.push(child);
        else if (entry.isFile()) paths.push(child);
      }
    } catch {
      signal.throwIfAborted();
      // > The native scanner can still index the files it can open.
    }
  }
  return { paths: paths.sort(), complete: false };
}

/** Observe current source before a native write, using the repository ignore scopes when available. */
export async function captureColgrepSource(
  workspace: RepositoryWorkspace,
  signal: AbortSignal,
  verifyContents = false,
): Promise<ColgrepSourceSnapshot> {
  const inventory = await sourcePaths(workspace, signal);
  const files: SourceFile[] = [];
  let complete = inventory.complete;
  let bytes = 128;
  for (const child of inventory.paths) {
    signal.throwIfAborted();
    const file = await observeSourceFile(workspace, child, verifyContents).catch(() => undefined);
    if (!file) {
      complete = false;
      continue;
    }
    bytes += Buffer.byteLength(JSON.stringify(file)) + 1;
    if (bytes > MAX_SNAPSHOT_BYTES) {
      complete = false;
      break;
    }
    files.push(file);
  }
  signal.throwIfAborted();
  await workspace.assertUnchanged();
  return { files, complete };
}

async function observeSourceFile(
  workspace: RepositoryWorkspace,
  child: string,
  verifyContents: boolean,
): Promise<SourceFile> {
  const { absolute } = await workspace.resolvePath(child, { kind: 'file' });
  const info = await lstat(absolute, { bigint: true });
  if (!info.isFile()) throw new Error('The worktree changed while checking index freshness.');
  const file: SourceFile = [
    child,
    String(info.mtimeNs),
    String(info.size),
    String(info.ctimeNs),
    String(info.ino),
  ];
  if (verifyContents) {
    const buffer = await readBoundedFile(absolute, MAX_EVIDENCE_FILE_BYTES);
    if (buffer) file[5] = createHash('sha256').update(buffer).digest('hex');
  }
  return file;
}

export function sameColgrepSource(
  left: ColgrepSourceSnapshot,
  right: ColgrepSourceSnapshot,
): boolean {
  return (
    left.complete === right.complete &&
    left.files.length === right.files.length &&
    left.files.every((file, index) =>
      file.slice(0, 5).every((value, field) => value === right.files[index]?.[field]),
    )
  );
}

/** ColGREP skips hashing a file whose mtime and size match, even after its content changed. */
export function requiresFreshColgrepBuild(
  before: ColgrepSourceSnapshot,
  after: ColgrepSourceSnapshot,
): boolean {
  if (!before.complete || !after.complete) return true;
  const previous = new Map(before.files.map((file) => [file[0], file]));
  return after.files.some(([name, modified, size, changed, inode, digest]) => {
    const old = previous.get(name);
    return (
      old &&
      old[1] === modified &&
      old[2] === size &&
      (old[3] !== changed ||
        old[4] !== inode ||
        (old[5] !== undefined && digest !== undefined && old[5] !== digest))
    );
  });
}

function snapshotPath(indices: string): string {
  return path.join(path.dirname(indices), 'source.json');
}

export async function readColgrepSource(
  indices: string,
): Promise<ColgrepSourceSnapshot | undefined> {
  const filename = snapshotPath(indices);
  const info = await lstat(filename, { bigint: true }).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const file = await open(
    filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch(() => undefined);
  if (!file) return undefined;
  try {
    const stat = await file.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.dev !== info.dev ||
      stat.ino !== info.ino ||
      stat.size > BigInt(MAX_SNAPSHOT_BYTES)
    )
      return undefined;
    const input: unknown = JSON.parse(await file.readFile({ encoding: 'utf8' }));
    if (
      !input ||
      typeof input !== 'object' ||
      !('complete' in input) ||
      typeof input.complete !== 'boolean' ||
      !('files' in input) ||
      !Array.isArray(input.files) ||
      input.files.some(
        (file) =>
          !Array.isArray(file) ||
          (file.length !== 5 && file.length !== 6) ||
          file.some((value) => typeof value !== 'string'),
      )
    )
      return undefined;
    return { complete: input.complete, files: input.files as ColgrepSourceSnapshot['files'] };
  } catch {
    // > Missing observation evidence requires a fresh candidate, even if the published index is readable.
    return undefined;
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

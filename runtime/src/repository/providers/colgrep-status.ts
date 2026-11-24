import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { RepositoryWorkspace } from '../workspace.js';

export interface ColgrepStatus {
  availability: 'ready' | 'not-ready' | 'unavailable' | 'unknown';
  activity: 'idle' | 'checking' | 'indexing' | 'updating' | 'interrupted' | 'error' | 'unknown';
  diagnostic: string | null;
}

type OperationOutcome =
  | { activity: 'idle'; diagnostic: null }
  | { activity: 'interrupted' | 'error' | 'unknown'; diagnostic: string };
interface ScopeActivity {
  active: Map<symbol, { startedAt: number; pid?: number }>;
  last?: OperationOutcome & { finishedAt: number };
  observedIndex?: { directory: string; identity: string };
  readyIndex?: string;
}

const activities = new Map<string, ScopeActivity>();
const MAX_HISTORY = 128;
const MAX_INDEX_CANDIDATES = 64;
const MAX_RECEIPT_BYTES = 65_536;
const INDEX_FORMAT_VERSION = 3;

function activityScope(indices: string, binding: string, workspace: RepositoryWorkspace) {
  return JSON.stringify([indices, binding, workspace.root, workspace.identity]);
}

function rememberScope(key: string): ScopeActivity {
  const scope: ScopeActivity = activities.get(key) ?? { active: new Map() };
  activities.delete(key);
  activities.set(key, scope);
  for (const [oldKey, previous] of activities) {
    if (activities.size <= MAX_HISTORY) break;
    if (!previous.active.size && oldKey !== key) activities.delete(oldKey);
  }
  return scope;
}

/** Track only user-initiated commands, with independent ownership of each live child. */
export function startColgrepOperation(
  indices: string,
  binding: string,
  workspace: RepositoryWorkspace,
) {
  const scope = rememberScope(activityScope(indices, binding, workspace));
  const id = Symbol();
  const operation: { startedAt: number; pid?: number } = { startedAt: Date.now() };
  scope.active.set(id, operation);
  return {
    setPid(pid: number | undefined) {
      operation.pid = pid;
    },
    finish(outcome: OperationOutcome) {
      scope.active.delete(id);
      scope.last = { ...outcome, finishedAt: Date.now() };
    },
  };
}

export function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function managedEntry(file: string, kind: 'directory' | 'file') {
  try {
    const info = await lstat(file, { bigint: true });
    if (
      (kind === 'directory' ? !info.isDirectory() : !info.isFile()) ||
      (await realpath(file)) !== file
    ) {
      throw new Error('Invalid managed ColGREP storage entry.');
    }
    return info;
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

async function inspectFile<T>(
  file: string,
  read: (length: number, readAt: (buffer: Buffer, offset: number) => Promise<string>) => Promise<T>,
): Promise<T | undefined> {
  const info = await managedEntry(file, 'file');
  if (!info) return undefined;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    (error: unknown) => {
      if (!missing(error)) throw error;
    },
  );
  if (!handle) return undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error('ColGREP storage entry changed while opening it.');
    }
    return await read(Number(opened.size), async (buffer, offset) => {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return buffer.toString('utf8', 0, bytesRead);
    });
  } finally {
    await handle.close();
  }
}

async function readReceipt(file: string): Promise<Record<string, unknown> | undefined> {
  return inspectFile(file, async (length, readAt) => {
    if (length > MAX_RECEIPT_BYTES) return undefined;
    const content = await readAt(Buffer.alloc(length), 0);
    try {
      const data: unknown = JSON.parse(content);
      return data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  });
}

async function readState(file: string) {
  // > In the v1.8.5 pretty-printed state, the format is in the header and dirty is
  // > the final field. Avoid reading the unbounded list of indexed source paths.
  return inspectFile(file, async (length, readAt) => {
    const span = Math.min(length, 512);
    const head = await readAt(Buffer.alloc(span), 0);
    const tail = length <= span ? head : await readAt(Buffer.alloc(span), length - span);
    const version = /^\{\s*"cli_version":\s*"[^"]+",\s*"index_format_version":\s*(\d+),/.exec(head);
    const dirty = /,\s*"dirty":\s*(true|false)\s*\}\s*$/.exec(tail);
    if (version && dirty) return { version: Number(version[1]), dirty: dirty[1] === 'true' };
  });
}

function indexLockKey(info: BigIntStats): string {
  // > Decode Linux dev_t the same way as major(3) and minor(3).
  const major = ((info.dev >> 8n) & 0xfffn) | ((info.dev >> 32n) & ~0xfffn);
  const minor = (info.dev & 0xffn) | ((info.dev >> 12n) & ~0xffn);
  return `${major.toString(16)}:${minor.toString(16)}:${info.ino}`;
}

function ownsLock(scope: ScopeActivity | undefined, pid: number): boolean {
  if (!scope) return false;
  for (const operation of scope.active.values()) {
    if (operation.pid === pid) return true;
  }
  return false;
}

async function heldIndexLocks(): Promise<Map<string, number> | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const handle = await open('/proc/locks', 'r');
    let content = '';
    try {
      const buffer = Buffer.alloc(128 * 1024);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset === buffer.length) return undefined;
      content = buffer.toString('utf8', 0, offset);
    } finally {
      await handle.close();
    }
    const locks = new Map<string, number>();
    // > fs2 uses flock on Linux. Exclude waiting records marked with "->".
    for (const [, pid, major, minor, ino] of content.matchAll(
      /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([a-f0-9]+):([a-f0-9]+):(\d+)\s+/gm,
    )) {
      const device = [major, minor].map((value) => value.replace(/^0+(?=.)/, '')).join(':');
      const key = `${device}:${ino}`;
      locks.set(key, Number(pid));
    }
    return locks;
  } catch {
    return undefined;
  }
}

async function findIndex(
  indices: string,
  model: string,
  workspace: RepositoryWorkspace,
  scope: ScopeActivity | undefined,
) {
  const candidates = [];
  let unresolved = false;
  let count = 0;
  // > First collect file identities so the lock snapshot follows those observations.
  const dirs = await opendir(indices);
  for await (const entry of dirs) {
    if (++count > MAX_INDEX_CANDIDATES) return { unresolved: true };
    if (entry.isSymbolicLink()) {
      unresolved = true;
      continue;
    }
    if (!entry.isDirectory()) continue;
    const directory = path.join(indices, entry.name);
    const info = await managedEntry(directory, 'directory');
    if (!info) continue;
    const receipt = await readReceipt(path.join(directory, 'project.json'));
    const bound =
      receipt?.model === model &&
      (receipt.project_path === workspace.root ||
        receipt.project_path === path.toNamespacedPath(workspace.root));
    if (receipt && typeof receipt.model === 'string' && !bound) continue;
    const lock = await managedEntry(path.join(directory, '.lock'), 'file');
    candidates.push({ directory, identity: `${info.dev}:${info.ino}`, bound, lock });
  }
  const locks = candidates.some(({ lock }) => lock) ? await heldIndexLocks() : undefined;
  const matches = [];
  for (const { directory, identity, bound, lock } of candidates) {
    const pid = lock ? locks?.get(indexLockKey(lock)) : undefined;
    const owned = pid !== undefined && ownsLock(scope, pid);
    const observed = scope?.observedIndex;
    if (bound || owned || (observed?.directory === directory && observed.identity === identity)) {
      matches.push({ directory, identity, bound, pid, lock });
    } else {
      unresolved = true;
    }
  }
  if (matches.length !== 1) return { unresolved: unresolved || matches.length > 1 };
  const [index] = matches;
  const current = await managedEntry(index.directory, 'directory');
  if (!current || `${current.dev}:${current.ino}` !== index.identity) return { unresolved: true };
  if (scope) scope.observedIndex = { identity: index.identity, directory: index.directory };
  return { index, unresolved };
}

async function inspectVectorStore(index: string) {
  const vector = path.join(index, 'index');
  const directory = await managedEntry(vector, 'directory');
  if (!directory) return undefined;
  const metadata = await readReceipt(path.join(vector, 'metadata.json'));
  if (
    typeof metadata?.num_documents !== 'number' ||
    !Number.isSafeInteger(metadata.num_documents) ||
    metadata.num_documents < 1 ||
    typeof metadata.num_chunks !== 'number' ||
    !Number.isSafeInteger(metadata.num_chunks) ||
    metadata.num_chunks < 1
  ) {
    return undefined;
  }
  // > The completion receipt and clean state are written by the native indexer.
  // > These required files provide a cheap check that the core store still exists.
  const files = [
    'metadata.db',
    'centroids.npy',
    'ivf.npy',
    'ivf_lengths.npy',
    'doclens.0.json',
    '0.codes.npy',
    '0.residuals.npy',
  ];
  const last = metadata.num_chunks - 1;
  if (last > 0) files.push(`doclens.${last}.json`, `${last}.codes.npy`, `${last}.residuals.npy`);
  const entries = await Promise.all(
    files.map((name) => managedEntry(path.join(vector, name), 'file')),
  );
  if (entries.every((entry) => entry && entry.size > 0n)) {
    return `${vector}:${directory.dev}:${directory.ino}`;
  }
}

function operationStatus(
  scope: ScopeActivity | undefined,
): Pick<ColgrepStatus, 'activity' | 'diagnostic'> {
  if (scope?.active.size) return { activity: 'checking', diagnostic: null };
  if (scope?.last) return { activity: scope.last.activity, diagnostic: scope.last.diagnostic };
  return { activity: 'idle', diagnostic: null };
}

export async function inspectColgrepIndex(
  indices: string,
  model: string,
  binding: string,
  workspace: RepositoryWorkspace,
): Promise<ColgrepStatus> {
  const key = activityScope(indices, binding, workspace);
  const { index, unresolved } = await findIndex(indices, model, workspace, activities.get(key));
  if (!index) {
    const operation = operationStatus(activities.get(key));
    if (unresolved && operation.activity === 'idle') {
      return {
        availability: 'unknown',
        activity: 'unknown',
        diagnostic: 'ColGREP could not identify the index for this workspace and model.',
      };
    }
    return { availability: unresolved ? 'unknown' : 'not-ready', ...operation };
  }

  const [marker, state, vector] = await Promise.all([
    managedEntry(path.join(index.directory, '.building'), 'file'),
    readState(path.join(index.directory, 'state.json')),
    index.bound ? inspectVectorStore(index.directory) : undefined,
  ]);
  const openLock =
    index.pid === undefined
      ? undefined
      : await managedEntry(path.join(index.directory, '.lock'), 'file');
  const currentPid =
    openLock && index.lock && openLock.dev === index.lock.dev && openLock.ino === index.lock.ino
      ? (await heldIndexLocks())?.get(indexLockKey(openLock))
      : undefined;
  const current = await managedEntry(index.directory, 'directory');
  if (!current || `${current.dev}:${current.ino}` !== index.identity) {
    return {
      availability: 'unknown',
      activity: 'unknown',
      diagnostic: 'ColGREP index storage changed during observation.',
    };
  }
  const scope = activities.get(key);
  const locked = currentPid !== undefined && (index.bound || ownsLock(scope, currentPid));
  const operation = operationStatus(scope);
  if (marker) {
    let { activity, diagnostic } = operation;
    if (locked) activity = 'indexing';
    else if (activity === 'idle') activity = index.lock ? 'unknown' : 'interrupted';
    if (activity === 'indexing' || !diagnostic) {
      diagnostic = 'ColGREP has an incomplete index build.';
    }
    return { availability: 'not-ready', activity, diagnostic };
  }

  if (vector && state?.version === INDEX_FORMAT_VERSION && !state.dirty) {
    const currentScope = rememberScope(key);
    currentScope.observedIndex = { directory: index.directory, identity: index.identity };
    currentScope.readyIndex = vector;
    return {
      availability: 'ready',
      ...(locked ? { activity: 'checking', diagnostic: null } : operation),
    };
  }
  if (state?.dirty && locked) {
    const previouslyReady = vector && scope?.readyIndex === vector;
    return {
      availability: previouslyReady ? 'ready' : 'unknown',
      activity: 'updating',
      diagnostic: null,
    };
  }
  if (state?.dirty && operation.activity === 'idle') {
    return {
      availability: 'unknown',
      activity: index.lock ? 'unknown' : 'interrupted',
      diagnostic: 'ColGREP did not confirm a complete index update.',
    };
  }
  return {
    availability: vector ? 'unknown' : 'not-ready',
    ...operation,
    diagnostic: operation.diagnostic ?? 'ColGREP did not confirm a complete index.',
  };
}

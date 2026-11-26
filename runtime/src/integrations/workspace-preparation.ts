import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export type WorkspacePreparation = {
  environment: Record<string, string>;
  dependencies: string[];
  identityPaths: string[];
  outputHashes: Record<string, string>;
  reusable: boolean;
};

const defaultMaxEntries = 128;

function identity(stat: Stats): string {
  return JSON.stringify([stat.mode, stat.size, stat.dev, stat.ino, stat.uid, stat.gid]);
}

async function statOrMissing(file: string): Promise<Stats | undefined> {
  try {
    return await lstat(file);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readCurrentFile(file: string, expected: Stats): Promise<Buffer | undefined> {
  const expectedIdentity = identity(expected);
  const matches = (stat: Stats) =>
    stat.isFile() &&
    identity(stat) === expectedIdentity &&
    stat.mtimeMs === expected.mtimeMs &&
    stat.ctimeMs === expected.ctimeMs;
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    // > File identity can change between an asynchronous stat and open.
    if (!matches(await handle.stat())) return undefined;
    const bytes = await handle.readFile();
    return matches(await lstat(file)) ? bytes : undefined;
  } finally {
    await handle.close();
  }
}

function matchesOutput(bytes: Buffer, expected: string | undefined): boolean {
  return expected === undefined || createHash('sha256').update(bytes).digest('hex') === expected;
}

async function outputHomeMatches(preparation: WorkspacePreparation): Promise<boolean> {
  const [file] = Object.keys(preparation.outputHashes);
  if (file === undefined) return true;
  const home = preparation.environment.PI_CODING_AGENT_DIR;
  return home !== undefined && path.relative(path.dirname(file), await realpath(home)) === '';
}

async function fingerprint(preparation: WorkspacePreparation): Promise<string | undefined> {
  const hash = createHash('sha256');
  try {
    for (const file of preparation.identityPaths) {
      const stat = await statOrMissing(file);
      if (stat && !stat.isFile() && !stat.isDirectory()) return undefined;
      hash.update(JSON.stringify(file)).update(stat ? identity(stat) : 'missing');
    }
    for (const file of preparation.dependencies) {
      const stat = await statOrMissing(file);
      if (stat && !stat.isFile() && !stat.isDirectory()) return undefined;
      hash.update(JSON.stringify(file)).update(stat ? identity(stat) : 'missing');
      const outputHash = preparation.outputHashes[file];
      if (stat?.isFile()) {
        const bytes = await readCurrentFile(file, stat);
        if (!bytes || !matchesOutput(bytes, outputHash)) return undefined;
        hash.update(bytes);
      } else if (outputHash !== undefined) {
        return undefined;
      }
    }
    if (await outputHomeMatches(preparation)) return hash.digest('hex');
  } catch {
    return undefined;
  }
}

async function outputsMatch(preparation: WorkspacePreparation): Promise<boolean> {
  try {
    for (const [file, expected] of Object.entries(preparation.outputHashes)) {
      const stat = await lstat(file);
      if (!stat.isFile()) return false;
      const bytes = await readCurrentFile(file, stat);
      if (!bytes || !matchesOutput(bytes, expected)) return false;
    }
    return await outputHomeMatches(preparation);
  } catch {
    return false;
  }
}

/** Reuse only while every resolved input and generated configuration remains unchanged. */
export class WorkspacePreparationCache {
  private readonly entries = new Map<
    string,
    { preparation: WorkspacePreparation; fingerprint: string }
  >();
  private tail = Promise.resolve();

  constructor(private readonly options: { maxEntries?: number; signal?: AbortSignal } = {}) {}

  get(
    key: string,
    prepare: () => WorkspacePreparation | Promise<WorkspacePreparation>,
  ): Promise<WorkspacePreparation> {
    // > Different keys can publish to the same Pi home.
    const pending = this.tail.then(() => this.resolve(key, prepare));
    this.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async resolve(
    key: string,
    prepare: () => WorkspacePreparation | Promise<WorkspacePreparation>,
  ): Promise<WorkspacePreparation> {
    const { maxEntries = defaultMaxEntries, signal } = this.options;
    signal?.throwIfAborted();
    const existing = this.entries.get(key);
    this.entries.delete(key);
    if (existing) {
      const observed = await fingerprint(existing.preparation);
      signal?.throwIfAborted();
      if (observed === existing.fingerprint) {
        this.entries.set(key, existing);
        return existing.preparation;
      }
    }
    const preparation = await prepare();
    signal?.throwIfAborted();
    const observed = preparation.reusable ? await fingerprint(preparation) : undefined;
    const published = observed !== undefined || (await outputsMatch(preparation));
    signal?.throwIfAborted();
    if (!published)
      throw new Error('AppRC workspace preparation outputs changed. Retry preparation.');
    if (observed !== undefined) {
      this.entries.set(key, { preparation, fingerprint: observed });
      if (this.entries.size > maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    return preparation;
  }
}

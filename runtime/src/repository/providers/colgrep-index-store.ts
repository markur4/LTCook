import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import Database from 'libsql';

import type { RepositoryWorkspace } from '../workspace.js';

const storageVersion = 'generations-v1';
const generationId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const storageError =
  'ColGREP cannot use its AppRC index storage. Check that the cache is writable and uses local storage.';

const schema = `
  CREATE TABLE IF NOT EXISTS cache_binding (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    identity TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    phase TEXT NOT NULL CHECK (phase IN ('creating', 'writing', 'pending', 'published', 'retired')),
    seeded INTEGER NOT NULL CHECK (seeded IN (0, 1)),
    published_at TEXT,
    host TEXT,
    boot TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS published_generation
    ON generations (phase) WHERE phase = 'published';
  CREATE TABLE IF NOT EXISTS pins (
    token TEXT PRIMARY KEY,
    generation TEXT NOT NULL REFERENCES generations (id),
    host TEXT,
    boot TEXT
  );
  CREATE INDEX IF NOT EXISTS pinned_generation ON pins (generation);
`;

export interface ColgrepIndexGeneration {
  readonly id: string;
  readonly indices: string;
  readonly publishedAt: string;
}

export interface ColgrepIndexCandidate {
  readonly id: string;
  readonly indices: string;
  readonly resumed: boolean;
  readonly seeded: boolean;
}

interface ColgrepIndexPin extends ColgrepIndexGeneration {
  release(): Promise<void>;
}

interface ColgrepIndexWriter {
  candidate(options: { seed: boolean; resume?: boolean }): Promise<ColgrepIndexCandidate>;
  discard(candidate: ColgrepIndexCandidate): Promise<void>;
  publish(candidate: ColgrepIndexCandidate, signal?: AbortSignal): Promise<ColgrepIndexGeneration>;
  release(): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function managedEntry(file: string, kind: 'file' | 'directory'): boolean {
  try {
    const info = lstatSync(file);
    if ((kind === 'file' ? !info.isFile() : !info.isDirectory()) || realpathSync(file) !== file) {
      throw new Error('Linked or invalid managed index storage.');
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function catalogId(row: unknown): string {
  if (
    !row ||
    typeof row !== 'object' ||
    !('id' in row) ||
    typeof row.id !== 'string' ||
    !generationId.test(row.id)
  ) {
    throw new Error('Invalid ColGREP generation identifier.');
  }
  return row.id;
}

function ensureDatabaseFile(file: string): void {
  if (managedEntry(file, 'file')) return;
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR;
  try {
    closeSync(openSync(file, flags, 0o600));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    if (!managedEntry(file, 'file')) throw error;
  }
}

function openDatabase(file: string): Database.Database {
  if (!managedEntry(file, 'file')) throw new Error('The ColGREP catalog file is missing.');
  for (const suffix of ['-journal', '-wal', '-shm']) {
    managedEntry(file + suffix, 'file');
  }
  return new Database(file);
}

function transaction<T>(db: Database.Database, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = run();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function readHostBoot() {
  if (process.platform === 'linux') {
    try {
      const host = readFileSync('/etc/machine-id', 'utf8').trim();
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (/^[a-f0-9]{32}$/.test(host) && generationId.test(boot))
        return { host: stableKey(host), boot: stableKey(boot) };
    } catch {
      // > Unknown boot identity permits reuse only after a writer explicitly released its child.
    }
  }
  return { host: null, boot: null };
}

const currentBoot = readHostBoot();
const resumableCandidate = "(phase = 'pending' OR (phase = 'writing' AND host = ? AND boot <> ?))";

function stableKey(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function isNativeTemporaryFile(file: string): boolean {
  const name = path.basename(file);
  return name === '.lock' || /^state\.\d+\.\d+\.json\.tmp$/.test(name);
}

/**
 * Coordinates independent LTCook processes sharing the AppRC index cache.
 * A short catalog transaction protects publication and pins. A separate
 * database serializes native writers without blocking searches during builds.
 */
export class ColgrepIndexStore {
  private readonly catalog: string;
  private readonly generations: string;

  private constructor(
    private readonly root: string,
    directory: string,
    private readonly workspace: RepositoryWorkspace,
    private readonly binding: string,
  ) {
    this.catalog = path.join(directory, 'catalog.sqlite');
    this.generations = path.join(directory, 'generations');
  }

  static async open(
    cache: string | undefined,
    workspace: RepositoryWorkspace,
    compatibility: string,
    create: true,
  ): Promise<ColgrepIndexStore>;
  static async open(
    cache: string | undefined,
    workspace: RepositoryWorkspace,
    compatibility: string,
    create: boolean,
  ): Promise<ColgrepIndexStore | undefined>;
  static async open(
    cache: string | undefined,
    workspace: RepositoryWorkspace,
    compatibility: string,
    create: boolean,
  ): Promise<ColgrepIndexStore | undefined> {
    await workspace.assertUnchanged();
    try {
      if (!cache || !path.isAbsolute(cache)) throw new Error('Missing AppRC cache path.');
      if (create) await mkdir(cache, { recursive: true, mode: 0o700 });
      const canonical = realpathSync(cache);
      const root = path.join(canonical, storageVersion);
      const worktree = path.join(root, stableKey(workspace.root, compatibility));
      const directory = path.join(worktree, stableKey(workspace.cacheIdentity));
      const binding = stableKey(workspace.root, compatibility, workspace.cacheIdentity);
      const storage = new ColgrepIndexStore(root, directory, workspace, binding);

      for (const target of [root, worktree, directory, storage.generations]) {
        if (create) await mkdir(target, { recursive: true, mode: 0o700 });
        if (!managedEntry(target, 'directory')) {
          if (!create) return undefined;
          throw new Error('The ColGREP index directory is missing.');
        }
      }
      if (create) {
        ensureDatabaseFile(storage.catalog);
        storage.withCatalog(
          (db) =>
            transaction(db, () => {
              db.exec(schema);
              db.prepare('INSERT OR IGNORE INTO cache_binding VALUES (1, ?)').run(binding);
              storage.assertBinding(db);
            }),
          true,
        );
      } else {
        if (!managedEntry(storage.catalog, 'file')) return undefined;
        const initialized = storage.withCatalog((db) => {
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cache_binding'").get())
            return false;
          storage.assertBinding(db);
          return true;
        }, true);
        if (!initialized) return undefined;
      }
      return storage;
    } catch (error) {
      if (!create && isMissing(error)) return undefined;
      throw new Error(storageError, { cause: error });
    }
  }

  private assertBinding(db: Database.Database): void {
    if (
      db.prepare('SELECT identity FROM cache_binding WHERE singleton = 1').pluck().get() !==
      this.binding
    ) {
      throw new Error('The ColGREP catalog belongs to a different worktree or index format.');
    }
  }

  private withCatalog<T>(run: (db: Database.Database) => T, initializing = false): T {
    try {
      const db = openDatabase(this.catalog);
      try {
        db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000');
        if (!initializing) this.assertBinding(db);
        return run(db);
      } finally {
        db.close();
      }
    } catch (error) {
      throw new Error(storageError, { cause: error });
    }
  }

  private generationDirectory(id: string): string {
    if (!generationId.test(id)) throw new Error('Invalid ColGREP generation identifier.');
    return path.join(this.generations, id);
  }

  private indices(id: string): string {
    return path.join(this.generationDirectory(id), 'indices');
  }

  private published(db: Database.Database): ColgrepIndexGeneration | undefined {
    const row = db
      .prepare("SELECT id, published_at FROM generations WHERE phase = 'published'")
      .get();
    if (!row) return undefined;
    const id = catalogId(row);
    if (
      typeof row !== 'object' ||
      !('published_at' in row) ||
      typeof row.published_at !== 'string'
    ) {
      throw new Error('Invalid ColGREP publication receipt.');
    }
    const indices = this.indices(id);
    if (managedEntry(indices, 'directory')) return { id, indices, publishedAt: row.published_at };
  }

  async readPublished(): Promise<ColgrepIndexGeneration | undefined> {
    await this.workspace.assertUnchanged();
    return this.withCatalog((db) => this.published(db));
  }

  async pinPublished(): Promise<ColgrepIndexPin | undefined> {
    await this.workspace.assertUnchanged();
    const token = randomUUID();
    const pinned = this.withCatalog((db) =>
      transaction(db, () => {
        const publication = this.published(db);
        if (!publication) return undefined;
        db.prepare('INSERT INTO pins VALUES (?, ?, ?, ?)').run(
          token,
          publication.id,
          currentBoot.host,
          currentBoot.boot,
        );
        return publication;
      }),
    );
    if (!pinned) return undefined;
    return {
      ...pinned,
      release: async () => {
        this.withCatalog((db) => db.prepare('DELETE FROM pins WHERE token = ?').run(token));
        await this.collectRetired().catch(() => undefined);
      },
    };
  }

  async invalidatePublished(id: string): Promise<boolean> {
    await this.workspace.assertUnchanged();
    const changed = this.withCatalog((db) =>
      db
        .prepare("UPDATE generations SET phase = 'retired' WHERE id = ? AND phase = 'published'")
        .run(id),
    ).changes;
    if (changed) await this.collectRetired().catch(() => undefined);
    return !!changed;
  }

  private async collectRetired(): Promise<void> {
    const retired = this.withCatalog((db) =>
      transaction(db, () => {
        db.prepare('DELETE FROM pins WHERE host = ? AND boot <> ?').run(
          currentBoot.host,
          currentBoot.boot,
        );
        return db
          .prepare(
            `SELECT id FROM generations AS generation WHERE phase = 'retired'
             AND NOT EXISTS (SELECT 1 FROM pins WHERE generation = generation.id)`,
          )
          .all()
          .map(catalogId);
      }),
    );
    for (const id of retired) {
      const directory = this.generationDirectory(id);
      if (managedEntry(directory, 'directory')) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          // > Leave the retirement receipt so a later operation can retry removal.
          continue;
        }
      }
      this.withCatalog((db) => db.prepare('DELETE FROM generations WHERE id = ?').run(id));
    }
  }

  private async copyPublishedTo(destination: string): Promise<boolean> {
    const seed = await this.pinPublished();
    if (!seed) return false;
    try {
      await cp(seed.indices, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        mode: constants.COPYFILE_FICLONE,
        filter: (source) => {
          if (isNativeTemporaryFile(source)) return false;
          const info = lstatSync(source);
          if ((!info.isDirectory() && !info.isFile()) || realpathSync(source) !== source) {
            throw new Error('Linked or invalid file in the ColGREP index.');
          }
          return true;
        },
      });
      return true;
    } finally {
      await seed.release();
    }
  }

  private async prepareCandidate(
    options: { seed: boolean; resume?: boolean },
    setCandidate: (candidate: ColgrepIndexCandidate) => void,
  ): Promise<ColgrepIndexCandidate> {
    await this.workspace.assertUnchanged();
    const candidate = this.withCatalog((db) =>
      transaction(db, () => {
        // > Native indexing hasn't started until a candidate reaches the writing phase.
        db.prepare("UPDATE generations SET phase = 'retired' WHERE phase = 'creating'").run();
        if (options.resume !== false) {
          const row = db
            .prepare(
              `SELECT id, seeded FROM generations WHERE ${resumableCandidate}
               ORDER BY phase = 'pending' DESC, rowid DESC LIMIT 1`,
            )
            .get(currentBoot.host, currentBoot.boot);
          if (row) {
            const id = catalogId(row);
            const indices = this.indices(id);
            if (managedEntry(indices, 'directory')) {
              db.prepare(
                "UPDATE generations SET phase = 'writing', host = ?, boot = ? WHERE id = ?",
              ).run(currentBoot.host, currentBoot.boot, id);
              this.retireAbandonedCandidates(db);
              return {
                id,
                indices,
                resumed: true,
                seeded: typeof row === 'object' && 'seeded' in row && row.seeded === 1,
              };
            }
          }
        }
        this.retireAbandonedCandidates(db);
        const id = randomUUID();
        db.prepare("INSERT INTO generations VALUES (?, 'creating', 0, NULL, ?, ?)").run(
          id,
          currentBoot.host,
          currentBoot.boot,
        );
        return { id, indices: this.indices(id), resumed: false, seeded: false };
      }),
    );
    setCandidate(candidate);
    if (candidate.resumed) return Object.freeze(candidate);

    await mkdir(this.generationDirectory(candidate.id), { mode: 0o700 });
    candidate.seeded = options.seed && (await this.copyPublishedTo(candidate.indices));
    if (!candidate.seeded) await mkdir(candidate.indices, { mode: 0o700 });
    this.withCatalog((db) =>
      db
        .prepare("UPDATE generations SET phase = 'writing', seeded = ? WHERE id = ?")
        .run(Number(candidate.seeded), candidate.id),
    );
    return Object.freeze(candidate);
  }

  private retireAbandonedCandidates(db: Database.Database): void {
    db.prepare(`UPDATE generations SET phase = 'retired' WHERE ${resumableCandidate}`).run(
      currentBoot.host,
      currentBoot.boot,
    );
  }

  async tryWriter(): Promise<ColgrepIndexWriter | undefined> {
    await this.workspace.assertUnchanged();
    const file = path.join(this.root, 'writer.sqlite');
    let writer: Database.Database | undefined;
    try {
      ensureDatabaseFile(file);
      writer = openDatabase(file);
      writer.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
    } catch (error) {
      writer?.close();
      if (
        error instanceof Database.SqliteError &&
        (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
      ) {
        return undefined;
      }
      throw new Error(storageError, { cause: error });
    }

    const lock = writer;
    let released = false;
    let candidate: ColgrepIndexCandidate | undefined;
    let preparing = false;
    const assertOwned = (owned: ColgrepIndexCandidate) => {
      if (released || preparing || owned !== candidate)
        throw new Error('The ColGREP writer does not own this candidate.');
    };
    return {
      candidate: async (options) => {
        if (released || preparing || candidate)
          throw new Error('The ColGREP writer already has or cannot prepare a candidate.');
        preparing = true;
        try {
          return await this.prepareCandidate(options, (prepared) => (candidate = prepared));
        } finally {
          preparing = false;
        }
      },
      discard: async (owned) => {
        assertOwned(owned);
        this.withCatalog((db) =>
          db.prepare("UPDATE generations SET phase = 'retired' WHERE id = ?").run(owned.id),
        );
        candidate = undefined;
        await this.collectRetired().catch(() => undefined);
      },
      publish: async (owned, signal) => {
        assertOwned(owned);
        await this.workspace.assertUnchanged();
        assertOwned(owned);
        signal?.throwIfAborted();
        const publishedAt = new Date().toISOString();
        const indices = this.indices(owned.id);
        if (!managedEntry(indices, 'directory'))
          throw new Error('The ColGREP candidate is missing.');
        signal?.throwIfAborted();
        this.withCatalog((db) =>
          transaction(db, () => {
            db.prepare("UPDATE generations SET phase = 'retired' WHERE phase = 'published'").run();
            const publication = db
              .prepare(
                `UPDATE generations SET phase = 'published', published_at = ?
                 WHERE id = ? AND phase = 'writing'`,
              )
              .run(publishedAt, owned.id);
            if (publication.changes !== 1)
              throw new Error('The ColGREP candidate cannot be published.');
          }),
        );
        candidate = undefined;
        // > Publication already committed. A failed cleanup can be retried by a later operation.
        await this.collectRetired().catch(() => undefined);
        return { id: owned.id, indices, publishedAt };
      },
      release: async () => {
        if (released) return;
        if (preparing)
          throw new Error('Wait for the ColGREP candidate to finish preparation first.');
        released = true;
        try {
          if (candidate) {
            const id = candidate.id;
            this.withCatalog((db) =>
              db
                .prepare(
                  `UPDATE generations SET phase = CASE phase
                   WHEN 'writing' THEN 'pending' ELSE 'retired' END WHERE id = ?`,
                )
                .run(id),
            );
          }
        } finally {
          try {
            lock.exec('ROLLBACK');
          } finally {
            lock.close();
          }
        }
        await this.collectRetired().catch(() => undefined);
      },
    };
  }
}

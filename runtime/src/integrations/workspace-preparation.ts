import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';

export type WorkspacePreparation = {
  environment: Record<string, string>;
  dependencies: string[];
};

function fingerprint(paths: string[]): string {
  const hash = createHash('sha256');
  for (const file of paths) {
    hash.update(JSON.stringify(file));
    try {
      const stat = lstatSync(file);
      hash.update(JSON.stringify([stat.mode, stat.size, stat.dev, stat.ino]));
      if (stat.isSymbolicLink()) hash.update(readlinkSync(file));
      if (!stat.isDirectory()) hash.update(readFileSync(file));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      hash.update('missing');
    }
  }
  return hash.digest('hex');
}

/** Reuse only while every resolved input and generated configuration remains unchanged. */
export class WorkspacePreparationCache {
  private readonly entries = new Map<
    string,
    { preparation: WorkspacePreparation; fingerprint: string }
  >();
  private readonly pending = new Map<string, Promise<WorkspacePreparation>>();

  async get(key: string, prepare: () => WorkspacePreparation): Promise<WorkspacePreparation> {
    const existing = this.entries.get(key);
    if (existing && fingerprint(existing.preparation.dependencies) === existing.fingerprint)
      return existing.preparation;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const task = Promise.resolve().then(() => {
      const preparation = prepare();
      this.entries.set(key, { preparation, fingerprint: fingerprint(preparation.dependencies) });
      return preparation;
    });
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }
}

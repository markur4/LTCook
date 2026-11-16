import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

export type WorkspacePreparation = {
  environment: Record<string, string>;
  dependencies: string[];
  identityPaths: string[];
  reusable: boolean;
};

function fingerprint(preparation: WorkspacePreparation): string | undefined {
  const hash = createHash('sha256');
  for (const file of preparation.identityPaths) {
    hash.update(JSON.stringify(file));
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() && !stat.isDirectory()) return undefined;
      hash.update(JSON.stringify([stat.mode, stat.size, stat.dev, stat.ino, stat.uid, stat.gid]));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return undefined;
      hash.update('missing');
    }
  }
  for (const file of preparation.dependencies) {
    hash.update(JSON.stringify(file));
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() && !stat.isDirectory()) return undefined;
      hash.update(JSON.stringify([stat.mode, stat.size, stat.dev, stat.ino, stat.uid, stat.gid]));
      if (stat.isFile()) hash.update(readFileSync(file));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) return undefined;
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
  async get(key: string, prepare: () => WorkspacePreparation): Promise<WorkspacePreparation> {
    const existing = this.entries.get(key);
    if (existing) {
      const observed = fingerprint(existing.preparation);
      if (observed !== undefined && observed === existing.fingerprint) return existing.preparation;
    }
    this.entries.delete(key);
    // > Preparation is synchronous; publish reusable results before the next caller can run.
    const preparation = prepare();
    if (preparation.reusable) {
      const observed = fingerprint(preparation);
      if (observed !== undefined) this.entries.set(key, { preparation, fingerprint: observed });
    }
    return preparation;
  }
}

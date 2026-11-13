import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** Resolves workspace identity even when its path does not exist yet. */
export function canonicalWorkspace(workspaceRoot: string): string {
  try {
    return realpathSync(workspaceRoot);
  } catch {
    return resolve(workspaceRoot);
  }
}

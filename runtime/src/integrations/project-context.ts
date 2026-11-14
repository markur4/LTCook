import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectSnapshot } from '../workflow-api/index.js';

const execute = promisify(execFile);

/** Translate declarations through the stdlib-only Python owner, without project scripts. */
export function projectContextProvider(
  python: string,
  cacheDirectory: string,
): (workspaceRoot: string) => Promise<ProjectSnapshot> {
  return async (workspaceRoot) => {
    const { stdout } = await execute(
      python,
      ['-m', 'ltcook.project_context', '--workspace', workspaceRoot, '--cache-dir', cacheDirectory],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    return JSON.parse(stdout) as ProjectSnapshot;
  };
}

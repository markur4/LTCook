import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isWithin } from '../path-containment.js';
import type { RepositoryWorkspace } from './workspace.js';

export class RepositoryCommandError extends Error {
  constructor(readonly code: 'timeout' | 'output-limit') {
    super(
      code === 'timeout'
        ? 'Discovery command timed out'
        : 'Discovery command exceeded its output limit',
    );
  }
}

function externalPathEntries(value: string, workspace: RepositoryWorkspace): string[] {
  return value.split(path.delimiter).flatMap((entry) => {
    if (!path.isAbsolute(entry) || isWithin(workspace.root, entry, true)) return [];
    try {
      const actual = realpathSync(entry);
      return isWithin(workspace.root, actual, true) ? [] : [actual];
    } catch {
      return [];
    }
  });
}

export function findRepositoryExecutable(
  name: string,
  pathValue: string,
  workspace: RepositoryWorkspace,
): string | undefined {
  const extensions = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const entry of externalPathEntries(pathValue, workspace)) {
    for (const extension of extensions) {
      try {
        const actual = realpathSync(path.join(entry, name + extension));
        if (isWithin(workspace.root, actual, true) || !statSync(actual).isFile()) continue;
        if (process.platform !== 'win32') accessSync(actual, constants.X_OK);
        return actual;
      } catch {
        // > An unavailable tool is an observation, not a scan failure.
      }
    }
  }
  return undefined;
}

export async function runRepositoryCommand(
  command: string,
  args: string[],
  workspace: RepositoryWorkspace,
  pathValue: string,
  {
    timeoutMs,
    maxBytes,
    env = {},
  }: { timeoutMs: number; maxBytes: number; env?: Record<string, string> },
): Promise<{ stdout: string; code: number }> {
  if (!path.isAbsolute(command) || isWithin(workspace.root, realpathSync(command), true))
    throw new Error('Repository discovery requires a tool outside the workspace');
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: workspace.root,
      env: {
        ...(process.platform === 'win32' && process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
        NO_COLOR: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        ...env,
        PATH: externalPathEntries(pathValue, workspace).join(path.delimiter),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stopped = false;
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    function stop(code: RepositoryCommandError['code']) {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new RepositoryCommandError(code));
    }
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop('output-limit');
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (!stopped) accept({ stdout: Buffer.concat(chunks).toString('utf8'), code: code ?? -1 });
    });
  });
}

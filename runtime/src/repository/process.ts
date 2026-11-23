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
    signal,
    stopAfterLine,
  }: {
    timeoutMs: number;
    maxBytes: number;
    env?: Record<string, string>;
    signal?: AbortSignal;
    stopAfterLine?: (line: string) => boolean;
  },
): Promise<{ stdout: string; code: number; stopped: boolean }> {
  signal?.throwIfAborted();
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
    const chunks: string[] = [];
    let pendingLine = '';
    let bytes = 0;
    let stopped = false;
    let failure: unknown;
    const timer = setTimeout(() => stop(new RepositoryCommandError('timeout')), timeoutMs);
    const cancel = () => stop(signal?.reason ?? new Error('Repository command cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    function stop(error?: unknown) {
      if (stopped) return;
      stopped = true;
      failure = error;
      clearTimeout(timer);
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stopped) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        stop(new RepositoryCommandError('output-limit'));
        return;
      }
      if (!stopAfterLine) {
        chunks.push(chunk);
        return;
      }
      const lines = (pendingLine + chunk).split('\n');
      pendingLine = lines.pop() ?? '';
      for (const line of lines) {
        try {
          if (!stopAfterLine(line)) continue;
          stop();
        } catch (error) {
          stop(error);
        }
        break;
      }
    });
    child.stderr.resume();
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (failure !== undefined) reject(failure);
      else accept({ stdout: chunks.join(''), code: code ?? -1, stopped });
    });
  });
}

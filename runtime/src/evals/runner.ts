import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  sanitizeEvaluationText,
  type EvaluationCapture,
  type EvaluationDiagnostics,
} from './diagnostics.js';

export const EVALUATION_STOP_FILE = 'stop.requested';

export type Arm = 'minimal' | 'complete';
export type Scenario = 'read-only' | 'no-op' | 'targeted-fix';
export type EvaluationJob = {
  directory: string;
  appRoot: string;
  nodeExecutable: string;
  teamSelection: string;
  arm: Arm;
  scenario: Scenario;
  thinking: 'off' | 'low';
  endpoint: string;
  timeoutMs: number;
  webConfiguration: Record<string, unknown>;
};
export type EvaluationResult = {
  success: boolean;
  failure?: string;
  failureCategory?: string;
  diagnostics?: EvaluationDiagnostics;
  elapsedMs: number;
  toolCalls: number;
  delegations?: number;
  instructions: { effectivePrompt?: string; promptSha256?: string; resources: unknown[] };
  trace: { traceEvents: unknown[] };
  limitations?: string[];
};

/** Recover worker-produced checkpoints as explicitly incomplete failure evidence after forced termination. */
export async function readIncompleteEvaluationResult(
  directory: string,
  reason: 'cancelled' | 'limits',
  elapsedMs: number,
): Promise<EvaluationResult | undefined> {
  const state = path.join(directory, 'deployment/state');
  let capture: EvaluationCapture | undefined;
  let trace: EvaluationResult['trace'] | undefined;
  try {
    const value = JSON.parse(
      await readFile(path.join(state, 'diagnostics.json'), 'utf8'),
    ) as EvaluationCapture;
    if (
      value &&
      typeof value === 'object' &&
      value.diagnostics &&
      [
        'recentEvents',
        'modelFailures',
        'toolFailures',
        'runtimeFailures',
        'activeAgents',
        'activeModels',
        'activeTools',
      ].every((key) => Array.isArray(value.diagnostics[key as keyof EvaluationDiagnostics])) &&
      typeof value.toolCalls === 'number' &&
      Number.isInteger(value.toolCalls) &&
      value.toolCalls >= 0
    )
      capture = value;
  } catch {
    /* A kill can precede the first atomic checkpoint. */
  }
  try {
    const value = JSON.parse(
      await readFile(path.join(state, 'trace.json'), 'utf8'),
    ) as EvaluationResult['trace'];
    if (value && Array.isArray(value.traceEvents)) trace = value;
  } catch {
    /* Available metadata is still useful if no trace was exported. */
  }
  if (!capture && !trace) return undefined;
  return {
    success: false,
    failureCategory: reason,
    failure:
      reason === 'cancelled'
        ? 'Evaluation cancelled; active-attempt capture is incomplete'
        : 'Evaluation time budget expired; active-attempt capture is incomplete',
    elapsedMs,
    toolCalls:
      capture?.toolCalls ??
      trace?.traceEvents.filter(
        (event) =>
          event &&
          typeof event === 'object' &&
          'name' in event &&
          event.name === 'evaluation.tool.start',
      ).length ??
      0,
    diagnostics: {
      ...(capture?.diagnostics ?? {
        recentEvents: [],
        modelFailures: [],
        toolFailures: [],
        runtimeFailures: [],
        activeAgents: [],
        activeModels: [],
        activeTools: [],
      }),
      captureIncomplete: true,
    },
    instructions: { resources: [] },
    trace: trace ?? { traceEvents: [] },
    limitations: [
      'Forced termination prevented final export; recovered active-attempt diagnostics, tool counts and trace cover only the exported prefix and may be incomplete.',
    ],
  };
}

export function assertEvaluationSandbox(): void {
  if (process.platform !== 'linux')
    throw new Error('Behavior Evaluation requires Linux/WSL and Bubblewrap.');
  const probe = spawnSync(
    'bwrap',
    [
      '--ro-bind',
      '/',
      '/',
      '--unshare-pid',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--',
      '/usr/bin/true',
    ],
    { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', HOME: '/tmp' } },
  );
  if (probe.status !== 0)
    throw new Error(
      'Bubblewrap sandbox is unavailable; install Bubblewrap and permit user namespaces.',
    );
}

/** Spawn the production controller/host/Pi tree inside an isolated filesystem and PID namespace. */
export async function runTask(job: EvaluationJob, signal: AbortSignal): Promise<EvaluationResult> {
  signal.throwIfAborted();
  const started = performance.now();
  const node = await realpath(job.nodeExecutable);
  await mkdir(path.join(job.directory, 'deployment'), { recursive: true });
  await symlink(job.appRoot, path.join(job.directory, 'deployment/app'));
  await writeFile(path.join(job.directory, 'job.json'), JSON.stringify(job), { mode: 0o600 });
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ];
  for (const directory of ['/usr', '/bin', '/sbin', '/lib', '/lib64'])
    if (existsSync(directory)) args.push('--ro-bind', directory, directory);
  for (const file of [
    '/etc/resolv.conf',
    '/etc/hosts',
    '/etc/nsswitch.conf',
    '/etc/passwd',
    '/etc/group',
    '/etc/ssl',
  ])
    if (existsSync(file)) args.push('--ro-bind', file, file);
  for (const directory of ['runtime', 'teams', 'node_modules']) {
    const source = path.join(job.appRoot, directory);
    if (existsSync(source)) args.push('--ro-bind', source, source);
  }
  const manifest = path.join(job.appRoot, 'package.json');
  if (existsSync(manifest)) args.push('--ro-bind', manifest, manifest);
  if (!node.startsWith('/usr/') && !node.startsWith('/bin/')) args.push('--ro-bind', node, node);
  args.push(
    '--bind',
    job.directory,
    job.directory,
    '--chdir',
    path.join(job.directory, 'workspace'),
    '--',
    node,
    path.join(job.appRoot, 'runtime/dist/evals/worker.js'),
    path.join(job.directory, 'job.json'),
  );
  const environment = {
    PATH: `${path.dirname(node)}:/usr/bin:/bin`,
    HOME: path.join(job.directory, 'deployment/home'),
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    PI_OFFLINE: '1',
    DO_NOT_TRACK: '1',
  };
  const child = spawn('bwrap', args, {
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  child.stdout.resume();
  let force: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let stopWrite = Promise.resolve();
  let stopRequested = false;
  const terminate = () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* Process may already have exited. */
      }
      force ??= setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }, 2000);
    }
  };
  const requestStop = (reason: 'cancelled' | 'limits') => {
    if (stopRequested || child.exitCode !== null || child.signalCode !== null) return;
    stopRequested = true;
    const temporary = path.join(job.directory, `${EVALUATION_STOP_FILE}.tmp`);
    stopWrite = writeFile(temporary, reason, {
      mode: 0o600,
    })
      .then(() => rename(temporary, path.join(job.directory, EVALUATION_STOP_FILE)))
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') terminate();
      });
    grace = setTimeout(terminate, 10000);
  };
  const abort = () => requestStop(signal.reason?.name === 'TimeoutError' ? 'limits' : 'cancelled');
  const timeout = setTimeout(() => requestStop('limits'), job.timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    await stopWrite;
    if (code !== 0 && !signal.aborted && !stopRequested)
      throw new Error(
        `Evaluation sandbox process failed (${code}); ${sanitizeEvaluationText(stderr)}`,
      );
    let result: EvaluationResult;
    try {
      result = JSON.parse(
        await readFile(path.join(job.directory, 'output.json'), 'utf8'),
      ) as EvaluationResult;
    } catch (error) {
      let recovered: EvaluationResult | undefined;
      if (signal.aborted || stopRequested) {
        const reason =
          signal.reason?.name === 'TimeoutError' || !signal.aborted ? 'limits' : 'cancelled';
        recovered = await readIncompleteEvaluationResult(
          job.directory,
          reason,
          performance.now() - started,
        );
      }
      if (!recovered) {
        signal.throwIfAborted();
        throw error;
      }
      result = recovered;
    }
    const end = Number(process.hrtime.bigint() / 1000n);
    const events = result.trace.traceEvents as Array<Record<string, unknown>>;
    const childEnd = Math.max(
      0,
      ...events.map((event) => Number(event.ts) + Number(event.dur ?? 0)),
    );
    result.trace.traceEvents = events.map((event) => ({
      ...event,
      pid: child.pid,
      ts: Number(event.ts) + end - childEnd,
    }));
    return result;
  } finally {
    clearTimeout(timeout);
    if (grace) clearTimeout(grace);
    if (force) clearTimeout(force);
    signal.removeEventListener('abort', abort);
    await stopWrite;
  }
}

export function aggregate(tasks: Array<{ arm: Arm; success: boolean; elapsedMs: number }>) {
  return (['minimal', 'complete'] as const).map((arm) => {
    const cases = tasks.filter((task) => task.arm === arm);
    const values = cases.map((task) => task.elapsedMs);
    return {
      arm,
      tasks: cases.length,
      successes: cases.filter((task) => task.success).length,
      meanTotalElapsedMs: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      minElapsedMs: values.length ? Math.min(...values) : null,
      maxElapsedMs: values.length ? Math.max(...values) : null,
    };
  });
}

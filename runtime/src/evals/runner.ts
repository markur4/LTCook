import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

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
  elapsedMs: number;
  toolCalls: number;
  delegations?: number;
  instructions: { effectivePrompt?: string; promptSha256?: string; resources: unknown[] };
  trace: { traceEvents: unknown[] };
  limitations?: string[];
};

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
  const terminate = () => {
    if (child.pid && child.exitCode === null) {
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
  const timeout = setTimeout(terminate, job.timeoutMs + 60000);
  signal.addEventListener('abort', terminate, { once: true });
  if (signal.aborted) terminate();
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    signal.throwIfAborted();
    if (code !== 0)
      throw new Error(
        `Evaluation sandbox process failed (${code}); ${stderr.replace(/(?:\/home\/[^\s]+|\/tmp\/[^\s]+)/g, '<private-path>')}`,
      );
    const result = JSON.parse(
      await readFile(path.join(job.directory, 'output.json'), 'utf8'),
    ) as EvaluationResult;
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
    if (force) clearTimeout(force);
    signal.removeEventListener('abort', terminate);
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

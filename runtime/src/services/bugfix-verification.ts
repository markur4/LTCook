import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { isWithin } from '../path-containment.js';

const systemPaths = ['/usr', '/bin', '/sbin', '/lib', '/lib64'];
const brew = '/home/linuxbrew/.linuxbrew';
const toolDirectory = '/ltcook-check-tools';

async function executable(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function verificationRepository(directory: string, tree: string) {
  if (!/^[a-f0-9]{40}$/.test(tree))
    throw new Error('Verification requires a single supported candidate Git tree.');
  const scratch = await mkdtemp(path.join(tmpdir(), 'ltcook-bugfix-check-git-'));
  const cleanup = () => rm(scratch, { recursive: true, force: true });
  try {
    const env = {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'LTCook Verification',
      GIT_AUTHOR_EMAIL: 'verification@localhost',
      GIT_COMMITTER_NAME: 'LTCook Verification',
      GIT_COMMITTER_EMAIL: 'verification@localhost',
    };
    const git = (cwd: string, args: string[], input?: Buffer | string) =>
      execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
        env,
        input,
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    const metadata = git(directory, ['rev-parse', '--absolute-git-dir']).toString().trim();
    if (!path.isAbsolute(metadata) || metadata === path.join(directory, '.git'))
      throw new Error('Verification requires a linked repair worktree.');
    // Include only the candidate tree and a synthetic root commit. The real
    // repository's configuration, refs, hooks, history, and alternates stay outside.
    const pack = git(directory, ['pack-objects', '--stdout', '--revs'], `${tree}\n`);
    git(scratch, ['init', '--bare', '--template=']);
    git(scratch, ['index-pack', '--stdin'], pack);
    const commit = git(scratch, [
      '-c',
      'commit.gpgSign=false',
      'commit-tree',
      tree,
      '-m',
      'Verification snapshot',
    ])
      .toString()
      .trim();
    git(scratch, ['update-ref', 'HEAD', commit]);
    git(scratch, ['config', 'core.bare', 'false']);
    git(scratch, ['config', 'core.worktree', directory]);
    return { args: ['--ro-bind', scratch, metadata], cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Run candidate code without exposing the parent environment, network, or writable checkout. */
export async function bugFixVerificationCommand(
  directory: string,
  tree: string,
): Promise<{ args: string[]; env: NodeJS.ProcessEnv; cleanup?: () => Promise<void> }> {
  if (process.platform !== 'linux' || !(await executable(['/usr/bin/bwrap'])))
    throw new Error('BugFix verification requires the supported Linux Bubblewrap sandbox.');

  const home = homedir();
  const just = await executable([
    '/usr/local/bin/just',
    '/usr/bin/just',
    path.join(home, '.local/bin/just'),
    path.join(home, '.cargo/bin/just'),
    `${brew}/bin/just`,
  ]);
  const bun = await executable([
    '/usr/local/bin/bun',
    '/usr/bin/bun',
    path.join(home, '.bun/bin/bun'),
  ]);
  const uv = await executable([
    '/usr/local/bin/uv',
    '/usr/bin/uv',
    path.join(home, '.local/bin/uv'),
  ]);
  const configuredNode = process.env.LTCOOK_NODE_EXECUTABLE;
  if (configuredNode && !path.isAbsolute(configuredNode))
    throw new Error('The configured Node verification executable must be an absolute path.');
  const node = await executable([
    ...(configuredNode ? [configuredNode] : []),
    ...(process.versions.bun ? [] : [process.execPath]),
    '/usr/local/bin/node',
    '/usr/bin/node',
  ]);
  if (!just || !bun || !uv || !node)
    throw new Error('Could not locate the supported just, Bun, uv, and Node verification tools.');

  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--ro-bind',
    directory,
    directory,
  ];
  for (const systemPath of systemPaths) args.push('--ro-bind-try', systemPath, systemPath);
  for (const [name, binary] of Object.entries({ just, bun, uv, node }))
    args.push('--ro-bind', binary, `${toolDirectory}/${name}`);

  const venv = path.join(directory, '.venv');
  if ((await realpath(path.join(venv, 'bin'))) !== path.join(venv, 'bin'))
    throw new Error('The checkout virtual environment must stay in the verification worktree.');
  const python = await realpath(path.join(venv, 'bin/python'));
  if (!systemPaths.some((systemPath) => isWithin(systemPath, python))) {
    const distribution = path.dirname(path.dirname(python));
    const uvPythons = path.join(home, '.local/share/uv/python');
    if (path.dirname(distribution) !== uvPythons)
      throw new Error(
        'The checkout Python interpreter is outside the supported verification tools.',
      );
    args.push('--ro-bind', distribution, distribution);
    // uv venvs can refer to a minor-version symlink in addition to the concrete distribution.
    const alias = path.join(
      uvPythons,
      path.basename(distribution).replace(/(\d+\.\d+)\.\d+/, '$1'),
    );
    if (alias !== distribution && (await realpath(alias).catch(() => undefined)) === distribution)
      args.push('--symlink', distribution, alias);
  }

  const recipe = [`${toolDirectory}/just`];
  if (isWithin(`${brew}/Cellar`, just)) {
    const loader = `${brew}/lib/ld.so`;
    args.push('--ro-bind', await realpath(loader), loader);
  }

  const metadata = await verificationRepository(directory, tree);
  return {
    args: [...args, ...metadata.args, '--dir', '/tmp/home', '--chdir', directory, '--', ...recipe],
    cleanup: metadata.cleanup,
    env: {
      PATH: `${toolDirectory}:/usr/bin:/bin`,
      HOME: '/tmp/home',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      LTCOOK_RUNTIME_STATE_DIR: '/tmp/ltcook-runtime',
      UV_OFFLINE: '1',
      UV_PROJECT_ENVIRONMENT: venv,
      UV_CACHE_DIR: '/tmp/uv-cache',
      BUN_INSTALL_CACHE_DIR: '/tmp/bun-cache',
      PYTHONPYCACHEPREFIX: '/tmp/python-cache',
      PYTEST_ADDOPTS: '-o cache_dir=/tmp/pytest-cache',
      RUFF_CACHE_DIR: '/tmp/ruff-cache',
    },
  };
}

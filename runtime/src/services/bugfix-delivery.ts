import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isWithin } from '../path-containment.js';
import { bugFixVerificationCommand } from './bugfix-verification.js';
import type {
  BugFixActionResult,
  BugFixBatch,
  BugFixReconciliation,
  BugFixRemedy,
  BugFixStage,
  BugFixTargetEvidence,
} from './bugfix.js';

type Command = 'git' | 'gh' | 'just' | '/usr/bin/bwrap';
type CommandInput = {
  command: Command;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
};
type CommandResult = { code: number; stdout: string; stderr: string };
type CommandRunner = (input: CommandInput) => Promise<CommandResult>;

class DeliveryBlocked extends Error {}

interface DeliveryOptions {
  worktreeDirectory: string;
  authorize(batch: BugFixBatch, action: BugFixStage): boolean | void;
  allowedPath(batch: BugFixBatch, relativePath: string): boolean;
  expectedRemote(batch: BugFixBatch): string | undefined;
  qualified(): boolean;
  allowUnsigned?(batch: BugFixBatch): boolean;
  recheck?(
    batch: BugFixBatch,
    remedy: BugFixRemedy,
    target: string,
    signal: AbortSignal,
  ): Promise<BugFixTargetEvidence>;
  run?: CommandRunner;
  verificationCommand?: typeof bugFixVerificationCommand;
}

const objectId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const githubRemote =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)\/?$/i;
const pullRequests = z.array(
  z.object({
    number: z.number().int().positive(),
    url: z.string(),
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
    headRefOid: z.string(),
    headRefName: z.string(),
    baseRefName: z.string(),
    isDraft: z.boolean(),
    isCrossRepository: z.boolean(),
    mergeCommit: z.object({ oid: z.string() }).nullable(),
  }),
);

async function execute({
  command,
  args,
  cwd,
  env,
  signal,
  timeout,
}: CommandInput): Promise<CommandResult> {
  signal.throwIfAborted();
  const context: NodeJS.ProcessEnv =
    command === '/usr/bin/bwrap'
      ? { ...env }
      : {
          ...process.env,
          ...env,
          GIT_TERMINAL_PROMPT: '0',
          GH_PROMPT_DISABLED: '1',
          GH_HOST: 'github.com',
        };
  for (const key of Object.keys(context))
    if (key.startsWith('GIT_') && !Object.hasOwn(env ?? {}, key) && key !== 'GIT_TERMINAL_PROMPT')
      delete context[key];
  const group = process.platform !== 'win32';
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: context,
      detached: group,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let failure = false;
    let bytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stop = () => {
      if (failure) return;
      failure = true;
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // > A process that already exited is reconciled by the close handler.
      }
    };
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4_194_304) stop();
      else if (!failure) chunks.push(chunk);
    };
    const timer = setTimeout(stop, timeout);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', stop);
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      if (failure || code === null)
        reject(new Error(`The ${command} operation was interrupted or unavailable.`));
      else
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        });
    });
  });
}

function hash(value: string): string {
  const candidate = value.trim();
  if (!objectId.test(candidate)) throw new Error('Git did not report an exact object ID.');
  return candidate;
}

function remoteName(url: string): string {
  const match = githubRemote.exec(url.trim());
  if (!match) throw new Error('BugFix delivery requires an approved GitHub origin.');
  const name = match[1]!.replace(/\.git$/i, '').toLowerCase();
  if (
    !/^[\w-]+\/[\w.-]+$/.test(name) ||
    name.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('Git origin has an invalid repository identity.');
  return name;
}

function checkRef(branch: string): string {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,159}$/.test(branch) ||
    branch.split('/').some((part) => !part || part.endsWith('.lock'))
  )
    throw new Error('BugFix target branch is invalid.');
  return `refs/heads/${branch}`;
}

function complete(evidence: string, fields: Partial<BugFixActionResult> = {}): BugFixActionResult {
  return { status: 'completed', evidence, ...fields };
}

function signerUnavailable(result: CommandResult) {
  return (
    /failed to sign|signing failed/i.test(result.stderr) &&
    /no secret key|agent refused|signing agent.*(?:not running|unavailable)|could not open a connection/i.test(
      result.stderr,
    )
  );
}

export function createBugFixDelivery(options: DeliveryOptions) {
  const run = options.run ?? execute;
  const verificationCommand = options.verificationCommand ?? bugFixVerificationCommand;
  const authorize = (batch: BugFixBatch, action: BugFixStage) => {
    try {
      if (options.authorize(batch, action) !== false) return;
    } catch {
      // > Authorization could not be established.
    }
    throw new DeliveryBlocked('The standing grant does not authorize this delivery operation.');
  };
  const invoke = (
    command: Command,
    args: string[],
    cwd: string,
    signal: AbortSignal,
    extra: Pick<CommandInput, 'env' | 'timeout'> = {},
  ) => run({ command, args, cwd, signal, timeout: 10_000, ...extra });
  async function read(command: Command, args: string[], cwd: string, signal: AbortSignal) {
    const result = await invoke(command, args, cwd, signal);
    if (result.code !== 0)
      throw new Error(`The ${command} ${args[0]} operation could not be confirmed.`);
    return result.stdout;
  }

  async function inspectRepository(directory: string, signal: AbortSignal) {
    const root = await realpath(directory);
    const top = (await read('git', ['rev-parse', '--show-toplevel'], root, signal)).trim();
    if (root !== directory || path.resolve(top) !== root)
      throw new Error('BugFix authority requires the canonical top-level repository.');
    await requireNoGitProcessFilters(root, signal);
    const remotes = (await read('git', ['remote'], root, signal)).trim().split(/\r?\n/);
    if (!remotes.includes('origin')) return { root };
    const [fetch, push] = await Promise.all([
      read('git', ['remote', 'get-url', '--all', 'origin'], root, signal),
      read('git', ['remote', 'get-url', '--push', '--all', 'origin'], root, signal),
    ]);
    const repo = remoteName(fetch);
    if (repo !== remoteName(push))
      throw new Error('Git fetch and push origins must identify the same approved repository.');
    return { root, remote: `https://github.com/${repo}` };
  }

  async function repository(batch: BugFixBatch, signal: AbortSignal) {
    const inspected = await inspectRepository(batch.scope, signal);
    if (inspected.remote !== options.expectedRemote(batch))
      throw new Error('The repository origin does not match the standing grant.');
    return inspected.remote;
  }

  async function remoteRef(root: string, ref: string, signal: AbortSignal) {
    const result = await invoke('git', ['ls-remote', '--exit-code', 'origin', ref], root, signal);
    if (result.code === 2) return undefined;
    if (result.code !== 0) throw new Error('Git origin did not confirm the requested reference.');
    const [value, observedRef] = result.stdout.trim().split('\t');
    if (observedRef !== ref) throw new Error('Git origin returned an unexpected reference.');
    return hash(value ?? '');
  }

  async function targetRevision(batch: BugFixBatch, signal: AbortSignal): Promise<string> {
    const origin = await repository(batch, signal);
    const ref = checkRef(batch.targetBranch);
    const local = hash(await read('git', ['rev-parse', '--verify', ref], batch.scope, signal));
    if (origin && (await remoteRef(batch.scope, ref, signal)) !== local)
      throw new Error(
        'The local target differs from GitHub. Synchronize it before BugFix can act.',
      );
    return local;
  }

  function branch(batch: BugFixBatch) {
    if (!/^[0-9a-f-]{16,80}$/i.test(batch.id))
      throw new Error('BugFix requires a valid run identity.');
    return `bughunter/${batch.id}`;
  }

  function checkoutPath(batch: BugFixBatch) {
    if (!path.isAbsolute(options.worktreeDirectory))
      throw new Error('BugFix checkout storage must be absolute.');
    return path.join(options.worktreeDirectory, path.basename(branch(batch)));
  }

  async function checkout(batch: BugFixBatch, signal: AbortSignal) {
    const directory = checkoutPath(batch);
    if (batch.checkout !== directory || (await realpath(directory)) !== directory)
      throw new Error('The recorded BugFix checkout does not match the owned worktree.');
    const [source, linked, selectedBranch] = await Promise.all([
      read('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], batch.scope, signal),
      read('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], directory, signal),
      read('git', ['symbolic-ref', 'HEAD'], directory, signal),
    ]);
    if (
      path.resolve(source.trim()) !== path.resolve(linked.trim()) ||
      selectedBranch.trim() !== checkRef(branch(batch))
    )
      throw new Error('The BugFix checkout changed its repository or branch.');
    await requireNoGitProcessFilters(directory, signal);
    await requireNoGitHooks(directory, ['post-index-change'], signal);
    return directory;
  }

  async function scopedChanges(batch: BugFixBatch, directory: string, signal: AbortSignal) {
    const status = await read(
      'git',
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--no-renames',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ],
      directory,
      signal,
    );
    const entries = status.split('\0').filter(Boolean);
    for (const entry of entries) {
      const relative = entry.slice(3);
      const target = path.resolve(directory, relative);
      if (!isWithin(directory, target) || !options.allowedPath(batch, relative))
        throw new DeliveryBlocked('BugFix found a change outside the authorized file scope.');
      if (entry[0] !== ' ' && !entry.startsWith('??'))
        throw new DeliveryBlocked('BugFix requires an untouched shared Git index.');
      const stat = await lstat(target).catch((error: unknown) => {
        if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT')
          return undefined;
        throw error;
      });
      if (!stat?.isFile() || stat.nlink !== 1 || (await realpath(target)) !== target)
        throw new DeliveryBlocked(
          'BugFix may only change existing regular files inside the checkout.',
        );
      if (entry.startsWith('??'))
        throw new DeliveryBlocked('BugFix may only change files tracked in the approved checkout.');
    }
    return entries.map((entry) => entry.slice(3));
  }

  async function captureTree(batch: BugFixBatch, signal: AbortSignal) {
    const directory = await checkout(batch, signal);
    const files = await scopedChanges(batch, directory, signal);
    const temp = await mkdtemp(path.join(options.worktreeDirectory, '.bugfix-index-'));
    try {
      const extra = { env: { GIT_INDEX_FILE: path.join(temp, 'index') } };
      for (const args of [
        ['read-tree', 'HEAD'],
        ...(files.length ? [['--literal-pathspecs', 'add', '-A', '--', ...files]] : []),
      ]) {
        if ((await invoke('git', args, directory, signal, extra)).code !== 0)
          throw new Error('Git could not capture the scoped BugFix tree.');
      }
      const tree = await invoke('git', ['write-tree'], directory, signal, extra);
      if (tree.code !== 0) throw new Error('Git could not identify the scoped BugFix tree.');
      return hash(tree.stdout);
    } finally {
      await rm(temp, { force: true, recursive: true });
    }
  }

  async function expectedTarget(batch: BugFixBatch, signal: AbortSignal) {
    const current = await targetRevision(batch, signal);
    if (current !== batch.targetRevision)
      throw new DeliveryBlocked(
        'The target advanced since BugFix was approved. Revalidation is required.',
      );
    return current;
  }

  async function revalidate(
    batch: BugFixBatch,
    remedy: BugFixRemedy,
    target: string,
    signal: AbortSignal,
  ) {
    if ((await targetRevision(batch, signal)) !== target)
      return {
        outcome: 'blocked',
        evidence: 'The approved target changed during revalidation.',
      } as const;
    if (!options.recheck)
      return {
        outcome: 'blocked',
        evidence: 'No current-target behavioral evidence is available.',
      } as const;
    const evidence = await options.recheck(batch, remedy, target, signal);
    if ((await targetRevision(batch, signal)) !== target)
      return {
        outcome: 'blocked',
        evidence: 'The approved target changed during revalidation.',
      } as const;
    return evidence;
  }

  function requireVerified(batch: BugFixBatch, tree: string) {
    if (tree !== batch.verifiedTree)
      throw new Error('The exact candidate tree must pass combined checks.');
  }

  async function committed(batch: BugFixBatch, signal: AbortSignal) {
    const directory = await checkout(batch, signal);
    const [tip, tree, status] = await Promise.all([
      read('git', ['rev-parse', 'HEAD'], directory, signal),
      read('git', ['rev-parse', 'HEAD^{tree}'], directory, signal),
      read('git', ['status', '--porcelain', '--untracked-files=all'], directory, signal),
    ]);
    requireVerified(batch, hash(tree));
    if (hash(tip) !== batch.commitRevision || status)
      throw new Error('The reviewed worktree or expected committed tip changed.');
    return directory;
  }

  async function gitState(directory: string, marker: string, signal: AbortSignal) {
    const filename = await read('git', ['rev-parse', '--git-path', marker], directory, signal);
    const target = path.resolve(directory, filename.trim());
    return lstat(target).then(
      () => true,
      (error: unknown) => {
        if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT')
          return false;
        throw error;
      },
    );
  }

  async function noInterruptedHistory(directory: string, signal: AbortSignal) {
    for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD'])
      if (await gitState(directory, marker, signal))
        throw new DeliveryBlocked('The checkout has an interrupted history operation.');
  }

  async function requireCleanTarget(batch: BugFixBatch, revision: string, signal: AbortSignal) {
    const [branch, head, status] = await Promise.all([
      read('git', ['symbolic-ref', 'HEAD'], batch.scope, signal),
      read('git', ['rev-parse', 'HEAD'], batch.scope, signal),
      read('git', ['status', '--porcelain', '--untracked-files=all'], batch.scope, signal),
    ]);
    if (branch.trim() !== checkRef(batch.targetBranch) || hash(head) !== revision || status)
      throw new DeliveryBlocked(
        'The target checkout must be clean and on the approved branch and revision.',
      );
    await noInterruptedHistory(batch.scope, signal);
  }

  async function requireNoGitProcessFilters(directory: string, signal: AbortSignal) {
    const config = await invoke(
      'git',
      ['config', '--get-regexp', '^(filter\\..*\\.(clean|smudge|process)|core\\.fsmonitor)$'],
      directory,
      signal,
    );
    if (
      config.code === 1 ||
      (config.code === 0 &&
        config.stdout
          .trim()
          .split('\n')
          .every((line) => /^core\.fsmonitor (true|false)$/i.test(line)))
    )
      return;
    throw new DeliveryBlocked(
      'BugFix cannot safely invoke configured external Git filters or monitors.',
    );
  }

  async function requireNoGitHooks(directory: string, names: string[], signal: AbortSignal) {
    const config = await invoke(
      'git',
      ['config', '--path', '--get', 'core.hooksPath'],
      directory,
      signal,
    );
    if (config.code !== 0 && config.code !== 1)
      throw new DeliveryBlocked(
        'BugFix could not establish the repository Git hook configuration.',
      );
    const hooks = path.resolve(
      directory,
      (config.code === 0
        ? config.stdout
        : await read('git', ['rev-parse', '--git-path', 'hooks'], directory, signal)
      ).trimEnd(),
    );
    for (const name of names) {
      const hook = await lstat(path.join(hooks, name)).catch((error: unknown) => {
        const { code } = error as NodeJS.ErrnoException;
        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
        throw error;
      });
      if (hook && (hook.isSymbolicLink() || (hook.isFile() && (hook.mode & 0o111) !== 0)))
        throw new DeliveryBlocked(
          `BugFix requires manual delivery when the ${name} Git hook is active.`,
        );
    }
  }

  async function prs(batch: BugFixBatch, origin: string, signal: AbortSignal) {
    const rows = pullRequests.parse(
      JSON.parse(
        await read(
          'gh',
          [
            'pr',
            'list',
            '--repo',
            remoteName(origin),
            '--state',
            'all',
            '--head',
            branch(batch),
            '--base',
            batch.targetBranch,
            '--json',
            'number,url,state,headRefOid,headRefName,baseRefName,isDraft,isCrossRepository,mergeCommit',
          ],
          batch.scope,
          signal,
        ),
      ),
    );
    if (
      rows.length > 1 ||
      rows.some(
        (item) =>
          item.headRefName !== branch(batch) ||
          item.baseRefName !== batch.targetBranch ||
          item.headRefOid !== batch.commitRevision ||
          item.isCrossRepository ||
          item.url.toLowerCase() !== `${origin}/pull/${item.number}`,
      )
    )
      throw new Error('The BugFix pull-request identity or head is uncertain.');
    return rows[0];
  }

  async function perform(
    batch: BugFixBatch,
    action: BugFixStage,
    signal: AbortSignal,
  ): Promise<BugFixActionResult> {
    let changed = false;
    try {
      return await performAuthorized(batch, action, signal, () => {
        signal.throwIfAborted();
        authorize(batch, action);
        changed = true;
      });
    } catch (error) {
      if (!changed && !signal.aborted && error instanceof DeliveryBlocked)
        return { status: 'blocked', evidence: error.message };
      throw error;
    }
  }

  async function performAuthorized(
    batch: BugFixBatch,
    action: BugFixStage,
    signal: AbortSignal,
    beforeMutation: () => void,
  ): Promise<BugFixActionResult> {
    authorize(batch, action);
    const origin = await repository(batch, signal);
    switch (action.kind) {
      case 'prepare': {
        const base = await expectedTarget(batch, signal);
        await requireNoGitHooks(
          batch.scope,
          ['post-checkout', 'post-index-change', 'reference-transaction'],
          signal,
        );
        await requireCleanTarget(batch, base, signal);
        await mkdir(options.worktreeDirectory, { recursive: true, mode: 0o700 });
        if ((await realpath(options.worktreeDirectory)) !== options.worktreeDirectory)
          throw new Error('BugFix checkout storage must be a canonical directory.');
        const directory = checkoutPath(batch);
        beforeMutation();
        const result = await invoke(
          'just',
          ['worktree-create', branch(batch), directory, base],
          batch.scope,
          signal,
          { timeout: 600_000 },
        );
        if (result.code !== 0)
          throw new Error('Worktree preparation failed or its outcome is uncertain.');
        await checkout({ ...batch, checkout: directory }, signal);
        return complete('Created one shared checkout from the approved target.', {
          checkout: directory,
          branch: branch(batch),
        });
      }
      case 'verify': {
        const directory = await checkout(batch, signal);
        const tree = await captureTree(batch, signal);
        const verification = await verificationCommand(directory, tree).catch(() => {
          throw new DeliveryBlocked('The isolated BugFix verification environment is unavailable.');
        });
        try {
          for (const recipe of ['check', 'test']) {
            authorize(batch, action);
            const result = await invoke(
              '/usr/bin/bwrap',
              [...verification.args, recipe],
              directory,
              signal,
              { env: verification.env, timeout: 600_000 },
            );
            if (result.code !== 0 && result.stderr.startsWith('bwrap:'))
              throw new DeliveryBlocked(
                'The isolated BugFix verification process could not start.',
              );
            if (result.code !== 0)
              return {
                status: 'failed',
                evidence: `The repository's just ${recipe} verification failed.`,
              };
          }
        } finally {
          await verification.cleanup?.();
        }
        if ((await captureTree(batch, signal)) !== tree)
          throw new Error('The source tree changed during verification.');
        return complete('The full local check and test recipes passed on the exact tree.', {
          verifiedTree: tree,
        });
      }
      case 'commit': {
        await expectedTarget(batch, signal);
        const directory = await checkout(batch, signal);
        const parent = batch.commitRevision ?? batch.targetRevision;
        if (hash(await read('git', ['rev-parse', 'HEAD'], directory, signal)) !== parent)
          throw new Error('The checkout tip no longer matches the approved starting revision.');
        await noInterruptedHistory(directory, signal);
        await requireNoGitHooks(
          directory,
          [
            'pre-commit',
            'prepare-commit-msg',
            'commit-msg',
            'post-commit',
            'reference-transaction',
          ],
          signal,
        );
        requireVerified(batch, await captureTree(batch, signal));
        const files = await scopedChanges(batch, directory, signal);
        if (!files.length)
          return { status: 'blocked', evidence: 'BugFix has no scoped changes to commit.' };
        beforeMutation();
        await read('git', ['--literal-pathspecs', 'add', '-A', '--', ...files], directory, signal);
        requireVerified(batch, hash(await read('git', ['write-tree'], directory, signal)));
        authorize(batch, action);
        const message = [
          '-m',
          'fix(bughunter): repair verified behavior',
          '-m',
          `BugHunter run: ${batch.id}`,
        ];
        let result = await invoke('git', ['commit', ...message], directory, signal, {
          timeout: 60_000,
        });
        let unsigned = false;
        if (signerUnavailable(result) && options.allowUnsigned?.(batch)) {
          if (hash(await read('git', ['rev-parse', 'HEAD'], directory, signal)) !== parent)
            throw new Error('The Git tip changed during the signing attempt.');
          await noInterruptedHistory(directory, signal);
          requireVerified(batch, hash(await read('git', ['write-tree'], directory, signal)));
          authorize(batch, action);
          result = await invoke('git', ['commit', '--no-gpg-sign', ...message], directory, signal, {
            timeout: 60_000,
          });
          unsigned = true;
        }
        if (result.code !== 0)
          throw new Error('The signed Git commit did not complete with a confirmed result.');
        const [revision, ...parents] = (
          await read('git', ['show', '-s', '--format=%H %P', 'HEAD'], directory, signal)
        )
          .trim()
          .split(' ');
        if (parents.length !== 1 || parents[0] !== parent)
          throw new Error('The committed revision did not have the expected parent.');
        const commitRevision = hash(revision ?? '');
        await committed({ ...batch, commitRevision }, signal);
        return complete(
          unsigned
            ? `Committed the exact checked tree as ${commitRevision} unsigned after the signing provider failed.`
            : 'Committed the exact checked tree.',
          { commitRevision },
        );
      }
      case 'push': {
        if (!origin) return complete('Disposable local delivery has no GitHub origin.');
        await expectedTarget(batch, signal);
        const directory = await committed(batch, signal);
        await requireNoGitHooks(directory, ['pre-push'], signal);
        const ref = checkRef(branch(batch));
        const pushed = await remoteRef(batch.scope, ref, signal);
        if (pushed === batch.commitRevision)
          return complete('GitHub already has the exact reviewed tip.');
        if (
          pushed &&
          (
            await invoke(
              'git',
              ['merge-base', '--is-ancestor', pushed, hash(batch.commitRevision ?? '')],
              directory,
              signal,
            )
          ).code !== 0
        )
          throw new Error('The Pass branch on GitHub cannot advance without rewriting history.');
        beforeMutation();
        await read(
          'git',
          ['push', 'origin', `${hash(batch.commitRevision ?? '')}:${ref}`],
          directory,
          signal,
        );
        if ((await remoteRef(batch.scope, ref, signal)) !== batch.commitRevision)
          throw new Error('GitHub did not confirm the exact reviewed tip.');
        return complete('Published the checked and reviewed tip without rewriting history.');
      }
      case 'pull-request': {
        if (!origin) return complete('Disposable local delivery uses the reviewed Git merge.');
        await expectedTarget(batch, signal);
        const directory = await committed(batch, signal);
        const existing = await prs(batch, origin, signal);
        if (existing) {
          if (existing.state !== 'OPEN')
            throw new Error('The BugFix pull request is no longer open.');
          return complete('Reconciled the existing Pass pull request.', {
            pullRequest: existing.url,
          });
        }
        beforeMutation();
        await read(
          'gh',
          [
            'pr',
            'create',
            '--repo',
            remoteName(origin),
            '--head',
            branch(batch),
            '--base',
            batch.targetBranch,
            '--draft',
            '--title',
            'Repair verified BugHunter failure',
            '--body',
            `BugHunter Pass ${batch.id}\n\nVerified tree: ${batch.verifiedTree}\n\nIndependent review is a required integration gate.`,
          ],
          directory,
          signal,
        );
        const created = await prs(batch, origin, signal);
        if (!created?.isDraft || created.state !== 'OPEN')
          throw new Error('GitHub did not confirm the intended draft pull request.');
        return complete('Created the reviewed Pass draft pull request.', {
          pullRequest: created.url,
        });
      }
      case 'integrate': {
        if (!options.qualified())
          return {
            status: 'blocked',
            evidence: 'Unattended merge qualification is not established.',
          };
        if (!batch.reviewedRevision || batch.reviewedRevision !== batch.verifiedTree)
          return {
            status: 'blocked',
            evidence: 'The exact verified candidate needs independent combined review.',
          };
        const base = await expectedTarget(batch, signal);
        await committed(batch, signal);
        await requireNoGitHooks(batch.scope, ['post-index-change'], signal);
        await requireCleanTarget(batch, base, signal);
        if (!origin) {
          await requireNoGitHooks(
            batch.scope,
            [
              'pre-merge-commit',
              'prepare-commit-msg',
              'commit-msg',
              'post-merge',
              'reference-transaction',
            ],
            signal,
          );
          beforeMutation();
          const result = await invoke(
            'git',
            [
              'merge',
              '--no-ff',
              '-m',
              'Merge reviewed BugHunter repair',
              hash(batch.commitRevision ?? ''),
            ],
            batch.scope,
            signal,
            { timeout: 60_000 },
          );
          if (result.code !== 0)
            throw new Error('Local integration did not complete with a confirmed result.');
          return observeLocalIntegration(batch, base, signal);
        }
        const pr = await prs(batch, origin, signal);
        if (pr?.state !== 'OPEN' || pr.url !== batch.pullRequest)
          throw new Error('The intended BugFix pull request is unavailable.');
        const policy = await read('git', ['show', `${base}:justfile`], batch.scope, signal);
        const requireCI = /^RELEASE_REQUIRE_CI\s*:=\s*"(true|false)"\s*$/m.exec(policy)?.[1];
        if (!requireCI) throw new Error('The committed hosted CI policy could not be established.');
        if (requireCI === 'true')
          await read(
            'gh',
            ['pr', 'checks', String(pr.number), '--repo', remoteName(origin)],
            batch.scope,
            signal,
          );
        if (pr.isDraft) {
          beforeMutation();
          await read(
            'gh',
            ['pr', 'ready', String(pr.number), '--repo', remoteName(origin)],
            batch.scope,
            signal,
          );
        }
        await expectedTarget(batch, signal);
        beforeMutation();
        await read(
          'gh',
          [
            'pr',
            'merge',
            String(pr.number),
            '--repo',
            remoteName(origin),
            '--merge',
            '--match-head-commit',
            hash(batch.commitRevision ?? ''),
          ],
          batch.scope,
          signal,
        );
        return observeRemoteIntegration(batch, origin, signal);
      }
      default:
        return {
          status: 'blocked',
          evidence: 'This action needs a separately authorized workflow or live observation.',
        };
    }
  }

  async function observeLocalIntegration(batch: BugFixBatch, base: string, signal: AbortSignal) {
    const ref = checkRef(batch.targetBranch);
    const [commit, left, right, tree] = (
      await read('git', ['show', '-s', '--format=%H %P %T', ref], batch.scope, signal)
    )
      .trim()
      .split(' ');
    if (left !== base || right !== batch.commitRevision || tree !== batch.reviewedRevision)
      throw new Error('The local target did not confirm the reviewed merge result.');
    return complete('The local target contains the exact reviewed merge.', {
      integratedRevision: hash(commit ?? ''),
    });
  }

  async function observeRemoteIntegration(batch: BugFixBatch, origin: string, signal: AbortSignal) {
    const pr = await prs(batch, origin, signal);
    const revision = pr?.mergeCommit?.oid;
    if (pr?.state !== 'MERGED' || pr.url !== batch.pullRequest || !revision)
      throw new Error('GitHub did not confirm the intended pull-request merge.');
    const current = await remoteRef(batch.scope, checkRef(batch.targetBranch), signal);
    if (current !== revision)
      throw new Error('The GitHub target moved while the merge was being reconciled.');
    const payload = z
      .object({
        sha: z.string(),
        parents: z.array(z.object({ sha: z.string() })).length(2),
        commit: z.object({ tree: z.object({ sha: z.string() }) }),
      })
      .parse(
        JSON.parse(
          await read(
            'gh',
            ['api', `repos/${remoteName(origin)}/commits/${hash(revision)}`],
            batch.scope,
            signal,
          ),
        ),
      );
    if (
      payload.sha !== revision ||
      payload.parents[0]?.sha !== batch.targetRevision ||
      payload.parents[1]?.sha !== batch.commitRevision ||
      payload.commit.tree.sha !== batch.reviewedRevision
    )
      throw new Error('The GitHub merge parents or tree did not match the reviewed Pass.');
    return complete('GitHub confirms the expected reviewed merge.', {
      integratedRevision: hash(revision),
    });
  }

  async function reconcile(
    batch: BugFixBatch,
    action: BugFixStage,
    signal: AbortSignal,
  ): Promise<BugFixReconciliation> {
    if (action.kind === 'verify')
      return {
        state: 'not-applied',
        evidence: 'The interrupted check ran in a read-only, network-isolated environment.',
      };
    const applied = (result: BugFixActionResult): BugFixReconciliation => ({
      state: 'applied',
      result,
    });
    try {
      const origin = await repository(batch, signal);
      switch (action.kind) {
        case 'prepare': {
          const directory = checkoutPath(batch);
          const ref = checkRef(branch(batch));
          const [hasDirectory, existingRef, worktrees] = await Promise.all([
            lstat(directory).then(
              () => true,
              (error: NodeJS.ErrnoException) => {
                if (error.code === 'ENOENT') return false;
                throw error;
              },
            ),
            invoke('git', ['show-ref', '--verify', '--quiet', ref], batch.scope, signal),
            read('git', ['worktree', 'list', '--porcelain', '-z'], batch.scope, signal),
          ]);
          const registrations = worktrees.split('\0');
          if (
            !hasDirectory &&
            existingRef.code === 1 &&
            !registrations.includes(`worktree ${directory}`) &&
            !registrations.includes(`branch ${ref}`)
          )
            return {
              state: 'not-applied',
              evidence:
                'The expected repair branch, directory, and worktree registration are absent.',
            };
          break;
        }
        case 'commit': {
          const directory = await checkout(batch, signal);
          const [tip, parents, subject] = (
            await read('git', ['show', '-s', '--format=%H%n%P%n%B', 'HEAD'], directory, signal)
          ).split('\n', 3);
          if (
            tip &&
            parents === (batch.commitRevision ?? batch.targetRevision) &&
            subject === 'fix(bughunter): repair verified behavior'
          ) {
            const message = await read(
              'git',
              ['show', '-s', '--format=%B', tip],
              directory,
              signal,
            );
            if (!message.split('\n').includes(`BugHunter run: ${batch.id}`)) break;
            await committed({ ...batch, commitRevision: hash(tip) }, signal);
            return applied(
              complete('Reconciled the reviewed scoped commit.', { commitRevision: tip }),
            );
          }
          break;
        }
        case 'push':
          if (
            origin &&
            (await remoteRef(batch.scope, checkRef(branch(batch)), signal)) === batch.commitRevision
          )
            return applied(complete('GitHub contains the exact expected tip.'));
          break;
        case 'pull-request': {
          const pr = origin ? await prs(batch, origin, signal) : undefined;
          if (pr?.state === 'OPEN')
            return applied(
              complete('Reconciled the existing Pass pull request.', { pullRequest: pr.url }),
            );
          break;
        }
        case 'integrate':
          if (origin) return applied(await observeRemoteIntegration(batch, origin, signal));
          if (batch.targetRevision)
            return applied(await observeLocalIntegration(batch, batch.targetRevision, signal));
          break;
      }
    } catch {
      // > Recovery preserves an uncertain external action for explicit reconciliation.
    }
    return {
      state: 'uncertain',
      evidence:
        'The earlier action could not be established safely. Its checkout and state were preserved.',
    };
  }

  return { inspectRepository, targetRevision, revalidate, captureTree, perform, reconcile };
}

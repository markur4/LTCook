import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, normalize } from 'node:path';
import { readGit } from '../../../runtime/src/repository/providers/git.js';
import { RepositoryFilter } from '../../../runtime/src/repository/filter.js';
import { openRepositoryWorkspace } from '../../../runtime/src/repository/workspace.js';
import { SessionWorktrees } from '../../../runtime/src/integrations/session-worktrees.js';

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function createRepository() {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'ltcook-repository-git-')));
  fixtures.push(fixture);
  const root = join(fixture, 'workspace');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'trunk');
  return { fixture, root };
}

function commitAll(root: string, subject: string) {
  git(root, 'add', '--all');
  git(root, 'commit', '-qm', subject);
  return git(root, 'rev-parse', 'HEAD');
}

const gitPath = process.env.PATH ?? '';

test('session worktrees follow distinct linked checkouts and fall back when one disappears', async () => {
  const { fixture, root } = createRepository();
  writeFileSync(join(root, 'tracked.txt'), 'Initial\n');
  commitAll(root, 'Initial');
  const first = join(fixture, 'first session');
  const second = join(fixture, 'second session');
  git(root, 'worktree', 'add', '-qb', 'feature/first', first);
  git(root, 'worktree', 'add', '-qb', 'feature/second', second);

  const worktrees = new SessionWorktrees(gitPath);
  const firstScope = { sessionId: 'session-one', agentId: 'agent-one', workspaceRoot: root };
  const secondScope = { sessionId: 'session-two', agentId: 'agent-two', workspaceRoot: root };
  await worktrees.register(firstScope, first);
  await worktrees.register(secondScope, second);

  const firstState = await worktrees.read(firstScope);
  expect(firstState.following).toEqual({ path: first, branch: 'feature/first' });
  expect(firstState.available).toEqual([
    { path: root, branch: 'trunk' },
    { path: first, branch: 'feature/first' },
    { path: second, branch: 'feature/second' },
  ]);
  expect((await worktrees.read(secondScope)).following).toEqual({
    path: second,
    branch: 'feature/second',
  });
  expect(git(root, 'branch', '--show-current')).toBe('trunk');

  git(root, 'worktree', 'remove', first);
  expect(await worktrees.read(firstScope)).toEqual({
    following: null,
    available: [
      { path: root, branch: 'trunk' },
      { path: second, branch: 'feature/second' },
    ],
  });
  expect((await worktrees.read(secondScope)).following?.path).toBe(second);
});

test('session worktrees preserve a replacement when an earlier checkout is released', async () => {
  const { fixture, root } = createRepository();
  writeFileSync(join(root, 'tracked.txt'), 'Initial\n');
  commitAll(root, 'Initial');
  const first = join(fixture, 'before');
  const replacement = join(fixture, 'replacement');
  git(root, 'worktree', 'add', '-qb', 'feature/first', first);
  git(root, 'worktree', 'add', '-qb', 'feature/replacement', replacement);
  const scope = { sessionId: 'session', agentId: 'agent', workspaceRoot: root };
  const worktrees = new SessionWorktrees(gitPath);

  await worktrees.register(scope, first);
  await worktrees.register(scope, replacement);
  await worktrees.clear(scope, first);
  expect((await worktrees.read(scope)).following?.path).toBe(replacement);
  await expect(worktrees.register(scope, fixture)).rejects.toThrow('session repository');
  expect((await worktrees.read(scope)).following?.path).toBe(replacement);

  await worktrees.clear(scope, replacement);
  expect((await worktrees.read(scope)).following).toBeNull();
});

test('a focused Pass follows its own checkout and falls back even when another Pass has one', async () => {
  const { fixture, root } = createRepository();
  writeFileSync(join(root, 'tracked.txt'), 'Initial\n');
  commitAll(root, 'Initial');
  const first = join(fixture, 'first pass');
  const second = join(fixture, 'second pass');
  git(root, 'worktree', 'add', '-qb', 'feature/first', first);
  git(root, 'worktree', 'add', '-qb', 'feature/second', second);
  const scope = { sessionId: 'one-session', agentId: 'one-agent', workspaceRoot: root };
  const firstPass = { ...scope, passId: 'first-pass' };
  const secondPass = { ...scope, passId: 'second-pass' };
  const worktrees = new SessionWorktrees(gitPath);

  await worktrees.register(firstPass, first);
  expect((await worktrees.read(secondPass)).following).toBeNull();
  await worktrees.register(secondPass, second);
  expect((await worktrees.read(firstPass)).following?.path).toBe(first);
  git(root, 'worktree', 'remove', first);
  expect((await worktrees.read(firstPass)).following).toBeNull();
  expect((await worktrees.read(secondPass)).following?.path).toBe(second);
});

test.skipIf(process.platform === 'win32')(
  'a Git inventory captured before an agent switches worktrees preserves the new registration',
  async () => {
    const { fixture, root } = createRepository();
    writeFileSync(join(root, 'tracked.txt'), 'Initial\n');
    commitAll(root, 'Initial');
    const first = join(fixture, 'first');
    const second = join(fixture, 'second');
    git(root, 'worktree', 'add', '-qb', 'feature/first', first);
    const bin = join(fixture, 'bin');
    mkdirSync(bin);
    const wrapper = join(bin, 'git');
    const actualGit = Bun.which('git');
    if (!actualGit) throw new Error('Git is required for repository tests.');
    const executable = `'${actualGit.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        `if mv "$0.capture" "$0.started" 2>/dev/null; then`,
        `  ${executable} "$@" > "$0.inventory" || exit $?`,
        '  touch "$0.ready"',
        '  until test -e "$0.release"; do sleep 0.01; done',
        '  cat "$0.inventory"',
        'else',
        `  exec ${executable} "$@"`,
        'fi',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const scope = { sessionId: 'session', agentId: 'agent', workspaceRoot: root };
    const worktrees = new SessionWorktrees([bin, gitPath].join(delimiter));
    await worktrees.register(scope, first);
    writeFileSync(`${wrapper}.capture`, '');

    const previous = worktrees.read(scope);
    try {
      const deadline = performance.now() + 2000;
      while (!existsSync(`${wrapper}.ready`) && performance.now() < deadline) await Bun.sleep(10);
      expect(existsSync(`${wrapper}.ready`)).toBe(true);
      git(root, 'worktree', 'add', '-qb', 'feature/second', second);
      await worktrees.register(scope, second);
    } finally {
      writeFileSync(`${wrapper}.release`, '');
      await previous;
    }
    expect((await worktrees.read(scope)).following?.path).toBe(second);
  },
);

test('Git discovery splits committed base changes from staged, unstaged and untracked files', async () => {
  const { root, fixture } = createRepository();
  const supportedOddName = process.platform === 'win32' ? 'name space ü' : 'name\tline\né\\';
  const changed = `${supportedOddName}.ts`;
  const untracked = `${supportedOddName}.txt`;
  writeFileSync(join(root, changed), 'initial\n');
  const trunk = commitAll(root, 'Initial');
  git(root, 'switch', '-qc', 'feature');
  writeFileSync(join(root, changed), 'commit\n');
  const head = commitAll(root, 'Feature');

  const linked = join(fixture, 'linked worktree');
  git(root, 'worktree', 'add', '-q', linked, 'trunk');
  git(root, 'remote', 'add', 'upstream', 'https://example.invalid/fixture');
  git(root, 'update-ref', 'refs/remotes/upstream/stable', trunk);
  git(root, 'symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/stable');
  git(root, 'branch', '--set-upstream-to=upstream/stable');
  git(root, 'remote', 'add', 'origin', 'https://example.invalid/mirror');
  git(root, 'update-ref', 'refs/remotes/origin/mirror', trunk);
  git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/mirror');

  const workspace = await openRepositoryWorkspace(root);
  const before = await readGit(workspace, gitPath);
  expect(before.partial).toBe(false);
  expect(before.value).toMatchObject({
    branch: 'feature',
    head,
    changed: 0,
    untracked: 0,
    worktrees: 2,
  });
  expect(before.value.changedFiles).toBeUndefined();

  writeFileSync(join(root, changed), 'already staged\n');
  git(root, '--literal-pathspecs', 'add', '--', changed);
  writeFileSync(join(root, changed), 'yet another edit\n');
  writeFileSync(join(root, untracked), 'untracked\n');
  git(root, 'config', 'diff.orderFile', 'missing-order-file');
  const index = readFileSync(join(root, '.git', 'index'));
  const detail = await readGit(workspace, gitPath, { detailed: true, base: 'trunk' });

  expect(detail.diagnostics).toEqual([]);
  expect(detail.value).toMatchObject({
    branch: 'feature',
    head,
    changed: 1,
    untracked: 1,
    worktrees: 2,
    upstream: 'upstream/stable',
    defaultBranch: 'stable',
    defaultBranchRef: 'refs/remotes/upstream/stable',
    remotes: ['origin', 'upstream'],
    changedFiles: [{ path: changed, indexStatus: 'M', worktreeStatus: 'M' }],
    untrackedFiles: [untracked],
    base: { reference: 'trunk', commit: trunk, changedFiles: [{ path: changed, status: 'M' }] },
  });
  expect(
    detail.value.worktreeEntries?.map((item) => ({ ...item, path: normalize(item.path) })),
  ).toContainEqual({ path: linked, head: trunk, branch: 'trunk' });
  expect(readFileSync(join(root, '.git', 'index')).equals(index)).toBe(true);

  const linkedResult = await readGit(await openRepositoryWorkspace(linked), gitPath);
  expect(linkedResult.value).toMatchObject({ head: trunk, branch: 'trunk', worktrees: 2 });
});

test('Git discovery limits nested workspace records to the authorized directory', async () => {
  const { root } = createRepository();
  const nested = join(root, 'authorized space ü');
  mkdirSync(nested);
  const outside = join(root, 'outside.txt');
  const inside = join(nested, 'inside.txt');
  writeFileSync(inside, 'initial');
  writeFileSync(outside, 'initial');
  const first = commitAll(root, 'Initial');
  writeFileSync(inside, 'committed change');
  writeFileSync(outside, 'committed change');
  commitAll(root, 'Change both');
  writeFileSync(inside, 'visible dirty file');
  writeFileSync(outside, 'outside dirty file');
  writeFileSync(join(nested, 'visible untracked.txt'), 'inside');
  writeFileSync(join(root, 'outside untracked.txt'), 'outside');

  const detail = await readGit(await openRepositoryWorkspace(nested), gitPath, {
    detailed: true,
    base: first,
  });
  expect(detail.value.changedFiles).toEqual([{ path: 'inside.txt', worktreeStatus: 'M' }]);
  expect(detail.value.untrackedFiles).toEqual(['visible untracked.txt']);
  expect(detail.value.base?.changedFiles).toEqual([{ path: 'inside.txt', status: 'M' }]);
  expect(detail.value.worktreeEntries).toEqual([]);
  expect(JSON.stringify(detail)).not.toContain('outside.txt');
  expect(JSON.stringify(detail)).not.toContain('outside untracked.txt');
});

test('Git discovery handles an unborn branch, detached HEAD, unavailable Git and non-ref arguments', async () => {
  const { root } = createRepository();
  const workspace = await openRepositoryWorkspace(root);
  const unborn = await readGit(workspace, gitPath, { detailed: true });
  expect(unborn.value.branch).toBe('trunk');
  expect(unborn.value.head).toBeUndefined();
  expect(unborn.value.defaultBranch).toBeUndefined();
  expect(unborn.diagnostics).toEqual([]);

  writeFileSync(join(root, 'tracked.txt'), 'tracking');
  const head = commitAll(root, 'Initial');
  git(root, 'switch', '--detach', '-q', head);
  const detached = await readGit(workspace, gitPath, { detailed: true, base: 'HEAD' });
  expect(detached.value).toMatchObject({ branch: '(detached)', head, base: { changedFiles: [] } });
  expect(detached.value.worktreeEntries?.[0]).toMatchObject({ detached: true, head });
  expect(detached.value.upstream).toBeUndefined();

  const invalidBase = await readGit(workspace, gitPath, { detailed: true, base: '--help' });
  expect(invalidBase.value.base).toBeUndefined();
  expect(invalidBase.diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-base' }));
  const missingGit = await readGit(workspace, '');
  expect(missingGit.partial).toBe(true);
  expect(missingGit.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'git-unavailable' }),
  );
});

test('Git discovery marks a file inventory as truncated while retaining counts', async () => {
  const { root } = createRepository();
  const group = join(root, 'untracked group');
  mkdirSync(group);
  for (let index = 0; index < 140; index++) writeFileSync(join(group, `file-${index}`), '');

  const workspace = await openRepositoryWorkspace(root);
  const summary = await readGit(workspace, gitPath);
  expect(summary.value.untracked).toBe(1);
  const detail = await readGit(workspace, gitPath, { detailed: true });
  expect(detail.value.untracked).toBe(140);
  expect(detail.value.untrackedFiles).toHaveLength(128);
  expect(detail.truncated).toBe(true);
  expect(detail.partial).toBe(true);
  expect(detail.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'untracked-files-limited' }),
  );
});

test('Git path filters apply before changed-file counts, detail limits, and base-file limits', async () => {
  const { root } = createRepository();
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src', 'kept.ts'), 'initial');
  writeFileSync(join(root, 'docs', 'dropped.md'), 'initial');
  const base = commitAll(root, 'Initial');
  writeFileSync(join(root, 'src', 'kept.ts'), 'changed');
  writeFileSync(join(root, 'docs', 'dropped.md'), 'changed');
  commitAll(root, 'Change both scopes');
  writeFileSync(join(root, 'src', 'kept.ts'), 'unstaged');
  writeFileSync(join(root, 'docs', 'dropped.md'), 'unstaged');
  writeFileSync(join(root, 'src', 'new.ts'), 'new');
  writeFileSync(join(root, 'docs', 'new.md'), 'new');

  const detail = await readGit(await openRepositoryWorkspace(root), gitPath, {
    detailed: true,
    base,
    filter: new RepositoryFilter({
      includePaths: ['src/**'],
    }),
  });

  expect(detail.value).toMatchObject({
    changed: 1,
    untracked: 1,
    changedFiles: [{ path: 'src/kept.ts' }],
    untrackedFiles: ['src/new.ts'],
    base: {
      changedFiles: [{ path: 'src/kept.ts', status: 'M' }],
    },
  });
  expect(detail.value.changedFiles).not.toContainEqual(
    expect.objectContaining({ path: 'docs/dropped.md' }),
  );
  expect(detail.value.untrackedFiles).not.toContain('docs/new.md');
  expect(detail.value.base?.changedFiles).not.toContainEqual(
    expect.objectContaining({ path: 'docs/dropped.md' }),
  );
});

test('Git discovery does not execute the repository’s configured clean or fsmonitor commands', async () => {
  const { root } = createRepository();
  const tracked = join(root, 'tracked.txt');
  writeFileSync(tracked, 'same size a\n');
  writeFileSync(join(root, '.gitattributes'), 'tracked.txt filter=sentinel\n');
  commitAll(root, 'Initial');
  git(root, 'config', 'filter.sentinel.clean', 'echo ran > filter-ran; cat');
  git(root, 'config', 'core.fsmonitor', './fsmonitor');
  writeFileSync(join(root, 'fsmonitor'), '#!/bin/sh\necho ran > fsmonitor-ran\nexit 1\n', {
    mode: 0o755,
  });
  writeFileSync(tracked, 'same size b\n');
  const future = new Date(Date.now() + 2_000);
  utimesSync(tracked, future, future);

  const detail = await readGit(await openRepositoryWorkspace(root), gitPath, { detailed: true });
  expect(detail.diagnostics).toContainEqual(expect.objectContaining({ code: 'filters-disabled' }));
  expect(detail.value.changedFiles).toEqual([{ path: 'tracked.txt', worktreeStatus: 'M' }]);
  expect(existsSync(join(root, 'filter-ran'))).toBe(false);
  expect(existsSync(join(root, 'fsmonitor-ran'))).toBe(false);
});

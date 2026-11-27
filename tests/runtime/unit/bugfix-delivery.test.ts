import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBugFixDelivery } from '../../../runtime/src/services/bugfix-delivery.js';
import type { BugFixBatch } from '../../../runtime/src/services/bugfix.js';

const base = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const tip = 'c'.repeat(40);
const mergedRevision = 'd'.repeat(40);
const remote = 'https://github.com/fixture/repository';
const pullRequest = `${remote}/pull/1`;
const id = '00000000-0000-0000-0000-000000000000';
const signal = new AbortController().signal;

async function fixture(
  callback: (value: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ltcook-delivery-')));
  try {
    await callback(await createFixture(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createFixture(root: string) {
  const project = path.join(root, 'project');
  const directory = path.join(root, 'worktrees');
  const worktree = path.join(directory, id);
  await mkdir(project);
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, 'code.ts'), 'confirmed correction');
  const batch: BugFixBatch = {
    id,
    huntId: 'hunt',
    scope: project,
    targetBranch: 'main',
    targetRevision: base,
    grantRevision: 'grant',
    status: 'running',
    elapsedMs: 0,
    checkout: worktree,
    remedies: [],
    operations: [],
    recoveredRemedies: [],
  };
  const calls: string[] = [];
  const state = {
    qualified: false,
    head: base,
    status: ' M code.ts\0',
    targetStatus: '',
    registeredRepair: false,
    hooks: path.join(root, 'hooks'),
    sandboxAvailable: true,
    remote: undefined as string | undefined,
    merged: false,
    mergedTree: tree,
  };
  const delivery = createBugFixDelivery({
    worktreeDirectory: directory,
    authorize: () => {},
    allowedPath: (_batch, file) => file === 'code.ts',
    expectedRemote: () => state.remote,
    qualified: () => state.qualified,
    async verificationCommand() {
      if (!state.sandboxAvailable) throw new Error('A local prerequisite is missing.');
      return { args: ['--unshare-all', '--', 'just'], env: { HOME: '/tmp/home' } };
    },
    async run({ command, args, cwd, env }) {
      calls.push(`${command} ${args.join(' ')}`);
      const output = (stdout: string) => ({ code: 0, stdout, stderr: '' });
      if (command === 'just') return output('');
      if (command === '/usr/bin/bwrap') return output('');
      if (args[0] === 'config') {
        if (args.at(-1) === 'core.hooksPath') return output(`${state.hooks}\n`);
        return { code: 1, stdout: '', stderr: '' };
      }
      if (command === 'gh') {
        if (args[0] === 'pr' && args[1] === 'list')
          return output(
            JSON.stringify([
              {
                state: state.merged ? 'MERGED' : 'OPEN',
                isDraft: !state.merged,
                isCrossRepository: false,
                number: 1,
                url: pullRequest,
                headRefOid: tip,
                headRefName: `bughunter/${id}`,
                baseRefName: 'main',
                mergeCommit: state.merged ? { oid: mergedRevision } : null,
              },
            ]),
          );
        if (args[0] === 'api')
          return output(
            JSON.stringify({
              sha: mergedRevision,
              parents: [{ sha: base }, { sha: tip }],
              commit: { tree: { sha: state.mergedTree } },
            }),
          );
        throw new Error('Unexpected external mutation in disposable delivery test');
      }
      if (args[0] === 'remote')
        return output(args[1] === 'get-url' ? `${state.remote}\n` : state.remote ? 'origin\n' : '');
      if (args[0] === 'ls-remote') return output(`${mergedRevision}\trefs/heads/main\n`);
      if (args[0] === 'show-ref')
        return { code: state.registeredRepair ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'worktree')
        return output(state.registeredRepair ? `branch refs/heads/bughunter/${id}\0` : '');
      if (args[0] === 'symbolic-ref')
        return output(cwd === worktree ? `refs/heads/bughunter/${id}\n` : 'refs/heads/main\n');
      if (args[0] === 'status') return output(cwd === worktree ? state.status : state.targetStatus);
      if (args[0] === 'read-tree') return output('');
      if (args[0] === 'write-tree') return output(`${tree}\n`);
      if (args[0] === '--literal-pathspecs') {
        if (!env?.GIT_INDEX_FILE) state.status = 'M  code.ts\0';
        return output('');
      }
      if (args[0] === 'commit') {
        state.head = tip;
        state.status = '';
        return output('');
      }
      if (args[0] === 'show' && args[2] === '--format=%H %P')
        return output(`${state.head} ${base}\n`);
      if (args[1] === '--show-toplevel') return output(`${cwd}\n`);
      if (args[1] === '--path-format=absolute') return output(`${project}/.git\n`);
      if (args[1] === '--verify') return output(`${base}\n`);
      if (args[1] === '--git-path') return output(`${root}/absent-${args[2]}\n`);
      if (args[1] === 'HEAD') return output(`${state.head}\n`);
      if (args[1] === 'HEAD^{tree}') return output(`${tree}\n`);
      throw new Error(`Unexpected fixture command ${command} ${args.join(' ')}`);
    },
  });
  return { batch, delivery, calls, state };
}

test('verifies and commits the exact scoped tree before review can gate integration', async () => {
  await fixture(async ({ batch, delivery, calls, state }) => {
    const verification = await delivery.perform(batch, { kind: 'verify' }, signal);
    expect(verification).toMatchObject({ status: 'completed', verifiedTree: tree });
    expect(calls.filter((call) => call.startsWith('/usr/bin/bwrap '))).toEqual([
      '/usr/bin/bwrap --unshare-all -- just check',
      '/usr/bin/bwrap --unshare-all -- just test',
    ]);
    expect(calls.some((call) => call.startsWith('just '))).toBe(false);
    const verified = { ...batch, verifiedTree: verification.verifiedTree };
    const commit = await delivery.perform(verified, { kind: 'commit' }, signal);
    expect(commit).toMatchObject({ status: 'completed', commitRevision: tip });
    const committed = { ...verified, commitRevision: commit.commitRevision };
    expect(await delivery.perform(committed, { kind: 'integrate' }, signal)).toMatchObject({
      status: 'blocked',
      evidence: expect.stringContaining('independent combined review'),
    });
    expect(
      await delivery.perform(
        { ...committed, reviewedRevision: tree },
        { kind: 'integrate' },
        signal,
      ),
    ).toMatchObject({
      status: 'blocked',
      evidence: expect.stringContaining('Unattended merging is disabled'),
    });
    state.qualified = true;
    expect(await delivery.perform(committed, { kind: 'integrate' }, signal)).toMatchObject({
      status: 'blocked',
      evidence: expect.stringContaining('independent combined review'),
    });
    expect(calls.some((call) => call.startsWith('git merge '))).toBe(false);
  });
});

test('requires a clean approved target before running its worktree recipe', async () => {
  await fixture(async ({ batch, delivery, calls, state }) => {
    state.targetStatus = ' M justfile\n';
    expect(await delivery.perform(batch, { kind: 'prepare' }, signal)).toMatchObject({
      status: 'blocked',
      evidence: expect.stringContaining('The target checkout must be clean'),
    });
    expect(calls.some((call) => call.startsWith('just worktree-create'))).toBe(false);
  });
});

test('preserves a configured executable commit hook without executing it or committing', async () => {
  await fixture(async ({ batch, delivery, calls, state }) => {
    await mkdir(state.hooks);
    await writeFile(path.join(state.hooks, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    expect(
      await delivery.perform({ ...batch, verifiedTree: tree }, { kind: 'commit' }, signal),
    ).toMatchObject({
      status: 'blocked',
      evidence: expect.stringContaining('the pre-commit Git hook is active'),
    });
    expect(calls.some((call) => call.startsWith('git commit '))).toBe(false);
  });
});

test('rejects a changed tracked path replaced with a symlink before running checks', async () => {
  await fixture(async ({ batch, delivery, calls }) => {
    const file = path.join(batch.checkout!, 'code.ts');
    await rm(file);
    await symlink(path.join(batch.scope, 'outside.ts'), file);
    expect(await delivery.perform(batch, { kind: 'verify' }, signal)).toMatchObject({
      status: 'blocked',
      evidence: expect.stringContaining('existing regular files inside the checkout'),
    });
    expect(calls.some((call) => call.startsWith('/usr/bin/bwrap '))).toBe(false);
  });
});

test('reports a missing sandbox as blocked and never falls back to ambient checks', async () => {
  await fixture(async ({ batch, delivery, calls, state }) => {
    state.sandboxAvailable = false;
    expect(await delivery.perform(batch, { kind: 'verify' }, signal)).toEqual({
      status: 'blocked',
      evidence: 'The isolated BugFix verification environment is unavailable.',
    });
    expect(
      calls.some((call) => call.startsWith('just ') || call.startsWith('/usr/bin/bwrap ')),
    ).toBe(false);
  });
});

test('refuses unrelated edits and preserves uncertain worktree preparations', async () => {
  await fixture(async ({ batch, delivery, calls, state }) => {
    state.status = ' M code.ts\0?? AGENTS.md\0';
    await expect(delivery.captureTree(batch, signal)).rejects.toThrow(
      'outside the authorized file scope',
    );
    expect(calls.some((call) => call.includes(' add '))).toBe(false);
    expect(await delivery.reconcile(batch, { kind: 'prepare' }, signal)).toMatchObject({
      state: 'uncertain',
    });
    expect(calls.some((call) => call.startsWith('just worktree-create'))).toBe(false);
  });
});

test('reconciles unstarted preparation while preserving a partial linked worktree', async () => {
  await fixture(async ({ batch, delivery, state }) => {
    const proposed = { ...batch, checkout: undefined };
    const stage = { kind: 'prepare' as const };
    expect(await delivery.reconcile(proposed, stage, signal)).toMatchObject({ state: 'uncertain' });
    await rm(batch.checkout!, { recursive: true });
    expect(await delivery.reconcile(proposed, stage, signal)).toMatchObject({
      state: 'not-applied',
    });
    state.registeredRepair = true;
    expect(await delivery.reconcile(proposed, stage, signal)).toMatchObject({ state: 'uncertain' });
  });
});

test('observes a human merge with exact parents and reviewed tree while unattended delivery is off', async () => {
  await fixture(async ({ batch, delivery, calls, state }) => {
    state.remote = remote;
    const integrated = {
      ...batch,
      reviewedRevision: tree,
      verifiedTree: tree,
      pullRequest,
      commitRevision: tip,
    };
    const stage = { kind: 'integrate' as const };
    expect(await delivery.perform(integrated, stage, signal)).toMatchObject({ status: 'blocked' });
    state.merged = true;
    expect(await delivery.perform(integrated, stage, signal)).toMatchObject({
      status: 'completed',
      integratedRevision: mergedRevision,
    });
    state.mergedTree = base;
    expect(await delivery.perform(integrated, stage, signal)).toMatchObject({ status: 'blocked' });
    expect(calls.some((call) => /^gh pr (?:ready|merge) /.test(call))).toBe(false);
  });
});

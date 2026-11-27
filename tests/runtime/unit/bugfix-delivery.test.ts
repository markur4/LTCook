import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBugFixDelivery } from '../../../runtime/src/services/bugfix-delivery.js';
import type { BugFixBatch } from '../../../runtime/src/services/bugfix.js';

const base = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const tip = 'c'.repeat(40);
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
    remote: undefined as string | undefined,
  };
  const delivery = createBugFixDelivery({
    worktreeDirectory: directory,
    authorize: () => {},
    allowedPath: (_batch, file) => file === 'code.ts',
    expectedRemote: () => undefined,
    qualified: () => state.qualified,
    async run({ command, args, cwd, env }) {
      calls.push(`${command} ${args.join(' ')}`);
      const output = (stdout: string) => ({ code: 0, stdout, stderr: '' });
      if (command === 'just') return output('');
      if (args[0] === 'remote') return output(state.remote ? 'origin\n' : '');
      if (args[0] === 'symbolic-ref')
        return output(cwd === worktree ? `refs/heads/bughunter/${id}\n` : 'refs/heads/main\n');
      if (args[0] === 'status') return output(cwd === worktree ? state.status : '');
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
    expect(calls.filter((call) => call.startsWith('just '))).toEqual(['just check', 'just test']);
    const verified = { ...batch, verifiedTree: verification.verifiedTree };
    const commit = await delivery.perform(verified, { kind: 'commit' }, signal);
    expect(commit).toMatchObject({ status: 'completed', commitRevision: tip });
    const committed = { ...verified, commitRevision: commit.commitRevision };
    expect(await delivery.perform(committed, { kind: 'integrate' }, signal)).toMatchObject({
      status: 'blocked',
      evidence: expect.stringContaining('qualification'),
    });
    state.qualified = true;
    expect(await delivery.perform(committed, { kind: 'integrate' }, signal)).toMatchObject({
      status: 'blocked',
      evidence: expect.stringContaining('independent combined review'),
    });
    expect(calls.some((call) => call.startsWith('git merge '))).toBe(false);
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

import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import type { Assignment, CreateAgentOptions } from '../../../runtime/src/workflow-api/index.js';
import { FakeAgents } from './runtime-fixtures.js';

class RepairAgents extends FakeAgents {
  readonly selections = new Map<string, CreateAgentOptions>();

  override async create(options: CreateAgentOptions) {
    const agent = await super.create(options);
    this.selections.set(agent.id, options);
    return agent;
  }
}

test('uses one Pass for bounded writes, correction and current-tree independent review', async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'ltcook-bugfix-workflow-')));
  const workspaceRoot = path.join(directory, 'workspace');
  mkdirSync(path.join(workspaceRoot, 'app'), { recursive: true });
  const primary = path.join(workspaceRoot, 'app', 'primary.ts');
  const secondary = path.join(workspaceRoot, 'app', 'secondary.ts');
  for (const file of [primary, secondary]) writeFileSync(file, 'export const value = 1;\n');
  const git = (args: string[]) =>
    execFileSync('git', ['-C', workspaceRoot, ...args], { stdio: 'ignore' });
  const captureTree = () =>
    execFileSync('git', ['-C', workspaceRoot, 'write-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  git(['init']);
  git(['add', '--', 'app']);
  git([
    '-c',
    'user.name=BugFix test',
    '-c',
    'user.email=fixture@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Initial fixture',
  ]);
  const agents = new RepairAgents();
  const runtime = createRuntime({
    agents,
    databasePath: path.join(directory, 'coordination.sqlite'),
  });
  const signal = AbortSignal.timeout(4000);
  let authorized = true;
  const input = {
    workspaceRoot,
    recordWorkspaceRoot: directory,
    huntId: 'fixture-hunt',
    requestId: 'fixture-batch',
    tasks: [
      {
        id: 'primary',
        kind: 'proper-fix' as const,
        paths: ['app/primary.ts'],
        brief: 'Repair primary.',
        acceptance: 'Pass primary requirements.',
      },
      {
        id: 'secondary',
        kind: 'workaround' as const,
        paths: ['app/secondary.ts'],
        brief: 'Repair secondary.',
        acceptance: 'Pass secondary requirements.',
      },
    ],
    authorize: () => authorized,
    signal,
  };
  try {
    const { sessionId, passId } = await runtime.startBugFixPass(input);
    const actor = (assignment: Assignment) => ({
      kind: 'agent' as const,
      nativeAgentId: assignment.nativeAgentId,
    });
    const sendReport = (assignment: Assignment) =>
      runtime.execute(sessionId, actor(assignment), {
        type: 'report.create',
        assignmentId: assignment.id,
        summary: 'Implemented',
        evidence: 'Owned repair',
        outcome: 'success',
      });
    const nextAssignment = async (
      predicate: (assignment: Assignment) => boolean,
    ): Promise<Assignment> => {
      while (true) {
        signal.throwIfAborted();
        const found = runtime.snapshot(sessionId).assignments.find(predicate);
        if (found) return found;
        await Bun.sleep(10);
      }
    };
    const [proper, workaround] = runtime.snapshot(sessionId).assignments;
    expect(
      runtime
        .bugHunterConversations(directory, [
          { id: input.huntId, fixId: input.requestId },
          { id: 'unrelated', fixId: 'another-batch' },
        ])
        .get(input.huntId),
    ).toEqual([
      { id: proper?.nativeAgentId, role: 'BugHunter Proper Fix Worker', stage: 'fix' },
      { id: workaround?.nativeAgentId, role: 'BugHunter Workaround Worker', stage: 'fix' },
    ]);
    expect(proper).toBeDefined();
    expect(workaround).toBeDefined();
    expect(agents.selections.get(proper!.nativeAgentId)?.member).toMatchObject({
      modelAlias: 'medium',
      thinking: 'high',
    });
    expect(agents.selections.get(workaround!.nativeAgentId)?.member).toMatchObject({
      modelAlias: 'smol',
      thinking: 'xhigh',
    });
    expect(runtime.bugHunterModelScope(sessionId, proper!.nativeAgentId)).toEqual({
      workspaceRoot: directory,
      huntId: 'fixture-hunt',
    });
    expect(
      runtime.authorizeTool(sessionId, proper!.nativeAgentId, 'edit', { path: primary }).allowed,
    ).toBe(true);
    expect(
      runtime.authorizeTool(sessionId, proper!.nativeAgentId, 'edit', { path: secondary }).allowed,
    ).toBe(false);
    expect(runtime.authorizeTool(sessionId, proper!.nativeAgentId, 'bash', {}).allowed).toBe(false);
    authorized = false;
    expect(
      runtime.authorizeTool(sessionId, proper!.nativeAgentId, 'edit', { path: primary }).allowed,
    ).toBe(false);
    expect(runtime.bugHunterModelScope(sessionId, proper!.nativeAgentId)).toBeUndefined();
    authorized = true;
    await sendReport(proper!);
    await sendReport(workaround!);
    expect(await runtime.awaitBugFixImplementation(sessionId, passId, signal)).toMatchObject({
      completed: true,
    });
    expect(runtime.snapshot(sessionId).tasks.some((task) => task.phase === 'review')).toBe(false);
    expect(runtime.observeBugFixPass(input)).toMatchObject({
      sessionId,
      passId,
      implementation: 'completed',
      reviewRecorded: false,
    });

    const firstTree = captureTree();
    const firstReview = runtime.awaitBugFixReview(sessionId, passId, firstTree, signal);
    const firstAssignment = await nextAssignment(
      ({ memberKey }) => memberKey === 'bugfix-reviewer',
    );
    expect(
      runtime.authorizeTool(sessionId, firstAssignment.nativeAgentId, 'edit', { path: primary })
        .allowed,
    ).toBe(false);
    expect(
      runtime.authorizeTool(sessionId, firstAssignment.nativeAgentId, 'read', { path: primary })
        .allowed,
    ).toBe(true);
    const reportReview = (assignment: Assignment, outcome: 'accepted' | 'changes-requested') =>
      runtime.execute(sessionId, actor(assignment), {
        type: 'review.create',
        assignmentId: assignment.id,
        passId,
        revision: runtime.snapshot(sessionId).passes[0]!.revision,
        summary: 'Independent review',
        outcome,
      });
    await reportReview(firstAssignment, 'changes-requested');
    expect(await firstReview).toMatchObject({
      outcome: 'changes-requested',
      reviewedTree: firstTree,
    });
    const correction = runtime.retryBugFixImplementation(
      sessionId,
      passId,
      'correction-1',
      signal,
      'review',
    );
    const originalIds = new Set([proper!.id, workaround!.id, firstAssignment.id]);
    const firstCorrection = await nextAssignment(({ id }) => !originalIds.has(id));
    originalIds.add(firstCorrection.id);
    const secondCorrection = await nextAssignment(({ id }) => !originalIds.has(id));
    await sendReport(firstCorrection);
    await sendReport(secondCorrection);
    expect(await correction).toMatchObject({ completed: true });
    expect(
      runtime.observeBugFixPass({ ...input, correctionRequestId: 'correction-1' }),
    ).toMatchObject({
      correctionRecorded: true,
      correction: 'completed',
    });

    writeFileSync(primary, 'export const value = 2;\n');
    git(['add', '--', 'app/primary.ts']);
    const repairedTree = captureTree();
    const secondReview = runtime.awaitBugFixReview(sessionId, passId, repairedTree, signal);
    const secondAssignment = await nextAssignment(
      ({ id, memberKey }) => id !== firstAssignment.id && memberKey === 'bugfix-reviewer',
    );
    expect(agents.sends.at(-1)?.message).toContain(repairedTree);
    expect(agents.sends.at(-1)?.message).toContain('+export const value = 2;');
    await reportReview(secondAssignment, 'accepted');
    expect(await secondReview).toMatchObject({ outcome: 'accepted', reviewedTree: repairedTree });
    expect(runtime.observeBugFixPass({ ...input, reviewedTree: repairedTree })).toMatchObject({
      reviewRecorded: true,
      review: 'accepted',
    });
    expect(
      runtime.observeBugFixPass({ ...input, reviewedTree: firstTree })?.review,
    ).toBeUndefined();
    expect(runtime.snapshot(sessionId).passes).toMatchObject([{ id: passId, status: 'running' }]);
    expect(() =>
      runtime.completeBugFixPass(sessionId, passId, {
        reviewedTree: firstTree,
        integratedCommit: 'c'.repeat(40),
      }),
    ).toThrow(/reviewed tree/);
    runtime.completeBugFixPass(sessionId, passId, {
      reviewedTree: repairedTree,
      integratedCommit: 'c'.repeat(40),
    });
    expect(runtime.snapshot(sessionId).passes).toMatchObject([{ id: passId, status: 'completed' }]);
    await runtime.haltBugFixPass(sessionId, passId);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

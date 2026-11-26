import { TeamRegistry } from '../../../runtime/src/integrations/team-loader.js';
import { createServer } from 'node:net';
import { RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import { SessionActivation } from '../../../runtime/src/integrations/session-activation.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import defaultTeam from '@ltcook/team-default';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import type { CreateAgentOptions } from '../../../runtime/src/workflow-api/index.js';
import team from '@ltcook/team-default-minimal';
import {
  Gate,
  FakeAgents,
  approveExecutionFixture,
  reviewRequiredTeam,
  temporaryDirectories,
} from './runtime-fixtures.js';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test('idle runtime starts and shuts down without creating sessions or agents', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ltcook-idle-runtime-'));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'coordination.sqlite');
  const agents = new FakeAgents();
  let runtime = createRuntime({ databasePath, team, agents });
  expect(agents.creates).toBe(0);
  await runtime.close();

  runtime = createRuntime({ databasePath, team, agents });
  const activated = await runtime.openSession({
    id: 'activated-after-idle',
    workspaceRoot: '/workspace-after-idle',
  });
  expect(activated.session.id).toBe('activated-after-idle');
  expect(activated.session.workspaceRoot).toBe('/workspace-after-idle');
  expect(agents.creates).toBe(2);
  await runtime.close();
  const agentsAfterActivation = agents.creates;
  runtime = createRuntime({ databasePath, team, agents });
  const restored = await runtime.openSession({
    id: activated.session.id,
    workspaceRoot: activated.session.workspaceRoot,
  });
  expect(restored.session.id).toBe(activated.session.id);
  expect(agents.creates).toBe(agentsAfterActivation);
  await runtime.close();
});
test('retries requested-session initialization after transient failure', async () => {
  const agents = new FakeAgents();
  agents.failLists = 1;
  const runtime = createRuntime({ databasePath: ':memory:', team, agents });
  await expect(runtime.openSession({ id: 'retry', workspaceRoot: '/workspace' })).rejects.toThrow(
    'temporary list failure',
  );
  const restored = await runtime.openSession({ id: 'retry', workspaceRoot: '/workspace' });
  expect(restored.session.id).toBe('retry');
  expect(agents.creates).toBe(2);
  await runtime.close();
});
test('concurrent opens share one initialization and later opens preserve in-flight sends', async () => {
  const agents = new FakeAgents();
  const createGate = new Gate();
  agents.createGate = createGate;
  const runtime = createRuntime({ databasePath: ':memory:', team, agents });
  const firstOpen = runtime.openSession({ id: 'concurrent', workspaceRoot: '/workspace' });
  await agents.createStarted.wait();
  const secondOpen = runtime.openSession({ id: 'concurrent', workspaceRoot: '/workspace' });
  createGate.resolve();
  const [first, second] = await Promise.all([firstOpen, secondOpen]);
  expect(agents.creates).toBe(2);
  expect(first.members.map((member) => member.binding?.nativeAgentId)).toEqual(
    second.members.map((member) => member.binding?.nativeAgentId),
  );

  const task = (await runtime.execute(
    first.session.id,
    { kind: 'user' },
    {
      type: 'task.create',
      workType: 'task.investigate',
      title: 'Work',
      description: 'Do it',
      acceptance: 'Report',
    },
  )) as { id: string };
  const sendGate = new Gate();
  agents.sendGate = sendGate;
  const assignment = runtime.execute(
    first.session.id,
    { kind: 'user' },
    { type: 'assignment.create', taskId: task.id, memberKey: 'adjutant', message: 'Do work' },
  );
  await agents.sendStarted.wait();
  expect(runtime.snapshot(first.session.id).assignments[0]?.status).toBe('sending');
  const reopened = await runtime.openSession({ id: 'concurrent', workspaceRoot: '/workspace' });
  expect(reopened.assignments[0]?.status).toBe('sending');
  sendGate.resolve();
  await assignment;
  expect(runtime.snapshot(first.session.id).assignments[0]?.status).toBe('sent');
  await runtime.close();
});
describe('RuntimeController coordination', () => {
  test('persists selected team and workspace and refuses implicit session changes', async () => {
    const agents = new FakeAgents();
    const runtime = createRuntime({ databasePath: ':memory:', team, agents });
    const snapshot = await runtime.openSession({ id: 'fixed', workspaceRoot: '/first' });
    expect(snapshot.session).toMatchObject({
      id: 'fixed',
      teamId: team.definition.id,
      workspaceRoot: '/first',
    });
    await expect(runtime.openSession({ id: 'fixed', workspaceRoot: '/other' })).rejects.toThrow(
      /different selected team or workspace/,
    );
    await runtime.close();
  });

  test('only bound assigned agent may report and agents cannot create approvals', async () => {
    const agents = new FakeAgents();
    const runtime = createRuntime({ databasePath: ':memory:', team, agents });
    const snapshot = await runtime.openSession({ workspaceRoot: '/workspace' });
    const task = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      {
        type: 'task.create',
        workType: 'task.investigate',
        title: 'Work',
        description: 'Do it',
        acceptance: 'Report',
      },
    )) as { id: string };
    const member = team.definition.members.find((item) => item.key === 'adjutant')!;
    const assignment = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'assignment.create', taskId: task.id, memberKey: member.key, message: 'Do work' },
    )) as { id: string; nativeAgentId: string };
    await expect(
      runtime.execute(
        snapshot.session.id,
        { kind: 'agent', nativeAgentId: 'not-bound' },
        { type: 'report.create', assignmentId: assignment.id, summary: 'done', evidence: 'proof' },
      ),
    ).rejects.toThrow(/not bound/);
    await expect(
      runtime.execute(
        snapshot.session.id,
        { kind: 'agent', nativeAgentId: assignment.nativeAgentId },
        {
          type: 'approval.create',
          scope: { action: 'publish', resourceId: 'release', revision: '1' },
          decision: 'approved',
        },
      ),
    ).rejects.toThrow(/trusted user/);
    await runtime.close();
  });

  test('blocks and records uncertain handoff without resending', async () => {
    const agents = new FakeAgents();
    agents.failSends = true;
    const runtime = createRuntime({ databasePath: ':memory:', team, agents });
    const snapshot = await runtime.openSession({ workspaceRoot: '/workspace' });
    const task = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      {
        type: 'task.create',
        workType: 'task.investigate',
        title: 'Work',
        description: 'Do it',
        acceptance: 'Report',
      },
    )) as { id: string };
    await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'assignment.create', taskId: task.id, memberKey: 'adjutant', message: 'Do work' },
    );
    expect(agents.sends).toHaveLength(1);
    await expect(
      runtime.execute(
        snapshot.session.id,
        { kind: 'user' },
        { type: 'assignment.create', taskId: task.id, memberKey: 'adjutant', message: 'Do work' },
      ),
    ).rejects.toThrow(/will not be replayed/);
    expect(agents.sends).toHaveLength(1);
    expect(runtime.snapshot(snapshot.session.id).assignments[0]?.status).toBe('uncertain');
    expect(runtime.snapshot(snapshot.session.id).tasks[0]?.status).toBe('blocked');
    await runtime.close();
  });

  test('restart reconciles bound agents and leaves uncertain assignments undispatched', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-restart-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'coordination.sqlite');
    const agents = new FakeAgents();
    agents.failSends = true;
    let runtime = createRuntime({ databasePath: path, team, agents });
    const snapshot = await runtime.openSession({ id: 'restart', workspaceRoot: '/workspace' });
    const task = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      {
        type: 'task.create',
        workType: 'task.investigate',
        title: 'Work',
        description: 'Do it',
        acceptance: 'Report',
      },
    )) as { id: string };
    await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'assignment.create', taskId: task.id, memberKey: 'adjutant', message: 'Do work' },
    );
    await runtime.close();

    runtime = createRuntime({ databasePath: path, team, agents });
    const restored = await runtime.openSession({ id: 'restart', workspaceRoot: '/workspace' });
    expect(restored.assignments[0]?.status).toBe('uncertain');
    expect(restored.members.filter((member) => member.binding?.state === 'bound')).toHaveLength(2);
    expect(agents.sends).toHaveLength(1);
    await runtime.close();
  });
  test('does not replay a persistent create whose outcome became uncertain', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-uncertain-create-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'coordination.sqlite');
    const agents = new FakeAgents();
    agents.failNextCreateAfterSideEffect = true;

    let runtime = createRuntime({ databasePath: path, team, agents });
    const first = await runtime.openSession({
      id: 'uncertain-create',
      workspaceRoot: '/workspace',
    });
    const uncertainMember = first.members.find((member) => member.binding?.state === 'uncertain');
    expect(uncertainMember?.binding?.nativeAgentId).toBeNull();
    const createsAfterFirstOpen = agents.creates;
    await runtime.close();

    runtime = createRuntime({ databasePath: path, team, agents });
    const restored = await runtime.openSession({
      id: 'uncertain-create',
      workspaceRoot: '/workspace',
    });
    expect(
      restored.members.find((member) => member.member.key === uncertainMember?.member.key)?.binding
        ?.state,
    ).toBe('uncertain');
    expect(agents.creates).toBe(createsAfterFirstOpen);
    await runtime.close();
  });
  test('temporary members require explicit spawn before assignment', async () => {
    const agents = new FakeAgents();
    const runtime = createRuntime({ databasePath: ':memory:', team: defaultTeam, agents });
    const snapshot = await runtime.openSession({ workspaceRoot: '/workspace' });
    const task = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      {
        type: 'task.create',
        workType: 'task.investigate',
        title: 'Review',
        description: 'Review work',
        acceptance: 'Findings',
      },
    )) as { id: string };
    const priorCreates = agents.creates;
    const priorSends = agents.sends.length;
    await expect(
      runtime.execute(
        snapshot.session.id,
        { kind: 'user' },
        {
          type: 'assignment.create',
          taskId: task.id,
          memberKey: 'reviewer-tmp',
          message: 'Review it',
        },
      ),
    ).rejects.toThrow();
    expect(agents.creates).toBe(priorCreates);
    expect(agents.sends).toHaveLength(priorSends);
    expect(
      runtime
        .snapshot(snapshot.session.id)
        .members.find((member) => member.member.key === 'reviewer-tmp')?.binding?.state,
    ).toBe('closed');
    await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'team.spawn', memberKey: 'reviewer-tmp' },
    );
    await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      {
        type: 'assignment.create',
        taskId: task.id,
        memberKey: 'reviewer-tmp',
        message: 'Review it',
      },
    );
    expect(agents.sends).toHaveLength(1);
    await runtime.close();
  });
  test('missing bound native agents block instead of creating replacements', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-missing-agent-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'coordination.sqlite');
    const agents = new FakeAgents();
    let runtime = createRuntime({ databasePath: path, team, agents });
    const snapshot = await runtime.openSession({ id: 'missing', workspaceRoot: '/workspace' });
    const originalCreates = agents.creates;
    const missingId = snapshot.members.find((member) => member.member.key === 'adjutant')?.binding
      ?.nativeAgentId;
    if (missingId === undefined || missingId === null)
      throw new Error('Expected initial Adjutant binding');
    agents.agents.delete(missingId);
    await runtime.close();

    runtime = createRuntime({ databasePath: path, team, agents });
    const restored = await runtime.openSession({ id: 'missing', workspaceRoot: '/workspace' });
    expect(agents.creates).toBe(originalCreates);
    expect(
      restored.members.find((member) => member.member.key === 'adjutant')?.binding?.state,
    ).toBe('missing');
    expect(
      runtime.authorizeWorkspaceTool('missing', missingId, 'session-memory', {}),
    ).toMatchObject({ allowed: false, unbound: true });
    await runtime.close();
  });
  test('runtime dispatches one whole-Pass review and completes only current acceptance', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-pass-review-'));
    temporaryDirectories.push(directory);
    const runtime = createRuntime({
      databasePath: ':memory:',
      stateDirectory: directory,
      team: reviewRequiredTeam,
      agents: new FakeAgents(),
    });
    const opened = await runtime.openSession({ workspaceRoot: '/workspace' });
    const id = opened.session.id;
    const pass = await approveExecutionFixture(runtime, id);
    const task = (await runtime.execute(
      id,
      { kind: 'user' },
      {
        type: 'task.create',
        passId: pass.id,
        requestId: 'implementation',
        title: 'Implement',
        description: 'Change code',
        acceptance: 'Pass checks',
        assigneeKey: 'junior',
      },
    )) as { id: string };
    const assignment = runtime.snapshot(id).assignments.find((item) => item.taskId === task.id)!;
    await runtime.execute(
      id,
      { kind: 'agent', nativeAgentId: assignment.nativeAgentId },
      {
        type: 'report.create',
        assignmentId: assignment.id,
        summary: 'Implemented',
        evidence: 'Recorded changes',
        outcome: 'success',
        verification: [],
      },
    );
    const snapshot = runtime.snapshot(id);
    const gate = snapshot.tasks.find((item) => item.requestId === `${pass.id}:review`)!;
    const reviewAssignment = snapshot.assignments.find((item) => item.taskId === gate.id)!;
    expect(reviewAssignment.memberKey).toBe('reviewer');
    const actor = { kind: 'agent' as const, nativeAgentId: reviewAssignment.nativeAgentId };
    await expect(
      runtime.execute(id, actor, {
        type: 'review.create',
        passId: pass.id,
        assignmentId: reviewAssignment.id,
        revision: 1,
        outcome: 'accepted',
        summary: 'Stale',
      }),
    ).rejects.toThrow(/revision/);
    const command = {
      type: 'review.create' as const,
      passId: pass.id,
      assignmentId: reviewAssignment.id,
      revision: snapshot.passes.find((item) => item.id === pass.id)!.revision,
      outcome: 'accepted' as const,
      summary: 'Complete Pass accepted',
    };
    await runtime.execute(id, actor, command);
    await runtime.execute(id, actor, command);
    expect(runtime.snapshot(id).passes.find((item) => item.id === pass.id)?.status).toBe(
      'completed',
    );
    expect(runtime.snapshot(id).reviews).toHaveLength(1);
    expect(runtime.snapshot(id).tasks.filter((item) => item.phase === 'review')).toHaveLength(1);
    await runtime.close();
  });
  test('restart rehydrates persisted sessions across workspaces', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-multi-session-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'coordination.sqlite');
    const agents = new FakeAgents();
    let runtime = createRuntime({ databasePath: path, team, agents });
    const first = await runtime.openSession({
      id: 'workspace-one',
      workspaceRoot: '/workspace-one',
    });
    const second = await runtime.openSession({
      id: 'workspace-two',
      workspaceRoot: '/workspace-two',
    });
    expect(agents.creates).toBe(4);
    await runtime.close();

    runtime = createRuntime({ databasePath: path, team, agents });
    await runtime.openSession({ id: first.session.id, workspaceRoot: first.session.workspaceRoot });
    expect(runtime.snapshot(second.session.id).session.id).toBe(second.session.id);
    const secondAgentId = second.members[0]!.binding!.nativeAgentId!;
    expect(
      runtime.authorizeWorkspaceTool(second.session.id, secondAgentId, 'session-memory', {}),
    ).toMatchObject({ allowed: false, reason: 'Session native bindings have not been reconciled' });
    expect(
      runtime.authorizeTool(
        second.session.id,
        second.members[0]!.binding!.nativeAgentId!,
        'write',
        { path: 'project.ts' },
      ).allowed,
    ).toBe(false);
    const restoredSecond = await runtime.openSession({
      id: second.session.id,
      workspaceRoot: second.session.workspaceRoot,
    });
    expect(restoredSecond.session.workspaceRoot).toBe('/workspace-two');
    const projectSnapshot = spyOn(runtime, 'snapshot');
    try {
      expect(
        runtime.authorizeWorkspaceTool(second.session.id, secondAgentId, 'session-memory', {}),
      ).toMatchObject({ allowed: true, workspaceRoot: '/workspace-two' });
      expect(
        runtime.authorizeWorkspaceTool(first.session.id, secondAgentId, 'session-memory', {}),
      ).toMatchObject({ allowed: false, unbound: true });
      expect(projectSnapshot).not.toHaveBeenCalled();
    } finally {
      projectSnapshot.mockRestore();
    }
    expect(
      restoredSecond.members.filter((member) => member.binding?.state === 'bound'),
    ).toHaveLength(2);
    expect(agents.creates).toBe(4);
    await runtime.close();
  });
  test('team messages stay out of task coordination and enforce sender authority', async () => {
    const agents = new FakeAgents();
    const runtime = createRuntime({ databasePath: ':memory:', team, agents });
    const snapshot = await runtime.openSession({ workspaceRoot: '/workspace' });
    const mainId = snapshot.members.find((member) => member.member.key === 'leader')?.binding
      ?.nativeAgentId;
    const adjutantId = snapshot.members.find((member) => member.member.key === 'adjutant')?.binding
      ?.nativeAgentId;
    if (mainId === undefined || mainId === null || adjutantId === undefined || adjutantId === null)
      throw new Error('Expected both bound minimal-team members');
    const message = { type: 'team.message', memberKey: 'leader', message: 'status?' } as const;
    await runtime.execute(
      snapshot.session.id,
      { kind: 'agent', nativeAgentId: adjutantId },
      message,
    );
    expect(agents.sends[0]).toEqual({
      id: mainId,
      message: `From adjutant (${adjutantId}): status?`,
    });
    expect(runtime.snapshot(snapshot.session.id).tasks).toHaveLength(0);
    expect(runtime.snapshot(snapshot.session.id).assignments).toHaveLength(0);
    await expect(
      runtime.execute(
        snapshot.session.id,
        { kind: 'agent', nativeAgentId: adjutantId },
        { ...message, memberKey: 'adjutant' },
      ),
    ).rejects.toThrow(/only to the leader/);
    expect(agents.sends).toHaveLength(1);
    await runtime.execute(
      snapshot.session.id,
      { kind: 'agent', nativeAgentId: adjutantId },
      message,
    );
    await runtime.execute(
      snapshot.session.id,
      { kind: 'agent', nativeAgentId: mainId },
      { ...message, memberKey: 'adjutant' },
    );
    expect(agents.sends).toHaveLength(3);
    expect(agents.sends[2]?.message).toBe(`From leader (${mainId}): status?`);
    agents.failSends = true;
    await expect(
      runtime.execute(snapshot.session.id, { kind: 'agent', nativeAgentId: adjutantId }, message),
    ).rejects.toThrow(/outcome is uncertain/);
    expect(agents.sends).toHaveLength(4);
    expect(runtime.snapshot(snapshot.session.id).tasks).toHaveLength(0);
    expect(runtime.snapshot(snapshot.session.id).assignments).toHaveLength(0);
    await runtime.close();
  });

  test('temporary members close only after reporting and can be explicitly spawned again', async () => {
    const agents = new FakeAgents();
    const runtime = createRuntime({ databasePath: ':memory:', team: defaultTeam, agents });
    const snapshot = await runtime.openSession({ workspaceRoot: '/workspace' });
    await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'team.spawn', memberKey: 'reviewer-tmp' },
    );
    const firstId = runtime
      .snapshot(snapshot.session.id)
      .members.find((member) => member.member.key === 'reviewer-tmp')?.binding?.nativeAgentId;
    if (firstId === undefined || firstId === null)
      throw new Error('Expected a spawned temporary reviewer');
    const task = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      {
        type: 'task.create',
        workType: 'task.investigate',
        title: 'Review',
        description: 'Review work',
        acceptance: 'Findings',
      },
    )) as { id: string };
    const assignment = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      {
        type: 'assignment.create',
        taskId: task.id,
        memberKey: 'reviewer-tmp',
        message: 'Review it',
      },
    )) as { id: string; nativeAgentId: string };
    const adjutantId = snapshot.members.find((member) => member.member.key === 'adjutant')?.binding
      ?.nativeAgentId;
    if (adjutantId === undefined || adjutantId === null)
      throw new Error('Expected a bound Adjutant');
    await expect(
      runtime.execute(
        snapshot.session.id,
        { kind: 'agent', nativeAgentId: adjutantId },
        { type: 'team.close', memberKey: 'reviewer-tmp' },
      ),
    ).rejects.toThrow(/leader/);
    await expect(
      runtime.execute(
        snapshot.session.id,
        { kind: 'user' },
        { type: 'team.close', memberKey: 'reviewer-tmp' },
      ),
    ).rejects.toThrow(/unreported assignments/);
    expect(agents.closes).toBe(0);
    await runtime.execute(
      snapshot.session.id,
      { kind: 'agent', nativeAgentId: assignment.nativeAgentId },
      {
        type: 'report.create',
        assignmentId: assignment.id,
        summary: 'Reviewed',
        evidence: 'Findings recorded',
      },
    );
    await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'team.close', memberKey: 'reviewer-tmp' },
    );
    expect(agents.closes).toBe(1);
    expect(
      runtime
        .snapshot(snapshot.session.id)
        .members.find((member) => member.member.key === 'reviewer-tmp')?.binding?.state,
    ).toBe('closed');
    await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'team.spawn', memberKey: 'reviewer-tmp' },
    );
    const secondId = runtime
      .snapshot(snapshot.session.id)
      .members.find((member) => member.member.key === 'reviewer-tmp')?.binding?.nativeAgentId;
    expect(secondId).not.toBe(firstId);
    expect(agents.creates).toBe(8);
    await runtime.close();
  });
  test('restart preserves a closed temporary-member binding without recreating it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-closed-temporary-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'coordination.sqlite');
    const agents = new FakeAgents();
    let runtime = createRuntime({ databasePath: path, team: defaultTeam, agents });
    const snapshot = await runtime.openSession({
      id: 'closed-temporary',
      workspaceRoot: '/workspace',
    });
    await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'team.spawn', memberKey: 'reviewer-tmp' },
    );
    await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'team.close', memberKey: 'reviewer-tmp' },
    );
    const createsAfterClose = agents.creates;
    await runtime.close();

    runtime = createRuntime({ databasePath: path, team: defaultTeam, agents });
    const restored = await runtime.openSession({
      id: 'closed-temporary',
      workspaceRoot: '/workspace',
    });
    expect(
      restored.members.find((member) => member.member.key === 'reviewer-tmp')?.binding?.state,
    ).toBe('closed');
    expect(agents.creates).toBe(createsAfterClose);
    await runtime.close();
  });
});

test('guidance inspection distinguishes missing reports from successful or failed native loading', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ltcook-guidance-status-'));
  temporaryDirectories.push(directory);
  const runtime = createRuntime({
    databasePath: join(directory, 'db.sqlite'),
    stateDirectory: directory,
    team,
    agents: new FakeAgents(),
  });
  try {
    const snapshot = await runtime.openSession({ workspaceRoot: directory });
    const nativeAgentId = snapshot.members[0]!.binding!.nativeAgentId!;
    const missing = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'guidance.inspect', nativeAgentId },
    )) as { inspection: { diagnostics: { reason: string }[] } }[];
    expect(missing[0]!.inspection.diagnostics[0]!.reason).toContain('unavailable');
    const inspection = {
      resources: [],
      diagnostics: [
        { source: '/fixture/core/rules/planning.md', reason: 'Required guidance is missing' },
      ],
    };
    await runtime.execute(
      snapshot.session.id,
      { kind: 'agent', nativeAgentId },
      { type: 'guidance.loaded', inspection },
    );
    const failed = await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'guidance.inspect', nativeAgentId },
    );
    expect(failed).toEqual([{ id: nativeAgentId, inspection }]);
    await expect(
      runtime.execute(
        snapshot.session.id,
        { kind: 'user' },
        { type: 'guidance.inspect', nativeAgentId: 'other-session-agent' },
      ),
    ).rejects.toThrow('not registered');
  } finally {
    await runtime.close();
  }
});

test('one runtime isolates multiple Teams and Sessions while adopting native Leaders idempotently', async () => {
  const agents = new FakeAgents();
  const runtime = createRuntime({
    databasePath: ':memory:',
    team,
    teams: new TeamRegistry([team, defaultTeam]),
    agents,
  });
  try {
    const first = await runtime.openSession({
      id: 'first',
      workspaceRoot: '/workspace',
      teamSelection: team.definition.id,
      leaderAgentId: 'first',
    });
    const second = await runtime.openSession({
      id: 'second',
      workspaceRoot: '/workspace',
      teamSelection: defaultTeam.definition.id,
      leaderAgentId: 'second',
    });
    const third = await runtime.openSession({
      id: 'third',
      workspaceRoot: '/workspace',
      teamSelection: team.definition.id,
      leaderAgentId: 'third',
    });
    expect(first.session.teamInstanceId).toBe(third.session.teamInstanceId);
    expect(first.session.teamInstanceId).not.toBe(second.session.teamInstanceId);
    expect(first.definition.id).toBe(team.definition.id);
    expect(second.definition.id).toBe(defaultTeam.definition.id);
    expect(agents.creates).toBe(0);
    expect(runtime.listSessions('/workspace')).toHaveLength(3);
    expect(runtime.listSessions('/workspace', team.definition.id)).toHaveLength(2);
    expect(runtime.memoryPeers('first', '/workspace').sort()).toEqual(['first', 'third']);
    expect(runtime.memoryPeers('second', '/workspace')).toEqual(['second']);
    expect(runtime.memoryPeers('first', '/elsewhere')).toEqual([]);
    expect(runtime.memoryPeers('unbound', '/workspace')).toEqual([]);
    await runtime.openSession({
      id: 'first',
      workspaceRoot: '/workspace',
      teamSelection: team.definition.id,
      leaderAgentId: 'first',
    });
    await expect(
      runtime.openSession({
        id: 'first',
        workspaceRoot: '/workspace',
        teamSelection: defaultTeam.definition.id,
        leaderAgentId: 'first',
      }),
    ).rejects.toThrow('immutable');
    await expect(
      runtime.openSession({ id: 'first', workspaceRoot: '/elsewhere', leaderAgentId: 'first' }),
    ).rejects.toThrow('workspace');
    await expect(
      runtime.openSession({
        id: 'bad',
        workspaceRoot: '/workspace',
        teamSelection: team.definition.id,
        leaderAgentId: 'other',
      }),
    ).rejects.toThrow('Leader ID');
    expect(runtime.listSessions('/workspace')).toHaveLength(3);
    await expect(
      runtime.execute(
        'first',
        { kind: 'agent', nativeAgentId: 'second' },
        { type: 'guidance.loaded', inspection: { resources: [], diagnostics: [] } },
      ),
    ).rejects.toThrow();
    expect(agents.creates).toBe(0);
  } finally {
    await runtime.close();
  }
});

test('adoption returns before startup, then reconciles one child and resumes without duplicate creation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ltcook-adoption-'));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'coordination.sqlite');
  const agents = new FakeAgents();
  agents.agents.set('native-leader', { id: 'native-leader', status: 'idle' });
  agents.createGate = new Gate();
  let runtime = createRuntime({ databasePath, team, agents });
  const open = {
    id: 'native-leader',
    workspaceRoot: '/workspace',
    teamSelection: team.definition.id,
    leaderAgentId: 'native-leader',
  };
  try {
    await runtime.openSession(open);
    expect(agents.creates).toBe(0);
    await runtime.execute(
      open.id,
      { kind: 'agent', nativeAgentId: open.id },
      { type: 'guidance.loaded', inspection: { resources: [], diagnostics: [] } },
    );
    await agents.createStarted.wait();
    expect(agents.creates).toBe(1);
    agents.createGate.resolve();
    await runtime.openSession({ id: open.id, workspaceRoot: open.workspaceRoot });
    expect(
      runtime.snapshot(open.id).members.every((member) => member.binding?.state === 'bound'),
    ).toBe(true);
    await runtime.close();
    runtime = createRuntime({ databasePath, team, agents });
    const resumed = await runtime.openSession(open);
    expect(
      resumed.members.find((member) => member.member.key === 'leader')?.binding?.nativeAgentId,
    ).toBe(open.id);
    await runtime.openSession({ id: open.id, workspaceRoot: open.workspaceRoot });
    expect(agents.creates).toBe(1);
  } finally {
    agents.createGate.resolve();
    await runtime.close();
  }
});

test('catalog, list, adoption and preparation APIs enforce explicit authenticated Session identity', async () => {
  const agents = new FakeAgents();
  const directory = mkdtempSync(join(tmpdir(), 'ltcook-history-'));
  temporaryDirectories.push(directory);
  const options = {
    databasePath: join(directory, 'coordination.sqlite'),
    team,
    teams: new TeamRegistry([team, defaultTeam]),
    agents,
  };
  let runtime = createRuntime(options);
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  let activation = new SessionActivation();
  let api = new RuntimeApi(runtime, 'local-user-secret', `127.0.0.1:${address.port}`, activation);
  activation.setWorkspaceActivator((request) =>
    runtime.openSession({
      id: request.sessionId,
      workspaceRoot: request.workspaceRoot,
      teamSelection: request.teamSelection,
      leaderAgentId: request.leaderAgentId,
    }),
  );
  const preparations: Array<{ options: CreateAgentOptions; leaderAgentId: string }> = [];
  api.setPrepareSessionHandler(async (options, leaderAgentId) => {
    preparations.push({ options, leaderAgentId });
    return { env: { LTCOOK_AGENT_API_TOKEN: 'scoped-agent-secret' } };
  });
  const endpoint = await api.listen();
  const post = (route: string, input: unknown, token = 'local-user-secret') =>
    fetch(`${endpoint}/v1/${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  const identity = {
    sessionId: 'api-leader',
    leaderAgentId: 'api-leader',
    workspaceRoot: '/workspace',
    teamSelection: team.definition.id,
  };
  try {
    expect((await post('team/catalog', {}, 'wrong-token')).status).toBe(401);
    expect(
      ((await (await post('team/catalog', {})).json()) as { teams: unknown[] }).teams,
    ).toHaveLength(2);
    const opened = await post('session/open', identity);
    expect(opened.status).toBe(200);
    const safe = await opened.text();
    expect(safe).not.toContain('secret');
    expect(JSON.parse(safe).leaderAgentId).toBe(identity.leaderAgentId);
    expect(
      (await post('session/open', { ...identity, teamSelection: defaultTeam.definition.id }))
        .status,
    ).toBe(400);
    expect((await post('session/prepare', { ...identity, workspaceRoot: '/other' })).status).toBe(
      400,
    );
    expect(preparations).toHaveLength(0);
    expect((await post('session/prepare', identity)).status).toBe(200);
    expect(preparations).toEqual([
      {
        leaderAgentId: identity.leaderAgentId,
        options: {
          member: team.definition.members.find(
            (member) => member.key === team.definition.leaderKey,
          ),
          sessionId: identity.sessionId,
          teamId: identity.teamSelection,
          teamInstanceId: JSON.parse(safe).teamInstanceId,
          workspaceRoot: identity.workspaceRoot,
        },
      },
    ]);
    expect(
      (
        (await (await post('session/list', { workspaceRoot: '/workspace' })).json()) as {
          sessions: unknown[];
        }
      ).sessions,
    ).toHaveLength(1);
    expect((await post('snapshot', { workspaceRoot: '/workspace' })).status).toBe(404);
    expect(
      (await post('snapshot', { sessionId: identity.sessionId, workspaceRoot: '/other' })).status,
    ).toBe(400);
    expect(
      (await post('snapshot', { sessionId: identity.sessionId, workspaceRoot: '/workspace' }))
        .status,
    ).toBe(200);
    const sessionOnly = await post('snapshot', { sessionId: identity.sessionId });
    expect(sessionOnly.status).toBe(200);
    expect(((await sessionOnly.json()) as { session: { id: string } }).session.id).toBe(
      identity.sessionId,
    );
    expect((await post('snapshot', { sessionId: 'unknown-session' })).status).toBe(400);
    agents.failNextCreateAfterSideEffect = true;
    const unresolved = await runtime.openSession({ workspaceRoot: '/workspace' });
    const listed = (await (await post('session/list', { workspaceRoot: '/workspace' })).json()) as {
      sessions: Array<{ sessionId: string; leaderAgentId: string | null; blocker?: string }>;
    };
    expect(
      listed.sessions.find((session) => session.sessionId === unresolved.session.id),
    ).toMatchObject({
      leaderAgentId: null,
      blocker: expect.stringContaining('Native create may have succeeded'),
    });
    const cli = await runtime.openSession({ workspaceRoot: '/cli-workspace' });
    const cliLeader = cli.members.find((member) => member.member.key === 'leader')?.binding
      ?.nativeAgentId;
    expect(cliLeader).toBeDefined();
    const removedTeam = await runtime.openSession({
      id: 'removed-team-leader',
      leaderAgentId: 'removed-team-leader',
      workspaceRoot: '/workspace',
      teamSelection: defaultTeam.definition.id,
    });
    const creationsBeforeRecovery = agents.creates;
    await api.close();
    const saved = runtime.snapshot(identity.sessionId);
    await runtime.close();
    runtime = createRuntime({ ...options, teams: new TeamRegistry([team]) });
    activation = new SessionActivation();
    api = new RuntimeApi(runtime, 'local-user-secret', `127.0.0.1:${address.port}`, activation);
    await api.listen();
    expect((await post('snapshot', { sessionId: identity.sessionId })).status).toBe(400);
    expect((await post('snapshot', identity, 'wrong-token')).status).toBe(401);
    for (const changed of [
      { workspaceRoot: '/other' },
      { teamSelection: defaultTeam.definition.id },
      { leaderAgentId: 'other-leader' },
      { sessionId: 'unknown-session', leaderAgentId: 'unknown-session' },
    ])
      expect((await post('snapshot', { ...identity, ...changed })).status).toBe(400);
    const recovered = await post('snapshot', identity);
    expect(recovered.status).toBe(200);
    const recoveredSnapshot = (await recovered.json()) as typeof saved & {
      session: { _metadata?: { duration?: number } };
    };
    // > AppRC read timing is incidental; retain exact equality for all saved coordination data.
    if (recoveredSnapshot.session._metadata?.duration !== undefined) {
      delete recoveredSnapshot.session._metadata.duration;
      if (Object.keys(recoveredSnapshot.session._metadata).length === 0)
        delete recoveredSnapshot.session._metadata;
    }
    expect(recoveredSnapshot).toEqual(JSON.parse(JSON.stringify(saved)));
    const mixedList = await post('session/list', { workspaceRoot: '/workspace' });
    expect(mixedList.status).toBe(200);
    const mixed = (await mixedList.json()) as {
      sessions: Array<{
        sessionId: string;
        teamId: string;
        leaderAgentId: string | null;
        blocker?: string;
      }>;
    };
    expect(
      mixed.sessions.find((session) => session.sessionId === identity.sessionId),
    ).toMatchObject({
      teamId: identity.teamSelection,
      leaderAgentId: identity.leaderAgentId,
    });
    expect(
      mixed.sessions.find((session) => session.sessionId === removedTeam.session.id),
    ).toMatchObject({
      teamId: defaultTeam.definition.id,
      leaderAgentId: null,
      blocker: expect.stringContaining(
        `Saved Team ${defaultTeam.definition.id} is unavailable or invalid`,
      ),
    });
    expect(() => runtime.snapshot(removedTeam.session.id)).toThrow('unavailable or invalid');
    expect(
      runtime.listSessions('/workspace').find((session) => session.id === removedTeam.session.id)
        ?.teamId,
    ).toBe(defaultTeam.definition.id);
    const cliHistory = await post('snapshot', {
      sessionId: cli.session.id,
      leaderAgentId: cliLeader,
      workspaceRoot: cli.session.workspaceRoot,
      teamSelection: cli.session.teamId,
    });
    expect(cliHistory.status).toBe(200);
    expect(((await cliHistory.json()) as { session: { id: string } }).session.id).toBe(
      cli.session.id,
    );
    // > Read-only history recovery must not grant active Session command access.
    expect((await post('snapshot', { sessionId: identity.sessionId })).status).toBe(400);
    expect(
      (
        await post('command', {
          sessionId: identity.sessionId,
          command: { type: 'pass.create', title: 'must stay inactive' },
        })
      ).status,
    ).toBe(403);
    expect(runtime.snapshot(identity.sessionId).passes).toHaveLength(0);
    activation.register(identity.workspaceRoot, identity.sessionId);
    expect((await post('snapshot', { sessionId: identity.sessionId })).status).toBe(200);
    expect(
      (await post('snapshot', { sessionId: identity.sessionId, workspaceRoot: '/other' })).status,
    ).toBe(400);
    expect(agents.creates).toBe(creationsBeforeRecovery);
  } finally {
    await api.close();
    await runtime.close();
  }
});

test('registry loads only known local Teams and validates nested contracts before starting agents', async () => {
  const registry = await TeamRegistry.load();
  expect(registry.resolve('default').definition.id).toBe(defaultTeam.definition.id);
  expect(registry.resolve('default-minimal').definition.id).toBe(team.definition.id);
  expect(registry.catalog().every((entry) => entry.status === 'installed')).toBe(true);
  expect(() => registry.resolve('arbitrary-browser-package')).toThrow('unavailable');
  expect(
    () =>
      new TeamRegistry([
        {
          ...team,
          definition: {
            ...team.definition,
            members: team.definition.members.map((member) => ({ ...member, readOnly: 'false' })),
          },
        } as unknown as typeof team,
      ]),
  ).toThrow();
  const runtime = createRuntime({
    databasePath: ':memory:',
    teams: new TeamRegistry(),
    agents: new FakeAgents(),
  });
  try {
    expect(runtime.teamCatalog()).toEqual([]);
    await expect(runtime.openSession({ workspaceRoot: '/workspace' })).rejects.toThrow(
      'unavailable',
    );
    expect(runtime.listSessions('/workspace')).toEqual([]);
  } finally {
    await runtime.close();
  }
});

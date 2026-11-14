import { createServer } from 'node:net';
import { RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import defaultTeam from '@ltcook/team-default';
import { afterEach, describe, expect, test } from 'bun:test';
import type {
  AgentBackend,
  CreateAgentOptions,
  NativeAgent,
} from '../../../runtime/src/workflow-api/index.js';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import team from '@ltcook/team-default-minimal';
const reviewRequiredTeam = {
  ...defaultTeam,
  definition: {
    ...defaultTeam.definition,
    reviewPolicy: { ...defaultTeam.definition.reviewPolicy, required: true },
  },
};
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class Gate {
  private resolvePromise!: () => void;
  private readonly promise = new Promise<void>((resolve) => {
    this.resolvePromise = resolve;
  });
  wait(): Promise<void> {
    return this.promise;
  }
  resolve(): void {
    this.resolvePromise();
  }
}
class FakeAgents implements AgentBackend {
  readonly agents = new Map<string, NativeAgent>();
  sends: { id: string; message: string }[] = [];
  creates = 0;
  closes = 0;
  failSends = false;
  failLists = 0;
  failNextCreateAfterSideEffect = false;
  createGate: Gate | null = null;
  sendGate: Gate | null = null;
  readonly createStarted = new Gate();
  readonly sendStarted = new Gate();
  async list(): Promise<NativeAgent[]> {
    if (this.failLists > 0) {
      this.failLists -= 1;
      throw new Error('temporary list failure');
    }
    return [...this.agents.values()];
  }
  async create(_options: CreateAgentOptions): Promise<NativeAgent> {
    this.creates += 1;
    this.createStarted.resolve();
    if (this.createGate !== null) await this.createGate.wait();
    const agent = { id: `native-${this.creates}`, status: 'ready' };
    this.agents.set(agent.id, agent);
    if (this.failNextCreateAfterSideEffect) {
      this.failNextCreateAfterSideEffect = false;
      throw new Error('create acknowledgement was lost');
    }
    return agent;
  }
  async inspect(id: string): Promise<NativeAgent | null> {
    return this.agents.get(id) ?? null;
  }
  async send(id: string, message: string): Promise<void> {
    this.sends.push({ id, message });
    this.sendStarted.resolve();
    if (this.sendGate !== null) await this.sendGate.wait();
    if (this.failSends) throw new Error('transport closed before acknowledgement');
  }
  async close(id: string): Promise<void> {
    this.closes += 1;
    this.agents.delete(id);
  }
}

async function approveExecutionFixture(
  runtime: ReturnType<typeof createRuntime>,
  sessionId: string,
) {
  const { writeFileSync } = await import('node:fs');
  const snapshot = runtime.snapshot(sessionId);
  const designPath = join(snapshot.documentsDirectory, 'designs/Design-2026_11_14-16_00-review.md');
  writeFileSync(designPath, '# Review design');
  const plan = (await runtime.execute(
    sessionId,
    { kind: 'user' },
    { type: 'planning.start', designPath, title: 'Review execution' },
  )) as import('../../../runtime/src/workflow-api/index.js').PlanningRecord;
  writeFileSync(plan.plan.path, '# Plan');
  for (let stage = 0; stage < 2; stage++) {
    const record = runtime.snapshot(sessionId).planning.find((p) => p.id === plan.id)!;
    const assignment = runtime
      .snapshot(sessionId)
      .assignments.find((a) => a.id === record.assignmentId)!;
    await runtime.execute(
      sessionId,
      { kind: 'agent', nativeAgentId: assignment.nativeAgentId },
      {
        type: 'planning.submit',
        planId: plan.id,
        assignmentId: assignment.id,
        summary: 'Prepared',
        evidence: plan.plan.path,
        ...(stage === 1
          ? {
              coverage: (
                ['intent', 'design', 'scope', 'implementation', 'verification', 'delivery'] as const
              ).map((topic) => ({
                topic,
                disposition: 'Resolved' as const,
                detail: 'Fixture requirements established',
              })),
            }
          : {}),
      },
    );
  }
  for (const decision of runtime.snapshot(sessionId).decisions)
    await runtime.execute(
      sessionId,
      { kind: 'user' },
      {
        type: 'decision.answer',
        planId: plan.id,
        decisionId: decision.id,
        answer: 'Explicit fixture permission',
      },
    );
  const approved = (await runtime.execute(
    sessionId,
    { kind: 'user' },
    { type: 'planning.approve', planId: plan.id },
  )) as import('../../../runtime/src/workflow-api/index.js').PlanningRecord;
  const scheduling = runtime
    .snapshot(sessionId)
    .tasks.find((task) => task.requestId === `${plan.id}:execution-handoff`)!;
  const handoff = runtime
    .snapshot(sessionId)
    .assignments.find((assignment) => assignment.taskId === scheduling.id)!;
  await runtime.execute(
    sessionId,
    { kind: 'agent', nativeAgentId: handoff.nativeAgentId },
    {
      type: 'report.create',
      assignmentId: handoff.id,
      summary: 'Execution scheduling prepared',
      evidence: 'Fixture execution follows',
    },
  );
  await runtime.execute(
    sessionId,
    { kind: 'agent', nativeAgentId: handoff.nativeAgentId },
    { type: 'task.update', taskId: scheduling.id, status: 'completed' },
  );
  return { id: approved.passId! };
}
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
    await runtime.close();
  });
  test('requires current whole-Pass review before completing a Pass', async () => {
    const agents = new FakeAgents();
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-pass-review-'));
    temporaryDirectories.push(directory);
    const runtime = createRuntime({
      databasePath: ':memory:',
      stateDirectory: directory,
      team: reviewRequiredTeam,
      agents,
    });
    const snapshot = await runtime.openSession({ workspaceRoot: '/workspace' });
    const pass = await approveExecutionFixture(runtime, snapshot.session.id);
    const task = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      {
        type: 'task.create',
        passId: pass.id,
        title: 'Implement',
        description: 'Change code',
        acceptance: 'Pass checks',
      },
    )) as { id: string };
    const assignment = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      {
        type: 'assignment.create',
        taskId: task.id,
        memberKey: 'junior',
        message: 'Implement the task',
      },
    )) as { id: string; nativeAgentId: string };
    await runtime.execute(
      snapshot.session.id,
      { kind: 'agent', nativeAgentId: assignment.nativeAgentId },
      {
        type: 'report.create',
        assignmentId: assignment.id,
        summary: 'Implemented',
        evidence: 'Changes recorded',
      },
    );
    const reviewerId = snapshot.members.find((member) => member.member.key === 'reviewer')?.binding
      ?.nativeAgentId;
    if (reviewerId === undefined || reviewerId === null)
      throw new Error('Expected a bound Reviewer');
    const reviewer = { kind: 'agent', nativeAgentId: reviewerId } as const;
    await runtime.execute(snapshot.session.id, reviewer, {
      type: 'review.create',
      passId: pass.id,
      outcome: 'accepted',
      summary: 'Review accepted',
    });
    await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'task.update', taskId: task.id, status: 'completed' },
    );
    await expect(
      runtime.execute(
        snapshot.session.id,
        { kind: 'user' },
        { type: 'pass.update', passId: pass.id, status: 'completed' },
      ),
    ).rejects.toThrow(/current revision/);
    expect(
      runtime.snapshot(snapshot.session.id).passes.find((item) => item.id === pass.id)?.status,
    ).toBe('running');
    const current = runtime
      .snapshot(snapshot.session.id)
      .passes.find((item) => item.id === pass.id);
    if (current === undefined) throw new Error('Expected the Pass');
    await runtime.execute(snapshot.session.id, reviewer, {
      type: 'review.create',
      passId: pass.id,
      outcome: 'accepted',
      summary: 'Current whole-Pass review accepted',
    });
    const completed = await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'pass.update', passId: pass.id, status: 'completed' },
    );
    expect(completed).toMatchObject({ status: 'completed', revision: current.revision });
    -(await expect(
      runtime.execute(
        snapshot.session.id,
        { kind: 'user' },
        { type: 'pass.update', passId: pass.id, status: 'active' },
      ),
    ).rejects.toThrow(/cannot be reopened/));
    +(await expect(
      runtime.execute(
        snapshot.session.id,
        { kind: 'user' },
        { type: 'pass.update', passId: pass.id, status: 'pending' },
      ),
    ).rejects.toThrow(/cannot be reopened/));
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
    const mainId = snapshot.members.find((member) => member.member.key === 'main')?.binding
      ?.nativeAgentId;
    const adjutantId = snapshot.members.find((member) => member.member.key === 'adjutant')?.binding
      ?.nativeAgentId;
    if (mainId === undefined || mainId === null || adjutantId === undefined || adjutantId === null)
      throw new Error('Expected both bound minimal-team members');
    const message = { type: 'team.message', memberKey: 'main', message: 'status?' } as const;
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
    ).rejects.toThrow(/only to the coordinator/);
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
    expect(agents.sends[2]?.message).toBe(`From main (${mainId}): status?`);
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
    ).rejects.toThrow(/coordinator/);
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

describe('authoritative planning workflow', () => {
  async function fixture(selected = team, failSends = false) {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-planning-'));
    temporaryDirectories.push(directory);
    const agents = new FakeAgents();
    agents.failSends = failSends;
    const databasePath = join(directory, 'coordination.sqlite');
    const stateDirectory = join(directory, 'runtime');
    const runtime = createRuntime({ databasePath, stateDirectory, team: selected, agents });
    const snapshot = await runtime.openSession({
      id: 'planning-session',
      workspaceRoot: directory,
    });
    const { writeFileSync } = await import('node:fs');
    const designPath = join(
      stateDirectory,
      'documents/designs/Design-2026_11_14-16_00-framework.md',
    );
    writeFileSync(designPath, '# Design\n');
    const plan = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'planning.start', designPath, title: 'Framework' },
    )) as import('../../../runtime/src/workflow-api/index.js').PlanningRecord;
    return { directory, agents, databasePath, stateDirectory, runtime, snapshot, plan };
  }
  async function finishStages(
    f: Awaited<ReturnType<typeof fixture>>,
    coverageDisposition: 'Resolved' | 'Unresolved' = 'Resolved',
  ) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(f.plan.plan.path, '# Plan\n');
    const first = f.runtime
      .snapshot(f.snapshot.session.id)
      .assignments.find((item) => item.id === f.plan.assignmentId)!;
    await f.runtime.execute(
      first.sessionId,
      { kind: 'agent', nativeAgentId: first.nativeAgentId },
      {
        type: 'planning.submit',
        planId: f.plan.id,
        assignmentId: first.id,
        summary: 'Prefilled',
        evidence: f.plan.plan.path,
      },
    );
    const record = f.runtime.snapshot(first.sessionId).planning[0]!;
    const final = f.runtime
      .snapshot(first.sessionId)
      .assignments.find((item) => item.id === record.assignmentId)!;
    await f.runtime.execute(
      first.sessionId,
      { kind: 'agent', nativeAgentId: final.nativeAgentId },
      {
        type: 'planning.submit',
        planId: record.id,
        assignmentId: final.id,
        summary: 'Finalized',
        evidence: record.plan.path,
        coverage: ['intent', 'design', 'scope', 'implementation', 'verification', 'delivery'].map(
          (topic) => ({
            topic: topic as import('../../../runtime/src/workflow-api/index.js').PlanTopic,
            disposition: coverageDisposition,
            detail: 'Investigated',
          }),
        ),
      },
    );
  }
  async function answerMandatory(f: Awaited<ReturnType<typeof fixture>>) {
    for (const decision of f.runtime.snapshot(f.snapshot.session.id).decisions)
      await f.runtime.execute(
        f.snapshot.session.id,
        { kind: 'user' },
        {
          type: 'decision.answer',
          planId: f.plan.id,
          decisionId: decision.id,
          answer: `Explicit answer for ${decision.category}`,
        },
      );
  }
  test('pristine Session and generic approvals cannot bypass execution approval', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-no-plan-'));
    temporaryDirectories.push(directory);
    const runtime = createRuntime({
      databasePath: join(directory, 'db.sqlite'),
      stateDirectory: directory,
      team,
      agents: new FakeAgents(),
    });
    try {
      const snapshot = await runtime.openSession({ workspaceRoot: directory });
      const id = snapshot.session.id;
      const main = snapshot.members[0]!.binding!.nativeAgentId!;
      expect(runtime.authorizeTool(id, main, 'write', { path: 'project.ts' }).allowed).toBe(false);
      expect(runtime.authorizeTool(id, main, 'bash', { command: 'echo mutation' }).allowed).toBe(
        false,
      );
      await expect(
        runtime.execute(
          id,
          { kind: 'agent', nativeAgentId: main },
          { type: 'task.create', title: 'Unapproved', description: 'Execute', acceptance: 'Done' },
        ),
      ).rejects.toThrow(/approved Pass/);
      const pass = (await runtime.execute(
        id,
        { kind: 'user' },
        { type: 'pass.create', title: 'Metadata' },
      )) as { id: string };
      await runtime.execute(
        id,
        { kind: 'user' },
        {
          type: 'approval.create',
          scope: { action: 'plan.execute', resourceId: pass.id, revision: 'registered-plan' },
          decision: 'approved',
        },
      );
      await expect(
        runtime.execute(
          id,
          { kind: 'user' },
          { type: 'pass.update', passId: pass.id, status: 'running' },
        ),
      ).rejects.toThrow(/Plan approval/);
      const task = (await runtime.execute(
        id,
        { kind: 'user' },
        {
          type: 'task.create',
          passId: pass.id,
          title: 'Metadata task',
          description: 'Not authorized',
          acceptance: 'Done',
        },
      )) as { id: string };
      await expect(
        runtime.execute(
          id,
          { kind: 'user' },
          { type: 'assignment.create', taskId: task.id, memberKey: 'main', message: 'Execute' },
        ),
      ).rejects.toThrow(/approved Pass/);
      await expect(
        runtime.execute(
          id,
          { kind: 'user' },
          { type: 'task.update', taskId: task.id, status: 'running' },
        ),
      ).rejects.toThrow(/approved Pass/);
      expect(runtime.authorizeTool(id, main, 'write', { path: 'project.ts' }).allowed).toBe(false);
    } finally {
      await runtime.close();
    }
  });
  test('routes prefill/finalize, rejects forged approval, and enforces document and execution gates', async () => {
    const f = await fixture();
    const id = f.snapshot.session.id;
    try {
      const main = f.snapshot.members.find((item) => item.member.key === 'main')!.binding!
        .nativeAgentId!;
      const adjutant = f.snapshot.members.find((item) => item.member.key === 'adjutant')!.binding!
        .nativeAgentId!;
      expect(f.runtime.snapshot(id).assignments[0]!.nativeAgentId).toBe(adjutant);
      expect(f.runtime.authorizeTool(id, main, 'read', { path: 'package.json' }).allowed).toBe(
        true,
      );
      expect(f.runtime.authorizeTool(id, main, 'write', { path: f.plan.plan.path }).allowed).toBe(
        true,
      );
      expect(
        f.runtime.authorizeTool(id, main, 'write', { path: join(f.directory, 'project.ts') })
          .allowed,
      ).toBe(false);
      expect(f.runtime.authorizeTool(id, main, 'bash', { command: 'pwd' }).allowed).toBe(false);
      await expect(
        f.runtime.execute(
          id,
          { kind: 'agent', nativeAgentId: main },
          {
            type: 'decision.answer',
            planId: f.plan.id,
            decisionId: f.runtime.snapshot(id).decisions[0]!.id,
            answer: 'forged',
          },
        ),
      ).rejects.toThrow(/authenticated user/);
      await expect(
        f.runtime.execute(id, { kind: 'user' }, { type: 'planning.approve', planId: f.plan.id }),
      ).rejects.toThrow(/finalization/);
      await finishStages(f);
      expect(f.runtime.snapshot(id).assignments[1]!.nativeAgentId).toBe(main);
      await expect(
        f.runtime.execute(id, { kind: 'user' }, { type: 'planning.approve', planId: f.plan.id }),
      ).rejects.toThrow(/mandatory/);
      await answerMandatory(f);
      await expect(
        f.runtime.execute(
          id,
          { kind: 'agent', nativeAgentId: main },
          { type: 'planning.approve', planId: f.plan.id },
        ),
      ).rejects.toThrow(/authenticated user/);
      await f.runtime.execute(
        id,
        { kind: 'user' },
        { type: 'planning.approve', planId: f.plan.id },
      );
      expect(f.runtime.authorizeTool(id, main, 'bash', { command: 'build' }).allowed).toBe(true);
      const { appendFileSync } = await import('node:fs');
      appendFileSync(
        f.plan.plan.path,
        '\n# Implementation Report\n\n## Emerging Issues\n\n## User decisions post approval\n',
      );
      expect(f.runtime.authorizeTool(id, main, 'edit', { path: 'project.ts' }).allowed).toBe(true);
      const decision = (await f.runtime.execute(
        id,
        { kind: 'agent', nativeAgentId: main },
        {
          type: 'decision.create',
          planId: f.plan.id,
          category: 'other',
          prompt: 'Scope expansion?',
          blocking: true,
        },
      )) as import('../../../runtime/src/workflow-api/index.js').Decision;
      expect(f.runtime.authorizeTool(id, main, 'bash', { command: 'build' }).allowed).toBe(false);
      await f.runtime.execute(
        id,
        { kind: 'user' },
        {
          type: 'decision.answer',
          planId: f.plan.id,
          decisionId: decision.id,
          answer: 'Approved specific expansion',
        },
      );
      expect(f.runtime.authorizeTool(id, main, 'bash', { command: 'build' }).allowed).toBe(true);
    } finally {
      await f.runtime.close();
    }
    expect(() => f.runtime.authorizeTool(id, 'native-1', 'write', {})).toThrow(/closed/);
  });
  test('uncertain planning delivery survives restart without replay and stages cannot duplicate', async () => {
    const f = await fixture(team, true);
    const sends = f.agents.sends.length;
    expect(f.runtime.snapshot(f.snapshot.session.id).assignments[0]!.status).toBe('uncertain');
    await f.runtime.close();
    const reopened = createRuntime({
      databasePath: f.databasePath,
      stateDirectory: f.stateDirectory,
      team,
      agents: f.agents,
    });
    try {
      const snapshot = await reopened.openSession({
        id: f.snapshot.session.id,
        workspaceRoot: f.directory,
      });
      expect(snapshot.planning[0]!.id).toBe(f.plan.id);
      expect(f.agents.sends).toHaveLength(sends);
      expect(snapshot.assignments).toHaveLength(1);
    } finally {
      await reopened.close();
    }
  });
  test('native responses are correlated, idempotent, cancel-safe and isolated by Session', async () => {
    const f = await fixture();
    const id = f.snapshot.session.id;
    try {
      const agent = f.snapshot.members[0]!.binding!.nativeAgentId!;
      const decision = f.runtime.snapshot(id).decisions[0]!;
      f.runtime.bindDecisionPresentation({
        sessionId: id,
        planId: f.plan.id,
        decisionId: decision.id,
        nativeAgentId: agent,
        requestId: 'native-question',
      });
      await f.runtime.resolveDecisionPresentation({
        sessionId: id,
        nativeAgentId: agent,
        requestId: 'native-question',
        cancelled: true,
      });
      expect(f.runtime.snapshot(id).decisions[0]!.answer).toBeUndefined();
      await expect(
        f.runtime.resolveDecisionPresentation({
          sessionId: id,
          nativeAgentId: 'other-agent',
          requestId: 'native-question',
          answer: 'forged',
        }),
      ).rejects.toThrow(/registered presentation/);
      await f.runtime.resolveDecisionPresentation({
        sessionId: id,
        nativeAgentId: agent,
        requestId: 'native-question',
        answer: 'User response',
      });
      await f.runtime.resolveDecisionPresentation({
        sessionId: id,
        nativeAgentId: agent,
        requestId: 'native-question',
        answer: 'User response',
      });
      expect(f.runtime.snapshot(id).decisions[0]!.answer).toBe('User response');
      await f.runtime.openSession({ id: 'other-session', workspaceRoot: f.directory });
      await expect(
        f.runtime.execute(
          'other-session',
          { kind: 'user' },
          {
            type: 'decision.answer',
            planId: f.plan.id,
            decisionId: decision.id,
            answer: 'cross-session',
          },
        ),
      ).rejects.toThrow(/not registered/);
    } finally {
      await f.runtime.close();
    }
  });
  test('unresolved coverage and rejected approval cannot start execution', async () => {
    const f = await fixture();
    try {
      await finishStages(f, 'Unresolved');
      await answerMandatory(f);
      await expect(
        f.runtime.execute(
          f.snapshot.session.id,
          { kind: 'user' },
          { type: 'planning.approve', planId: f.plan.id },
        ),
      ).rejects.toThrow(/coverage/);
      await f.runtime.execute(
        f.snapshot.session.id,
        { kind: 'user' },
        { type: 'planning.reject', planId: f.plan.id },
      );
      expect(f.runtime.snapshot(f.snapshot.session.id).passes).toHaveLength(0);
    } finally {
      await f.runtime.close();
    }
  });
  test.each([false, true])(
    'CLI approval persists one Main handoff without replay (uncertain=%s)',
    async (uncertain) => {
      const f = await fixture();
      await finishStages(f);
      await answerMandatory(f);
      const before = f.agents.sends.length;
      f.agents.failSends = uncertain;
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing local test address');
      const port = address.port;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      const api = new RuntimeApi(f.runtime, 'approval-cli-secret', `127.0.0.1:${port}`);
      api.setSession(f.directory, f.snapshot.session.id);
      const endpoint = await api.listen();
      const approve = () =>
        fetch(`${endpoint}/v1/command`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer approval-cli-secret',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            sessionId: f.snapshot.session.id,
            command: { type: 'planning.approve', planId: f.plan.id },
          }),
        });
      try {
        const response = await approve();
        expect(response.status).toBe(200);
        const record = (
          (await response.json()) as {
            value: import('../../../runtime/src/workflow-api/index.js').PlanningRecord;
          }
        ).value;
        expect(record.stage).toBe('approved');
        expect(record.passId).toBeDefined();
        const snapshot = f.runtime.snapshot(f.snapshot.session.id);
        const scheduling = snapshot.tasks.find(
          (task) => task.requestId === `${record.id}:execution-handoff`,
        )!;
        const assignment = snapshot.assignments.find((item) => item.taskId === scheduling.id)!;
        const main = f.snapshot.members.find((member) => member.member.key === 'main')!.binding!
          .nativeAgentId!;
        expect(assignment.nativeAgentId).toBe(main);
        expect(assignment.status).toBe(uncertain ? 'uncertain' : 'sent');
        expect(scheduling.passId).toBe(record.passId);
        expect(f.agents.sends).toHaveLength(before + 1);
        expect(f.agents.sends.at(-1)!.message).toContain(record.plan.path);
        expect(f.agents.sends.at(-1)!.message).toContain(record.passId!);
        expect(f.agents.sends.at(-1)!.message).toContain('schedules execution Tasks');
        if (uncertain)
          expect(
            snapshot.blockers.some(
              (blocker) => blocker.includes('uncertain') || blocker.includes('unknown'),
            ),
          ).toBe(true);
        expect((await approve()).status).toBe(200);
        expect(f.agents.sends).toHaveLength(before + 1);
        expect(
          f.runtime
            .snapshot(f.snapshot.session.id)
            .approvals.filter((item) => item.scope.action === 'plan.execute'),
        ).toHaveLength(1);
      } finally {
        await api.close();
        await f.runtime.close();
      }
      const reopened = createRuntime({
        databasePath: f.databasePath,
        stateDirectory: f.stateDirectory,
        team,
        agents: f.agents,
      });
      try {
        const snapshot = await reopened.openSession({
          id: f.snapshot.session.id,
          workspaceRoot: f.directory,
        });
        expect(snapshot.planning[0]!.stage).toBe('approved');
        expect(
          snapshot.tasks.filter((task) => task.requestId === `${f.plan.id}:execution-handoff`),
        ).toHaveLength(1);
        expect(f.agents.sends).toHaveLength(before + 1);
        await reopened.execute(
          f.snapshot.session.id,
          { kind: 'user' },
          { type: 'planning.approve', planId: f.plan.id },
        );
        expect(f.agents.sends).toHaveLength(before + 1);
      } finally {
        await reopened.close();
      }
    },
  );
  test('specific mandatory questions replace unasked placeholders while genuine blockers remain', async () => {
    const f = await fixture();
    try {
      await finishStages(f);
      const id = f.snapshot.session.id;
      const initial = f.runtime.snapshot(id).decisions;
      for (const category of ['intent', 'breaking-changes', 'verification'] as const) {
        const question = (await f.runtime.execute(
          id,
          { kind: 'agent', nativeAgentId: f.snapshot.members[0]!.binding!.nativeAgentId! },
          {
            type: 'decision.create',
            planId: f.plan.id,
            category,
            prompt: `Specific ${category} decision for this implementation?`,
            blocking: true,
          },
        )) as import('../../../runtime/src/workflow-api/index.js').Decision;
        expect(question.id).toBe(initial.find((item) => item.category === category)!.id);
        expect(question.prompt).toContain('Specific');
        await f.runtime.execute(
          id,
          { kind: 'user' },
          {
            type: 'decision.answer',
            planId: f.plan.id,
            decisionId: question.id,
            answer: 'Explicit specific answer',
          },
        );
      }
      expect(f.runtime.snapshot(id).decisions).toHaveLength(3);
      const extra = (await f.runtime.execute(
        id,
        { kind: 'user' },
        {
          type: 'decision.create',
          planId: f.plan.id,
          category: 'intent',
          prompt: 'A second genuine scope decision?',
          blocking: true,
        },
      )) as import('../../../runtime/src/workflow-api/index.js').Decision;
      expect(f.runtime.snapshot(id).decisions).toHaveLength(4);
      await expect(
        f.runtime.execute(id, { kind: 'user' }, { type: 'planning.approve', planId: f.plan.id }),
      ).rejects.toThrow(/Blocking decisions/);
      await f.runtime.execute(
        id,
        { kind: 'user' },
        {
          type: 'decision.answer',
          planId: f.plan.id,
          decisionId: extra.id,
          answer: 'Explicit second answer',
        },
      );
      expect(
        (
          (await f.runtime.execute(
            id,
            { kind: 'user' },
            { type: 'planning.approve', planId: f.plan.id },
          )) as { stage: string }
        ).stage,
      ).toBe('approved');
    } finally {
      await f.runtime.close();
    }
  });
  test('closed temporary reviewer identity cannot retain approved-Pass tool access', async () => {
    const f = await fixture(defaultTeam);
    try {
      await finishStages(f);
      await answerMandatory(f);
      await f.runtime.execute(
        f.snapshot.session.id,
        { kind: 'user' },
        { type: 'planning.approve', planId: f.plan.id },
      );
      await f.runtime.execute(
        f.snapshot.session.id,
        { kind: 'user' },
        { type: 'team.spawn', memberKey: 'reviewer-tmp' },
      );
      const reviewer = f.runtime
        .snapshot(f.snapshot.session.id)
        .members.find((item) => item.member.key === 'reviewer-tmp')!.binding!.nativeAgentId!;
      expect(
        f.runtime.authorizeTool(f.snapshot.session.id, reviewer, 'edit', { path: 'project.ts' })
          .allowed,
      ).toBe(true);
      await f.runtime.execute(
        f.snapshot.session.id,
        { kind: 'user' },
        { type: 'team.close', memberKey: 'reviewer-tmp' },
      );
      expect(
        f.runtime.authorizeTool(f.snapshot.session.id, reviewer, 'edit', { path: 'project.ts' })
          .allowed,
      ).toBe(false);
    } finally {
      await f.runtime.close();
    }
  });
  test('authenticated CLI recovers pending decisions at idle restart without native replay', async () => {
    const f = await fixture(team, true);
    await f.runtime.close();
    const creates = f.agents.creates;
    const sends = f.agents.sends.length;
    const reopened = createRuntime({
      databasePath: f.databasePath,
      stateDirectory: f.stateDirectory,
      team,
      agents: f.agents,
    });
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local test address');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const api = new RuntimeApi(reopened, 'cli-recovery-secret', `127.0.0.1:${port}`);
    const endpoint = await api.listen();
    const post = (command: unknown, token = 'cli-recovery-secret') =>
      fetch(`${endpoint}/v1/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: f.snapshot.session.id, command }),
      });
    try {
      expect((await post({ type: 'planning.show', planId: f.plan.id }, 'wrong')).status).toBe(401);
      const show = await post({ type: 'planning.show', planId: f.plan.id });
      expect(show.status).toBe(200);
      expect(((await show.json()) as { value: { id: string } }).value.id).toBe(f.plan.id);
      const questions = await post({ type: 'planning.questions', planId: f.plan.id });
      expect(questions.status).toBe(200);
      const decisions = ((await questions.json()) as { value: { id: string; answer?: string }[] })
        .value;
      expect(decisions).toHaveLength(3);
      expect(decisions[0]!.answer).toBeUndefined();
      expect(
        (
          await post({
            type: 'decision.answer',
            planId: f.plan.id,
            decisionId: decisions[0]!.id,
            answer: 'Recovered explicit user answer',
          })
        ).status,
      ).toBe(200);
      expect(reopened.snapshot(f.snapshot.session.id).decisions[0]!.answer).toBe(
        'Recovered explicit user answer',
      );
      const approve = await post({ type: 'planning.approve', planId: f.plan.id });
      expect(approve.status).toBe(400);
      expect(await approve.text()).toContain('reconciled');
      const native = f.snapshot.members[0]!.binding!.nativeAgentId!;
      expect(
        reopened.authorizeTool(f.snapshot.session.id, native, 'write', { path: 'project.ts' })
          .allowed,
      ).toBe(false);
      expect(f.agents.creates).toBe(creates);
      expect(f.agents.sends).toHaveLength(sends);
    } finally {
      await api.close();
      await reopened.close();
    }
  });
  test('rejects invalid routing-hook selections before dispatch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-invalid-hook-'));
    temporaryDirectories.push(directory);
    const agents = new FakeAgents();
    const runtime = createRuntime({
      databasePath: join(directory, 'db.sqlite'),
      stateDirectory: join(directory, 'runtime'),
      team: { ...team, selectAssignee: () => 'undeclared' },
      agents,
    });
    try {
      const snapshot = await runtime.openSession({ workspaceRoot: directory });
      const { writeFileSync } = await import('node:fs');
      const designPath = join(
        directory,
        'runtime/documents/designs/Design-2026_11_14-16_00-test.md',
      );
      writeFileSync(designPath, '# Design');
      await expect(
        runtime.execute(
          snapshot.session.id,
          { kind: 'user' },
          { type: 'planning.start', designPath, title: 'Invalid Hook' },
        ),
      ).rejects.toThrow(/ineligible/);
      expect(agents.sends).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });
});

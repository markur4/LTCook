import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import defaultTeam from '@ltcook/team-default';
import { afterEach, describe, expect, test } from 'bun:test';
import type {
  AgentBackend,
  CreateAgentOptions,
  NativeAgent,
} from '../../../runtime/src/api/team.js';
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
    { type: 'task.create', title: 'Work', description: 'Do it', acceptance: 'Report' },
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
      { type: 'task.create', title: 'Work', description: 'Do it', acceptance: 'Report' },
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
      { type: 'task.create', title: 'Work', description: 'Do it', acceptance: 'Report' },
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
      { type: 'task.create', title: 'Work', description: 'Do it', acceptance: 'Report' },
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
      { type: 'task.create', title: 'Review', description: 'Review work', acceptance: 'Findings' },
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
    const runtime = createRuntime({ databasePath: ':memory:', team: reviewRequiredTeam, agents });
    const snapshot = await runtime.openSession({ workspaceRoot: '/workspace' });
    const pass = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'pass.create', title: 'Release' },
    )) as { id: string };
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
    ).toBe('pending');
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
    expect(() => runtime.snapshot(second.session.id)).toThrow(/not open/);
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
      { type: 'task.create', title: 'Review', description: 'Review work', acceptance: 'Findings' },
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

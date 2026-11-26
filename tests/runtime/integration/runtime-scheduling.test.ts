import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import defaultTeam from '@ltcook/team-default';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import { SessionMemory } from '../../../runtime/src/session-memory/service.js';
import { CoordinationStore } from '../../../runtime/src/storage/coordination.js';
import team from '@ltcook/team-default-minimal';
import {
  Gate,
  FakeAgents,
  approveExecutionFixture,
  temporaryDirectories,
} from './runtime-fixtures.js';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('approved Pass scheduling', () => {
  async function fixture(selected = defaultTeam, memory?: SessionMemory) {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-scheduler-'));
    temporaryDirectories.push(directory);
    const agents = new FakeAgents();
    const databasePath = join(directory, 'coordination.sqlite');
    const runtime = createRuntime({
      databasePath,
      stateDirectory: directory,
      team: selected,
      agents,
      memory,
    });
    const opened = await runtime.openSession({ workspaceRoot: '/workspace' });
    const id = opened.session.id;
    const pass = await approveExecutionFixture(runtime, id, false);
    const create = async (
      requestId: string,
      extra: Partial<import('../../../runtime/src/workflow-api/index.js').CreateTaskInput> = {},
    ) =>
      runtime.execute(
        id,
        { kind: 'user' },
        {
          type: 'task.create',
          passId: pass.id,
          requestId,
          title: requestId,
          description: 'Perform scoped work',
          acceptance: 'Report with evidence',
          ...extra,
        },
      ) as Promise<import('../../../runtime/src/workflow-api/index.js').Task>;
    const release = async () => {
      await runtime.execute(
        id,
        { kind: 'agent', nativeAgentId: pass.handoff.nativeAgentId },
        {
          type: 'report.create',
          assignmentId: pass.handoff.id,
          summary: 'Registered Tasks',
          evidence: 'Graph recorded',
        },
      );
      await runtime.execute(
        id,
        { kind: 'agent', nativeAgentId: pass.handoff.nativeAgentId },
        { type: 'task.update', taskId: pass.schedulingTaskId, status: 'completed' },
      );
    };
    const report = async (
      taskId: string,
      outcome: 'success' | 'failure' = 'success',
      verification: import('../../../runtime/src/workflow-api/index.js').VerificationEntry[] = [],
    ) => {
      const assignment = runtime
        .snapshot(id)
        .assignments.filter((item) => item.taskId === taskId)
        .at(-1)!;
      const command = {
        type: 'report.create' as const,
        assignmentId: assignment.id,
        summary: outcome,
        evidence: 'Observed command output',
        outcome,
        verification,
      };
      return {
        value: await runtime.execute(
          id,
          { kind: 'agent', nativeAgentId: assignment.nativeAgentId },
          command,
        ),
        actor: { kind: 'agent' as const, nativeAgentId: assignment.nativeAgentId },
        command,
      };
    };
    return { runtime, id, pass, agents, create, release, report, databasePath, directory };
  }

  test('canceling a Pass during the Memory lookup prevents its pending dispatch', async () => {
    const memory = new SessionMemory({
      databasePath: ':memory:',
      source: {
        async read() {
          return { epoch: 'fixture', latest: -1, through: -1, reset: false, messages: [] };
        },
      },
      async summarize(type) {
        return { type, text: '', complete: false, elapsedMs: 0 };
      },
    });
    const f = await fixture(defaultTeam, memory);
    const reading = new Gate();
    const loaded = new Gate();
    try {
      const task = await f.create('canceled-during-memory', { assigneeKey: 'junior' });
      await f.create('also-canceled', { assigneeKey: 'leader' });
      const sendsBefore = f.agents.sends.length;
      spyOn(memory, 'handoff').mockImplementation(async () => {
        reading.resolve();
        await loaded.wait();
        return 'Supplemental context';
      });
      const releasing = f.release();
      await reading.wait();
      const canceling = f.runtime.execute(
        f.id,
        { kind: 'user' },
        { type: 'pass.update', passId: f.pass.id, status: 'cancelled' },
      );
      loaded.resolve();
      await Promise.all([releasing, canceling]);
      const snapshot = f.runtime.snapshot(f.id);
      expect(snapshot.passes.find(({ id }) => id === f.pass.id)?.status).toBe('cancelled');
      expect(snapshot.assignments.find(({ taskId }) => taskId === task.id)?.status).toBe('pending');
      expect(f.agents.sends).toHaveLength(sendsBefore);
    } finally {
      loaded.resolve();
      await f.runtime.close();
      await memory.close();
    }
  });

  test('a blocking decision recorded during assignee selection prevents dispatch', async () => {
    const selecting = new Gate();
    const resumeSelection = new Gate();
    const f = await fixture({
      ...defaultTeam,
      async selectAssignee({ workType }) {
        if (workType === 'task.execute') {
          selecting.resolve();
          await resumeSelection.wait();
        }
        return defaultTeam.definition.routing[workType];
      },
    });
    let releasing: Promise<void> | undefined;
    let recording: Promise<unknown> | undefined;
    try {
      const task = await f.create('blocked-during-selection');
      const snapshot = f.runtime.snapshot(f.id);
      const plan = snapshot.planning.find(({ passId }) => passId === f.pass.id)!;
      const sendsBefore = f.agents.sends.length;
      releasing = f.release();
      await selecting.wait();
      recording = f.runtime.execute(
        f.id,
        { kind: 'user' },
        {
          type: 'decision.create',
          planId: plan.id,
          category: 'other',
          prompt: 'Confirm the new requirement?',
          blocking: true,
        },
      );
      expect(
        f.runtime
          .snapshot(f.id)
          .decisions.some(
            ({ prompt, blocking, answer }) =>
              prompt === 'Confirm the new requirement?' && blocking && answer === undefined,
          ),
      ).toBe(true);
      resumeSelection.resolve();
      await releasing;
      const decision = (await recording) as { id: string };
      expect(f.runtime.snapshot(f.id).assignments.some(({ taskId }) => taskId === task.id)).toBe(
        false,
      );
      expect(f.agents.sends).toHaveLength(sendsBefore);

      await f.runtime.execute(
        f.id,
        { kind: 'user' },
        { type: 'decision.answer', planId: plan.id, decisionId: decision.id, answer: 'Proceed' },
      );
      expect(
        f.runtime.snapshot(f.id).assignments.filter(({ taskId }) => taskId === task.id),
      ).toHaveLength(1);
      expect(f.agents.sends).toHaveLength(sendsBefore + 1);
    } finally {
      resumeSelection.resolve();
      await Promise.allSettled([releasing, recording]);
      await f.runtime.close();
    }
  });

  test('snapshots reuse task and approval reads while preserving dependency blockers', async () => {
    const f = await fixture(team);
    let tasksRead: ReturnType<typeof spyOn> | undefined;
    let approvalsRead: ReturnType<typeof spyOn> | undefined;
    try {
      const prerequisite = await f.create('snapshot-prerequisite');
      const dependent = await f.create('snapshot-dependent', { dependencyIds: [prerequisite.id] });
      await f.create('snapshot-other', { dependencyIds: [prerequisite.id] });
      tasksRead = spyOn(CoordinationStore.prototype, 'listTasks');
      approvalsRead = spyOn(CoordinationStore.prototype, 'listApprovals');
      const snapshot = f.runtime.snapshot(f.id);
      expect(tasksRead).toHaveBeenCalledTimes(1);
      expect(approvalsRead).toHaveBeenCalledTimes(1);
      expect(snapshot.blockers).toContain(
        `Task ${dependent.id}: Dependency ${prerequisite.id} is ${prerequisite.status}`,
      );
    } finally {
      tasksRead?.mockRestore();
      approvalsRead?.mockRestore();
      await f.runtime.close();
    }
  });

  test('Leader readiness publication completes inside its own scheduled native send', async () => {
    const f = await fixture(team);
    try {
      const task = await f.create('leader-self-assignment', { assigneeKey: 'leader' });
      let readinessPublications = 0;
      const originalSend = f.agents.send.bind(f.agents);
      spyOn(f.agents, 'send').mockImplementation(async (id, message) => {
        if (message.includes(`Scheduled Task ${task.id}`)) {
          await f.runtime.execute(
            f.id,
            { kind: 'agent', nativeAgentId: id },
            {
              type: 'guidance.loaded',
              inspection: { resources: [], diagnostics: [] },
              waitUntilReady: true,
            },
          );
          readinessPublications += 1;
        }
        await originalSend(id, message);
      });
      await f.release();
      expect(readinessPublications).toBe(1);
      expect(
        f.runtime.snapshot(f.id).assignments.find((assignment) => assignment.taskId === task.id)
          ?.status,
      ).toBe('sent');
      await f.report(task.id);
      expect(f.runtime.snapshot(f.id).tasks.find((entry) => entry.id === task.id)?.status).toBe(
        'completed',
      );
    } finally {
      await f.runtime.close();
    }
  });

  test('registration barrier, stable parallel dispatch, same-member serialization and dependencies', async () => {
    const f = await fixture();
    try {
      const a = await f.create('a', { assigneeKey: 'junior' });
      const b = await f.create('b', { assigneeKey: 'senior' });
      const c = await f.create('c', { assigneeKey: 'junior' });
      const d = await f.create('d', { assigneeKey: 'adjutant', dependencyIds: [a.id, b.id] });
      expect(
        f.runtime
          .snapshot(f.id)
          .assignments.filter((item) => [a.id, b.id, c.id, d.id].includes(item.taskId)),
      ).toHaveLength(0);
      await f.release();
      expect(
        f.runtime
          .snapshot(f.id)
          .assignments.filter((item) => [a.id, b.id, c.id, d.id].includes(item.taskId))
          .map((item) => item.taskId),
      ).toEqual([a.id, b.id]);
      expect(
        f.runtime.snapshot(f.id).blockers.some((item) => item.includes(`Dependency ${a.id}`)),
      ).toBe(true);
      await f.report(a.id);
      expect(f.runtime.snapshot(f.id).assignments.some((item) => item.taskId === c.id)).toBe(true);
      expect(f.runtime.snapshot(f.id).assignments.some((item) => item.taskId === d.id)).toBe(false);
      await f.report(b.id);
      expect(f.runtime.snapshot(f.id).assignments.some((item) => item.taskId === d.id)).toBe(true);
      await f.report(c.id);
      await f.report(d.id);
      expect(f.runtime.snapshot(f.id).tasks.filter((item) => item.phase === 'review')).toHaveLength(
        1,
      );
    } finally {
      await f.runtime.close();
    }
  });

  test('failed prerequisites require linked correction and explicit idempotent retry', async () => {
    const f = await fixture();
    try {
      const original = await f.create('original', {
        assigneeKey: 'junior',
        verificationRequirements: ['unit'],
      });
      const dependent = await f.create('dependent', {
        assigneeKey: 'senior',
        dependencyIds: [original.id],
      });
      await f.release();
      await f.report(original.id, 'success', [
        { requirement: 'unit', result: 'failed', evidence: 'Unit assertion failed' },
      ]);
      expect(f.runtime.snapshot(f.id).tasks.find((item) => item.id === original.id)?.status).toBe(
        'failed',
      );
      expect(f.runtime.snapshot(f.id).tasks.find((item) => item.id === dependent.id)?.status).toBe(
        'blocked',
      );
      const correction = await f.create('correction', {
        assigneeKey: 'junior',
        correctionOfTaskId: original.id,
      });
      await f.report(correction.id);
      expect(
        f.runtime.snapshot(f.id).assignments.some((item) => item.taskId === dependent.id),
      ).toBe(false);
      const retry = {
        type: 'task.retry' as const,
        taskId: original.id,
        requestId: 'retry-original',
        correctionTaskId: correction.id,
      };
      await f.runtime.execute(f.id, { kind: 'user' }, retry);
      await f.runtime.execute(f.id, { kind: 'user' }, retry);
      expect(
        f.runtime
          .snapshot(f.id)
          .assignments.filter((item) => item.taskId === original.id)
          .map((item) => item.attempt),
      ).toEqual([1, 2]);
      const result = await f.report(original.id, 'success', [
        { requirement: 'unit', result: 'passed', evidence: 'All assertions passed' },
      ]);
      await f.runtime.execute(f.id, result.actor, result.command);
      expect(
        f.runtime.snapshot(f.id).assignments.filter((item) => item.taskId === dependent.id),
      ).toHaveLength(1);
    } finally {
      await f.runtime.close();
    }
  });

  test('approval scopes, blocking decisions, temporary members, and minimal self-inspection gate dispatch', async () => {
    const f = await fixture(team);
    try {
      const scope = { action: 'deploy', resourceId: 'artifact', revision: 'sha-1' };
      const task = await f.create('gated', {
        approvalScopes: [scope],
        verificationRequirements: ['unit'],
      });
      const review = await f.create('self-inspection', { phase: 'review' });
      await f.release();
      expect(f.runtime.snapshot(f.id).assignments.some((item) => item.taskId === task.id)).toBe(
        false,
      );
      await f.runtime.execute(
        f.id,
        { kind: 'user' },
        { type: 'approval.create', scope: { ...scope, revision: 'wrong' }, decision: 'approved' },
      );
      expect(f.runtime.snapshot(f.id).assignments.some((item) => item.taskId === task.id)).toBe(
        false,
      );
      const plan = f.runtime.snapshot(f.id).planning.find((item) => item.passId === f.pass.id)!;
      const decision = (await f.runtime.execute(
        f.id,
        { kind: 'user' },
        {
          type: 'decision.create',
          planId: plan.id,
          category: 'other',
          prompt: 'Confirm new issue?',
          blocking: true,
        },
      )) as { id: string };
      await f.runtime.execute(
        f.id,
        { kind: 'user' },
        { type: 'approval.create', scope, decision: 'approved' },
      );
      expect(f.runtime.snapshot(f.id).assignments.some((item) => item.taskId === task.id)).toBe(
        false,
      );
      await f.runtime.execute(
        f.id,
        { kind: 'user' },
        { type: 'decision.answer', planId: plan.id, decisionId: decision.id, answer: 'Proceed' },
      );
      const assignment = f.runtime
        .snapshot(f.id)
        .assignments.find((item) => item.taskId === task.id)!;
      await expect(
        f.runtime.execute(
          f.id,
          { kind: 'agent', nativeAgentId: assignment.nativeAgentId },
          {
            type: 'report.create',
            assignmentId: assignment.id,
            summary: 'done',
            evidence: 'proof',
            outcome: 'success',
            verification: [],
          },
        ),
      ).rejects.toThrow(/verification/i);
      await f.report(task.id, 'success', [
        { requirement: 'unit', result: 'passed', evidence: 'Unit check passed' },
      ]);
      const snapshot = f.runtime.snapshot(f.id);
      const reviewing = snapshot.assignments.find((item) => item.taskId === review.id)!;
      await f.runtime.execute(
        f.id,
        { kind: 'agent', nativeAgentId: reviewing.nativeAgentId },
        {
          type: 'review.create',
          passId: f.pass.id,
          assignmentId: reviewing.id,
          revision: snapshot.passes.find((item) => item.id === f.pass.id)!.revision,
          outcome: 'accepted',
          summary: 'Self-inspection accepted',
        },
      );
      expect(f.runtime.snapshot(f.id).reviews[0]?.kind).toBe('self');
      expect(f.runtime.snapshot(f.id).passes.find((item) => item.id === f.pass.id)?.status).toBe(
        'completed',
      );
    } finally {
      await f.runtime.close();
    }
  });
  test('restart sends only pending scheduled attempts and retains sent and uncertain attempts', async () => {
    const f = await fixture();
    const a = await f.create('pending', { assigneeKey: 'junior' });
    const b = await f.create('sent', { assigneeKey: 'senior' });
    const c = await f.create('interrupted', { assigneeKey: 'adjutant' });
    await f.release();
    const assignments = f.runtime.snapshot(f.id).assignments;
    await f.runtime.close();
    const store = new CoordinationStore(f.databasePath);
    store.updateAssignment(f.id, assignments.find((item) => item.taskId === a.id)!.id, 'pending');
    store.updateAssignment(f.id, assignments.find((item) => item.taskId === c.id)!.id, 'sending');
    store.close();
    const before = f.agents.sends.length;
    const runtime = createRuntime({
      databasePath: f.databasePath,
      stateDirectory: f.directory,
      team: defaultTeam,
      agents: f.agents,
    });
    try {
      await runtime.openSession({ id: f.id, workspaceRoot: '/workspace' });
      expect(f.agents.sends.length).toBe(before + 1);
      const snapshot = runtime.snapshot(f.id);
      expect(snapshot.assignments.find((item) => item.taskId === a.id)?.status).toBe('sent');
      expect(snapshot.assignments.find((item) => item.taskId === b.id)?.status).toBe('sent');
      expect(snapshot.assignments.find((item) => item.taskId === c.id)?.status).toBe('uncertain');
      expect(snapshot.blockers.some((item) => item.includes('may have been delivered'))).toBe(true);
      await runtime.openSession({ id: f.id, workspaceRoot: '/workspace' });
      expect(f.agents.sends.length).toBe(before + 1);
    } finally {
      await runtime.close();
    }
  });

  test('self-inspection preserves exact approval gates before dispatch and acceptance', async () => {
    const f = await fixture(team);
    try {
      const scope = { action: 'inspect', resourceId: 'complete-pass', revision: 'current' };
      const task = await f.create('work');
      const review = await f.create('inspection', {
        phase: 'review',
        approvalScopes: [scope],
        verificationRequirements: ['inspect-check'],
      });
      await f.release();
      await f.report(task.id);
      expect(f.runtime.snapshot(f.id).assignments.some((item) => item.taskId === review.id)).toBe(
        false,
      );
      await f.runtime.execute(
        f.id,
        { kind: 'user' },
        { type: 'approval.create', scope, decision: 'approved' },
      );
      const assignment = f.runtime
        .snapshot(f.id)
        .assignments.find((item) => item.taskId === review.id)!;
      expect(assignment).toBeDefined();
      await f.runtime.execute(
        f.id,
        { kind: 'user' },
        { type: 'approval.create', scope, decision: 'rejected' },
      );
      const command = {
        type: 'review.create' as const,
        passId: f.pass.id,
        assignmentId: assignment.id,
        revision: f.runtime.snapshot(f.id).passes.find((item) => item.id === f.pass.id)!.revision,
        outcome: 'accepted' as const,
        summary: 'Inspected',
      };
      await expect(
        f.runtime.execute(
          f.id,
          { kind: 'agent', nativeAgentId: assignment.nativeAgentId },
          command,
        ),
      ).rejects.toThrow('unmet');
      expect(f.runtime.snapshot(f.id).passes.find((item) => item.id === f.pass.id)?.status).toBe(
        'running',
      );
      await f.runtime.execute(
        f.id,
        { kind: 'user' },
        { type: 'approval.create', scope, decision: 'approved' },
      );
      const actor = { kind: 'agent' as const, nativeAgentId: assignment.nativeAgentId };
      await expect(f.runtime.execute(f.id, actor, command)).rejects.toThrow('Missing verification');
      await expect(
        f.runtime.execute(f.id, actor, {
          ...command,
          verification: [
            { requirement: 'inspect-check', result: 'failed', evidence: 'Observed failure' },
          ],
        }),
      ).rejects.toThrow('did not pass');
      const accepted = {
        ...command,
        verification: [
          {
            requirement: 'inspect-check',
            result: 'passed' as const,
            evidence: 'Observed passing check',
          },
        ],
      };
      await f.runtime.execute(f.id, actor, accepted);
      expect(f.runtime.snapshot(f.id).passes.find((item) => item.id === f.pass.id)?.status).toBe(
        'completed',
      );
      await f.runtime.execute(f.id, actor, accepted);
      await expect(
        f.runtime.execute(f.id, actor, { ...accepted, revision: command.revision + 99 }),
      ).rejects.toThrow('Conflicting duplicate review');
      await expect(
        f.runtime.execute(f.id, actor, { ...accepted, verification: [] }),
      ).rejects.toThrow('Conflicting duplicate review');
    } finally {
      await f.runtime.close();
    }
  });

  test('a result arriving before its send acknowledgement keeps the member available', async () => {
    const f = await fixture();
    try {
      const first = await f.create('fast-result', { assigneeKey: 'junior' });
      const second = await f.create('next-result', { assigneeKey: 'junior' });
      const sending = new Gate();
      const acknowledged = new Gate();
      const originalSend = f.agents.send.bind(f.agents);
      spyOn(f.agents, 'send').mockImplementation(async (id, message) => {
        if (message.includes(`Scheduled Task ${first.id}`)) {
          sending.resolve();
          await acknowledged.wait();
        }
        await originalSend(id, message);
      });
      const releasing = f.release();
      await sending.wait();
      const reporting = f.report(first.id);
      await Promise.resolve();
      expect(
        f.runtime.snapshot(f.id).assignments.find((item) => item.taskId === first.id)?.status,
      ).toBe('reported');
      acknowledged.resolve();
      await Promise.all([releasing, reporting]);
      expect(
        f.runtime.snapshot(f.id).assignments.find((item) => item.taskId === first.id)?.status,
      ).toBe('reported');
      expect(f.runtime.snapshot(f.id).assignments.some((item) => item.taskId === second.id)).toBe(
        true,
      );
    } finally {
      await f.runtime.close();
    }
  });

  test('requested changes retry the same Pass-wide review gate after linked correction', async () => {
    const f = await fixture();
    try {
      const task = await f.create('implementation', { assigneeKey: 'junior' });
      await f.release();
      await f.report(task.id);
      const first = f.runtime.snapshot(f.id);
      const gate = first.tasks.find((item) => item.requestId === `${f.pass.id}:review`)!;
      const assignment = first.assignments.find((item) => item.taskId === gate.id)!;
      await f.runtime.execute(
        f.id,
        { kind: 'agent', nativeAgentId: assignment.nativeAgentId },
        {
          type: 'review.create',
          passId: f.pass.id,
          assignmentId: assignment.id,
          revision: first.passes.find((item) => item.id === f.pass.id)!.revision,
          outcome: 'changes-requested',
          summary: 'Fix one finding',
        },
      );
      expect(f.runtime.snapshot(f.id).tasks.find((item) => item.id === gate.id)?.status).toBe(
        'failed',
      );
      const correction = await f.create('review-correction', {
        correctionOfTaskId: gate.id,
        assigneeKey: 'reviewer',
      });
      await f.report(correction.id);
      await f.runtime.execute(
        f.id,
        { kind: 'user' },
        {
          type: 'task.retry',
          taskId: gate.id,
          requestId: 'review-retry',
          correctionTaskId: correction.id,
        },
      );
      const current = f.runtime.snapshot(f.id);
      const retry = current.assignments.filter((item) => item.taskId === gate.id).at(-1)!;
      expect(retry.attempt).toBe(2);
      await f.runtime.execute(
        f.id,
        { kind: 'agent', nativeAgentId: retry.nativeAgentId },
        {
          type: 'review.create',
          passId: f.pass.id,
          assignmentId: retry.id,
          revision: current.passes.find((item) => item.id === f.pass.id)!.revision,
          outcome: 'accepted',
          summary: 'Finding fixed and complete Pass accepted',
        },
      );
      expect(f.runtime.snapshot(f.id).tasks.filter((item) => item.phase === 'review')).toHaveLength(
        1,
      );
      expect(f.runtime.snapshot(f.id).passes.find((item) => item.id === f.pass.id)?.status).toBe(
        'completed',
      );
    } finally {
      await f.runtime.close();
    }
  });

  test('temporary assignments wait for explicit spawn and minimal Pass completes without optional review', async () => {
    const f = await fixture();
    try {
      const task = await f.create('temporary', { assigneeKey: 'junior-tmp' });
      await f.release();
      expect(f.runtime.snapshot(f.id).assignments.some((item) => item.taskId === task.id)).toBe(
        false,
      );
      expect(
        f.runtime
          .snapshot(f.id)
          .blockers.some((item) => item.includes('junior-tmp') && item.includes('unavailable')),
      ).toBe(true);
      await f.runtime.execute(
        f.id,
        { kind: 'user' },
        { type: 'team.spawn', memberKey: 'junior-tmp' },
      );
      expect(f.runtime.snapshot(f.id).assignments.some((item) => item.taskId === task.id)).toBe(
        true,
      );
    } finally {
      await f.runtime.close();
    }
    const minimal = await fixture(team);
    try {
      const task = await minimal.create('direct');
      await minimal.release();
      await minimal.report(task.id);
      expect(
        minimal.runtime.snapshot(minimal.id).passes.find((item) => item.id === minimal.pass.id)
          ?.status,
      ).toBe('completed');
      expect(minimal.runtime.snapshot(minimal.id).reviews).toHaveLength(0);
    } finally {
      await minimal.runtime.close();
    }
  });
});

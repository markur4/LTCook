import { describe, expect, test } from 'bun:test';
import team from '@ltcook/team-default-minimal';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import type { AgentBackend, Assignment, Task } from '../../../runtime/src/workflow-api/index.js';

function backend() {
  const sends: { id: string; message: string }[] = [];
  const agents = new Map<string, { id: string; status: string }>();
  const value: AgentBackend = {
    async list() {
      return [...agents.values()];
    },
    async create(options) {
      const agent = { id: options.member.key, status: 'ready' };
      agents.set(agent.id, agent);
      return agent;
    },
    async inspect(id) {
      return agents.get(id) ?? null;
    },
    async send(id, message) {
      sends.push({ id, message });
    },
    async close(id) {
      agents.delete(id);
    },
  };
  return { value, sends };
}

describe('evaluation execution scope', () => {
  test('uses production scheduling and delegation without fabricating Plan consent', async () => {
    const agents = backend();
    const runtime = createRuntime({
      databasePath: ':memory:',
      team,
      agents: agents.value,
      evaluation: { sessionId: 'evaluation' },
    });
    try {
      const initial = await runtime.startEvaluation({
        sessionId: 'evaluation',
        workspaceRoot: '/evaluation',
        title: 'Fixture',
        description: 'Read fixture.',
        requireDelegation: true,
      });
      expect(agents.sends[0]?.message).toContain(
        'assigneeKey to an eligible declared member: adjutant',
      );
      const pass = initial.passes[0]!;
      const bootstrap = initial.assignments[0]!;
      const leader = { kind: 'agent' as const, nativeAgentId: 'leader' };
      await expect(
        runtime.execute('evaluation', leader, {
          type: 'task.update',
          taskId: bootstrap.taskId,
          status: 'completed',
        }),
      ).rejects.toThrow('Create a scheduled scenario Task with task.create');
      expect(
        runtime.snapshot('evaluation').tasks.find((item) => item.id === bootstrap.taskId)?.status,
      ).not.toBe('completed');
      const task = (await runtime.execute('evaluation', leader, {
        type: 'task.create',
        passId: pass.id,
        title: 'Fixture work',
        description: 'Read fixture',
        acceptance: 'Correct result',
        assigneeKey: 'adjutant',
      })) as Task;
      expect(runtime.snapshot('evaluation').assignments).toHaveLength(1);
      await runtime.execute('evaluation', leader, {
        type: 'report.create',
        assignmentId: bootstrap.id,
        summary: 'Registered',
        evidence: 'Fixture graph',
      });
      await runtime.execute('evaluation', leader, {
        type: 'task.update',
        taskId: bootstrap.taskId,
        status: 'completed',
      });
      const assignment = runtime
        .snapshot('evaluation')
        .assignments.find((entry) => entry.taskId === task.id) as Assignment;
      expect(assignment.memberKey).toBe('adjutant');
      expect(runtime.authorizeTool('evaluation', 'adjutant', 'bash', {}).allowed).toBe(true);
      expect(runtime.authorizeTool('evaluation', 'unbound', 'bash', {}).allowed).toBe(false);
      await runtime.execute(
        'evaluation',
        { kind: 'agent', nativeAgentId: 'adjutant' },
        {
          type: 'report.create',
          assignmentId: assignment.id,
          summary: '20',
          evidence: 'Actual fixture',
          outcome: 'success',
        },
      );
      const result = runtime.snapshot('evaluation');
      expect(result.passes[0]?.status).toBe('completed');
      expect(result.planning).toHaveLength(0);
      expect(result.approvals).toHaveLength(0);
      expect(agents.sends).toHaveLength(2);
      await expect(runtime.openSession({ id: 'other', workspaceRoot: '/other' })).rejects.toThrow(
        'disposable',
      );
    } finally {
      await runtime.close();
    }
  });

  test('ordinary controllers cannot create evaluation execution authority', async () => {
    const agents = backend();
    const runtime = createRuntime({ databasePath: ':memory:', team, agents: agents.value });
    try {
      await runtime.openSession({ id: 'normal', workspaceRoot: '/normal' });
      await expect(
        runtime.startEvaluation({
          sessionId: 'normal',
          workspaceRoot: '/normal',
          title: 'Spoof',
          description: 'Not allowed',
        }),
      ).rejects.toThrow('authority');
      expect(runtime.authorizeTool('normal', 'main', 'bash', {}).allowed).toBe(false);
      const pass = (await runtime.execute(
        'normal',
        { kind: 'user' },
        { type: 'pass.create', title: 'Normal' },
      )) as { id: string };
      await expect(
        runtime.execute(
          'normal',
          { kind: 'user' },
          { type: 'pass.update', passId: pass.id, status: 'running' },
        ),
      ).rejects.toThrow('Plan approval');
    } finally {
      await runtime.close();
    }
  });
});

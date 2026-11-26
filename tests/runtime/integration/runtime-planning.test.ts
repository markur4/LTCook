import { createServer } from 'node:net';
import { RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import { SessionActivation } from '../../../runtime/src/integrations/session-activation.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import defaultTeam from '@ltcook/team-default';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import team from '@ltcook/team-default-minimal';
import { Gate, FakeAgents, temporaryDirectories } from './runtime-fixtures.js';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
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
          { type: 'assignment.create', taskId: task.id, memberKey: 'leader', message: 'Execute' },
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
  test('planning finalization dispatch completes while inventory discovery is pending', async () => {
    const f = await fixture();
    const discovery = new Gate();
    let discovered = false;
    const inventory = spyOn(f.runtime, 'ried').mockImplementation(async () => {
      await discovery.wait();
      discovered = true;
      return { status: 'fresh' };
    });
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(f.plan.plan.path, '# Plan\n');
      const first = f.runtime.snapshot(f.snapshot.session.id).assignments[0]!;
      const result = (await f.runtime.execute(
        first.sessionId,
        { kind: 'agent', nativeAgentId: first.nativeAgentId },
        {
          type: 'planning.submit',
          planId: f.plan.id,
          assignmentId: first.id,
          summary: 'Prefilled',
          evidence: f.plan.plan.path,
        },
      )) as import('../../../runtime/src/workflow-api/index.js').PlanningRecord;
      expect(result.stage).toBe('finalize');
      expect(discovered).toBe(false);
      const task = f.runtime
        .snapshot(first.sessionId)
        .tasks.find((item) => item.id === result.taskId);
      expect(task?.description).toContain('RIED discovery is pending; call ltcook_ried');
      discovery.resolve();
      await inventory.mock.results[0]!.value;
      expect(discovered).toBe(true);
    } finally {
      discovery.resolve();
      inventory.mockRestore();
      await f.runtime.close();
    }
  }, 2000);
  test('routes prefill/finalize, rejects forged approval, and enforces document and execution gates', async () => {
    const f = await fixture();
    const id = f.snapshot.session.id;
    try {
      const main = f.snapshot.members.find((item) => item.member.key === 'leader')!.binding!
        .nativeAgentId!;
      const adjutant = f.snapshot.members.find((item) => item.member.key === 'adjutant')!.binding!
        .nativeAgentId!;
      expect(f.runtime.snapshot(id).assignments[0]!.nativeAgentId).toBe(adjutant);
      for (const nativeAgentId of [main, adjutant]) {
        expect(
          f.runtime.authorizeTool(id, nativeAgentId, 'ltcook_ried', { operation: 'summary' })
            .allowed,
        ).toBe(true);
      }
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
  for (const uncertain of [false, true]) {
    test(`CLI approval persists one Leader handoff without replay (uncertain=${uncertain})`, async () => {
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
      const activation = new SessionActivation();
      const api = new RuntimeApi(f.runtime, 'approval-cli-secret', `127.0.0.1:${port}`, activation);
      activation.register(f.directory, f.snapshot.session.id);
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
        const main = f.snapshot.members.find((member) => member.member.key === 'leader')!.binding!
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
    });
  }
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
    const api = new RuntimeApi(
      reopened,
      'cli-recovery-secret',
      `127.0.0.1:${port}`,
      new SessionActivation(),
    );
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
  test('generic reports cannot bypass planning output validation or recovery', async () => {
    const f = await fixture();
    try {
      const assignment = f.runtime
        .snapshot(f.snapshot.session.id)
        .assignments.find((item) => item.id === f.plan.assignmentId)!;
      await expect(
        f.runtime.execute(
          f.snapshot.session.id,
          { kind: 'agent', nativeAgentId: assignment.nativeAgentId },
          {
            type: 'report.create',
            assignmentId: assignment.id,
            summary: 'Done',
            evidence: 'No Plan written',
          },
        ),
      ).rejects.toThrow('planning.submit');
      expect(
        f.runtime
          .snapshot(f.snapshot.session.id)
          .assignments.find((item) => item.id === assignment.id)?.status,
      ).toBe('sent');
      await finishStages(f);
      expect(f.runtime.snapshot(f.snapshot.session.id).planning[0]?.stage).toBe(
        'awaiting-approval',
      );
    } finally {
      await f.runtime.close();
    }
  });
  test('Design assignments honor Design eligibility and routing in the full Team', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-design-routing-'));
    temporaryDirectories.push(directory);
    const runtime = createRuntime({
      databasePath: join(directory, 'db.sqlite'),
      stateDirectory: join(directory, 'runtime'),
      team: defaultTeam,
      agents: new FakeAgents(),
    });
    try {
      const snapshot = await runtime.openSession({ workspaceRoot: directory });
      const task = (await runtime.execute(
        snapshot.session.id,
        { kind: 'user' },
        {
          type: 'task.create',
          workType: 'design',
          title: 'Design',
          description: 'Investigate',
          acceptance: 'Design written',
        },
      )) as { id: string };
      await expect(
        runtime.execute(
          snapshot.session.id,
          { kind: 'user' },
          { type: 'assignment.create', taskId: task.id, memberKey: 'senior', message: 'Design' },
        ),
      ).rejects.toThrow('not eligible');
      const assignment = (await runtime.execute(
        snapshot.session.id,
        { kind: 'user' },
        { type: 'assignment.create', taskId: task.id, message: 'Design' },
      )) as { memberKey: string };
      expect(assignment.memberKey).toBe('leader');
    } finally {
      await runtime.close();
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

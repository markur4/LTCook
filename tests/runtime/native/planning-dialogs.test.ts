import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import type { AgentBackend } from '../../../runtime/src/workflow-api/index.js';
import team from '../../../teams/default-minimal/src/index.js';
import {
  connectPlanningDialogs,
  decisionTitle,
  readPlanForApproval,
  type PlanningDialogEvent,
} from '../../../runtime/src/integrations/planning-dialogs.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test('authenticated host correlates exact question and identity; cancellation and missing requests remain pending', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ltcook-dialogs-'));
  roots.push(root);
  let count = 0;
  const agents = new Map<string, { id: string; status: string }>();
  const backend: AgentBackend = {
    async list() {
      return [...agents.values()];
    },
    async create() {
      const item = { id: `agent-${++count}`, status: 'ready' };
      agents.set(item.id, item);
      return item;
    },
    async inspect(id) {
      return agents.get(id) ?? null;
    },
    async send() {},
    async close() {},
  };
  const runtime = createRuntime({
    databasePath: path.join(root, 'coordination.sqlite'),
    stateDirectory: root,
    team,
    agents: backend,
  });
  try {
    const snapshot = await runtime.openSession({ workspaceRoot: root });
    mkdirSync(path.join(root, 'documents/designs'), { recursive: true });
    const designPath = path.join(root, 'documents/designs/Design-2026_11_14-00_00-example.md');
    writeFileSync(designPath, '# Design');
    const plan = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      { type: 'planning.start', designPath, title: 'Example' },
    )) as { id: string };
    const decision = (await runtime.execute(
      snapshot.session.id,
      { kind: 'user' },
      {
        type: 'decision.create',
        planId: plan.id,
        category: 'intent',
        prompt: 'Which result?',
        blocking: true,
      },
    )) as { id: string };
    let receive!: (event: PlanningDialogEvent) => Promise<void>;
    const stop = connectPlanningDialogs(
      {
        subscribePlanningDialogs(handler) {
          receive = handler;
          return () => {};
        },
      },
      runtime,
    );
    const agentId = snapshot.members[0]!.binding!.nativeAgentId!;
    const title = decisionTitle(
      {
        sessionId: snapshot.session.id,
        planId: plan.id,
        decisionId: decision.id,
        kind: 'question',
      },
      'Which result?',
    );
    const request = (id: string, question = title): PlanningDialogEvent => ({
      type: 'agent_permission_request',
      agentId,
      request: {
        id,
        provider: 'pi',
        name: 'Pi input',
        kind: 'question',
        title: question,
        metadata: { extensionUiMethod: 'input' },
        input: { questions: [{ question, header: 'Response', options: [], multiSelect: false }] },
      },
    });
    const answer = (requestId: string): PlanningDialogEvent => ({
      type: 'agent_permission_resolved',
      agentId,
      requestId,
      resolution: {
        behavior: 'allow',
        updatedInput: { answers: { Response: 'Working framework' } },
      },
    });
    await receive(answer('lost'));
    await receive(request('changed', title.replace('Which result?', 'Different question?')));
    await receive(answer('changed'));
    expect(
      runtime.snapshot(snapshot.session.id).decisions.find((item) => item.id === decision.id)
        ?.answer,
    ).toBeUndefined();
    await receive(request('cancelled'));
    await receive({
      type: 'agent_permission_resolved',
      agentId,
      requestId: 'cancelled',
      resolution: { behavior: 'deny' },
    });
    expect(
      runtime.snapshot(snapshot.session.id).decisions.find((item) => item.id === decision.id)
        ?.answer,
    ).toBeUndefined();
    await receive(request('answered'));
    await receive(answer('answered'));
    await receive(answer('answered'));
    expect(
      runtime.snapshot(snapshot.session.id).decisions.find((item) => item.id === decision.id)
        ?.answer,
    ).toBe('Working framework');
    for (const category of ['breaking-changes', 'verification'] as const) {
      const question = (await runtime.execute(
        snapshot.session.id,
        { kind: 'user' },
        { type: 'decision.create', planId: plan.id, category, prompt: category, blocking: true },
      )) as { id: string };
      await runtime.execute(
        snapshot.session.id,
        { kind: 'user' },
        {
          type: 'decision.answer',
          planId: plan.id,
          decisionId: question.id,
          answer: 'Approved requirements',
        },
      );
    }
    let registered = runtime.snapshot(snapshot.session.id).planning[0]!;
    writeFileSync(registered.plan.path, '# Proposed Plan\nImplement the framework.');
    for (let stage = 0; stage < 2; stage += 1) {
      const assignment = runtime
        .snapshot(snapshot.session.id)
        .assignments.find((item) => item.id === registered.assignmentId)!;
      await runtime.execute(
        snapshot.session.id,
        { kind: 'agent', nativeAgentId: assignment.nativeAgentId },
        {
          type: 'planning.submit',
          planId: plan.id,
          assignmentId: assignment.id,
          summary: 'Ready',
          evidence: 'Document written',
          coverage: (
            ['intent', 'design', 'scope', 'implementation', 'verification', 'delivery'] as const
          ).map((topic) => ({ topic, disposition: 'Resolved' as const, detail: 'Settled' })),
        },
      );
      registered = runtime.snapshot(snapshot.session.id).planning[0]!;
    }
    for (const pending of runtime
      .snapshot(snapshot.session.id)
      .decisions.filter((item) => item.answer === undefined))
      await runtime.execute(
        snapshot.session.id,
        { kind: 'user' },
        {
          type: 'decision.answer',
          planId: plan.id,
          decisionId: pending.id,
          answer: 'Explicit fixture answer',
        },
      );
    const approvalTitle =
      decisionTitle(
        { sessionId: snapshot.session.id, planId: plan.id, decisionId: '', kind: 'approval' },
        `Approve Plan ${plan.id}?`,
      ) +
      '\n\n' +
      readPlanForApproval(registered.plan.path);
    expect(approvalTitle).toContain(registered.plan.path);
    expect(approvalTitle).toContain('Implement the framework.');
    await receive({
      type: 'agent_permission_request',
      agentId,
      request: {
        id: 'approval',
        provider: 'pi',
        name: 'Pi confirm',
        kind: 'question',
        title: approvalTitle,
        metadata: { extensionUiMethod: 'confirm' },
        input: {
          questions: [
            {
              question: approvalTitle,
              header: 'Response',
              options: [{ label: 'Yes' }, { label: 'No' }],
              multiSelect: false,
            },
          ],
        },
      },
    });
    writeFileSync(
      registered.plan.path,
      '# Proposed Plan\nImplement the framework.\n\n# Implementation Report\nProgress.',
    );
    await receive({
      type: 'agent_permission_resolved',
      agentId,
      requestId: 'approval',
      resolution: { behavior: 'allow', updatedInput: { answers: { Response: 'Yes' } } },
    });
    expect(runtime.snapshot(snapshot.session.id).planning[0]!.stage).toBe('approved');
    stop();
  } finally {
    await runtime.close();
  }
});

test('Plan presentation refuses missing and oversized documents', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ltcook-plan-display-'));
  roots.push(root);
  const file = path.join(root, 'Plan.md');
  expect(() => readPlanForApproval(file)).toThrow();
  writeFileSync(file, Buffer.alloc(256 * 1024 + 1));
  expect(() => readPlanForApproval(file)).toThrow('at most 256 KiB');
});

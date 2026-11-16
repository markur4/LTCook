import defaultTeam from '@ltcook/team-default';
import { join } from 'node:path';
import type {
  AgentBackend,
  CreateAgentOptions,
  NativeAgent,
} from '../../../runtime/src/workflow-api/index.js';
import { createRuntime } from '../../../runtime/src/core/runtime.js';

export const reviewRequiredTeam = {
  ...defaultTeam,
  definition: {
    ...defaultTeam.definition,
    reviewPolicy: { ...defaultTeam.definition.reviewPolicy, required: true },
  },
};
export const temporaryDirectories: string[] = [];

export class Gate {
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
export class FakeAgents implements AgentBackend {
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

export async function approveExecutionFixture(
  runtime: ReturnType<typeof createRuntime>,
  sessionId: string,
  release = true,
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
  if (release) {
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
  }
  return { id: approved.passId!, schedulingTaskId: scheduling.id, handoff };
}

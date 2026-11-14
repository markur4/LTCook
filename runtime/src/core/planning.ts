import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Assignment,
  Decision,
  DecisionPresentation,
  DocumentReference,
  PlanCoverage,
  PlanningRecord,
  ProjectSnapshot,
  RuntimeActor,
  RuntimeCommand,
  Session,
  ToolAuthorization,
} from '../workflow-api/index.js';
import type { GuidanceInspection } from '../guidance-api/index.js';
import { CoordinationStore } from '../storage/coordination.js';

const topics = ['intent', 'design', 'scope', 'implementation', 'verification', 'delivery'] as const;
const mandatory = ['intent', 'breaking-changes', 'verification'] as const;
const readTools = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'web_search',
  'fetch_content',
  'get_search_content',
  'code_search',
  'code_fetch',
  'web_enable',
]);
export interface PlanningDependencies {
  stateDirectory: string;
  projectContext?: (workspaceRoot: string) => Promise<ProjectSnapshot>;
  dispatch(
    session: Session,
    record: PlanningRecord,
    stage: 'prefill' | 'finalize',
  ): Promise<Assignment>;
}
/** Owns planning metadata, never Team-authored document contents. */
export class PlanningWorkflow {
  readonly documentsDirectory: string;
  constructor(
    private readonly store: CoordinationStore,
    private readonly dependencies: PlanningDependencies,
  ) {
    this.documentsDirectory = path.resolve(dependencies.stateDirectory, 'documents');
    fs.mkdirSync(path.join(this.documentsDirectory, 'designs'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.documentsDirectory, 'plans'), { recursive: true, mode: 0o700 });
  }
  list(sessionId: string): PlanningRecord[] {
    return this.store.records(sessionId, 'planning');
  }
  decisions(sessionId: string): Decision[] {
    return this.store.records(sessionId, 'decision');
  }
  get(sessionId: string, planId: string): PlanningRecord {
    const record = this.list(sessionId).find((item) => item.id === planId);
    if (!record) throw new Error('Plan is not registered in this Session');
    return record;
  }
  private save(record: PlanningRecord): PlanningRecord {
    return this.store.putRecord(record.sessionId, 'planning', record);
  }
  private user(actor: RuntimeActor): void {
    if (actor.kind !== 'user')
      throw new Error('Only authenticated user responses may answer decisions or approve planning');
  }
  private reference(filePath: string, kind: 'design' | 'plan'): DocumentReference {
    const parent = path.join(this.documentsDirectory, kind === 'design' ? 'designs' : 'plans');
    const candidate = path.resolve(filePath);
    if (
      path.dirname(candidate) !== parent ||
      !new RegExp(
        `^${kind === 'design' ? 'Design' : 'Plan'}-\\d{4}_\\d{2}_\\d{2}-\\d{2}_\\d{2}-[a-z0-9][a-z0-9-]*\\.md$`,
      ).test(path.basename(candidate))
    )
      throw new Error(`Document must use the timestamp naming convention in ${parent}`);
    if (fs.realpathSync(parent) !== parent)
      throw new Error('Document directory must not use a symbolic link');
    if (
      fs.existsSync(candidate) &&
      (!fs.lstatSync(candidate).isFile() || fs.realpathSync(candidate) !== candidate)
    )
      throw new Error('Document must be a regular file without a symbolic link');
    const now = new Date();
    return {
      id: path.basename(candidate, '.md'),
      kind,
      path: candidate,
      createdAt: now.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }
  private planPath(title: string): string {
    const now = new Date();
    const pad = (v: number) => String(v).padStart(2, '0');
    const stamp = `${now.getFullYear()}_${pad(now.getMonth() + 1)}_${pad(now.getDate())}-${pad(now.getHours())}_${pad(now.getMinutes())}`;
    const slug = title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 70)
      .replace(/-$/, '');
    if (!slug) throw new Error('Plan title must contain an ASCII letter or number');
    const candidate = path.join(this.documentsDirectory, 'plans', `Plan-${stamp}-${slug}.md`);
    if (
      fs.existsSync(candidate) ||
      this.store.listSessions().some((s) => this.list(s.id).some((p) => p.plan.path === candidate))
    )
      throw new Error('Plan timestamp/title collision; choose a different concise title');
    return candidate;
  }
  async execute(session: Session, actor: RuntimeActor, command: RuntimeCommand): Promise<unknown> {
    const sessionId = session.id;
    if (command.type === 'planning.start') {
      this.user(actor);
      const design = this.reference(command.designPath, 'design');
      if (!fs.existsSync(design.path)) throw new Error('Design document does not exist');
      const context = await this.dependencies.projectContext?.(session.workspaceRoot);
      const plan = this.reference(this.planPath(command.title), 'plan');
      const record = this.save({
        id: plan.id,
        sessionId,
        title: command.title,
        design,
        plan,
        stage: 'prefill',
        coverage: [],
        ...(context ? { projectContext: context } : {}),
      });
      // > Persist registration before the first externally visible dispatch.
      for (const category of mandatory) {
        const prior = this.decisions(sessionId).find(
          (decision) =>
            decision.category === category &&
            decision.answer !== undefined &&
            this.get(sessionId, decision.planId).design.path === design.path,
        );
        this.store.putRecord(sessionId, 'decision', {
          id: randomUUID(),
          sessionId,
          planId: record.id,
          category,
          prompt:
            category === 'intent'
              ? 'What user intent and outcome must this Plan preserve?'
              : category === 'breaking-changes'
                ? 'What breaking changes, compatibility, and migration decisions apply?'
                : 'What validation and potentially lengthy verification is authorized?',
          blocking: true,
          ...(prior?.answer !== undefined
            ? { answer: prior.answer, answeredAt: prior.answeredAt }
            : {}),
        });
      }
      await this.advance(session, record);
      return this.get(sessionId, record.id);
    }
    if (command.type === 'guidance.loaded') {
      if (actor.kind !== 'agent') throw new Error('Guidance results require a bound native agent');
      return this.store.putRecord(sessionId, 'guidance', {
        id: actor.nativeAgentId,
        inspection: command.inspection,
      });
    }
    if (command.type === 'guidance.inspect') {
      return this.store
        .records<{ id: string; inspection: GuidanceInspection }>(sessionId, 'guidance')
        .filter((item) => command.nativeAgentId === undefined || item.id === command.nativeAgentId);
    }
    if (!('planId' in command)) throw new Error('Unsupported planning command');
    const record = this.get(sessionId, command.planId);
    switch (command.type) {
      case 'planning.show':
        return record;
      case 'planning.questions':
        return this.decisions(sessionId).filter((item) => item.planId === record.id);
      case 'decision.create': {
        const duplicate = this.decisions(sessionId).find(
          (item) =>
            item.planId === record.id &&
            item.category === command.category &&
            item.prompt === command.prompt,
        );
        if (duplicate) return duplicate;
        const decision: Decision = {
          id: randomUUID(),
          sessionId,
          planId: record.id,
          category: command.category,
          prompt: command.prompt,
          blocking: command.blocking,
        };
        return this.store.putRecord(sessionId, 'decision', decision);
      }
      case 'decision.answer': {
        this.user(actor);
        return this.answer(sessionId, record.id, command.decisionId, command.answer);
      }
      case 'planning.submit': {
        if (actor.kind !== 'agent')
          throw new Error('Planning results require the assigned native agent');
        const assignment = this.store.getAssignment(sessionId, command.assignmentId);
        if (assignment.nativeAgentId !== actor.nativeAgentId)
          throw new Error('Planning result is not from the assigned native agent');
        if (
          assignment.status === 'reported' &&
          this.store.getTask(sessionId, assignment.taskId).requestId?.startsWith(`${record.id}:`)
        )
          return record;
        if (assignment.id !== record.assignmentId)
          throw new Error('Planning result does not match the current stage assignment');
        if (!['prefill', 'finalize'].includes(record.stage))
          throw new Error('Plan has no active stage');
        if (!fs.existsSync(record.plan.path) || fs.statSync(record.plan.path).size === 0)
          throw new Error('Assigned Team must write the proposed Plan before submitting');
        this.reference(record.plan.path, 'plan');
        if (record.stage === 'finalize') {
          const coverage = command.coverage ?? [];
          if (
            coverage.length !== topics.length ||
            topics.some((topic) => coverage.filter((item) => item.topic === topic).length !== 1)
          )
            throw new Error('Final Plan must register all six coverage topics exactly once');
          record.coverage = coverage as PlanCoverage[];
        }
        this.save(record);
        this.store.createReport(sessionId, {
          assignmentId: assignment.id,
          nativeAgentId: actor.nativeAgentId,
          summary: command.summary,
          evidence: command.evidence,
        });
        this.store.updateTask(sessionId, { taskId: assignment.taskId, status: 'completed' });
        record.stage = record.stage === 'prefill' ? 'finalize' : 'awaiting-approval';
        delete record.taskId;
        delete record.assignmentId;
        this.save(record);
        if (record.stage === 'finalize') await this.advance(session, record);
        return this.get(sessionId, record.id);
      }
      case 'planning.approve':
      case 'planning.reject': {
        this.user(actor);
        if (command.type === 'planning.reject') {
          record.stage = 'rejected';
          this.save(record);
          return record;
        }
        if (record.stage === 'approved') return record;
        if (record.stage !== 'awaiting-approval')
          throw new Error('Plan finalization must finish before approval');
        if (
          record.coverage.length !== 6 ||
          record.coverage.some((item) => item.disposition === 'Unresolved')
        )
          throw new Error('Unresolved Plan coverage blocks approval');
        const decisions = this.decisions(sessionId).filter((item) => item.planId === record.id);
        if (
          mandatory.some(
            (category) =>
              !decisions.some((item) => item.category === category && item.answer !== undefined),
          )
        )
          throw new Error('All mandatory question categories require recorded user answers');
        if (decisions.some((item) => item.blocking && item.answer === undefined))
          throw new Error('Blocking decisions remain unanswered');
        return this.store.approvePlan(record);
      }
      default:
        throw new Error('Unsupported planning command');
    }
  }
  private answer(sessionId: string, planId: string, decisionId: string, answer: string): Decision {
    const decision = this.decisions(sessionId).find(
      (item) => item.id === decisionId && item.planId === planId,
    );
    if (!decision) throw new Error('Decision is not registered to this Plan and Session');
    if (!answer.trim()) throw new Error('An explicit nonempty answer is required');
    if (decision.answer !== undefined) {
      if (decision.answer !== answer) throw new Error('Decision already has a different answer');
      return decision;
    }
    return this.store.putRecord(sessionId, 'decision', {
      ...decision,
      answer,
      answeredAt: new Date().toISOString(),
    });
  }
  async advance(session: Session, record: PlanningRecord): Promise<void> {
    if (record.stage !== 'prefill' && record.stage !== 'finalize') return;
    if (record.assignmentId) return;
    const assignment = await this.dependencies.dispatch(session, record, record.stage);
    record.taskId = assignment.taskId;
    record.assignmentId = assignment.id;
    this.save(record);
  }
  async recover(session: Session): Promise<void> {
    for (const record of this.list(session.id)) {
      if (record.assignmentId && ['prefill', 'finalize'].includes(record.stage)) {
        const assignment = this.store.getAssignment(session.id, record.assignmentId);
        if (assignment.status === 'reported') {
          this.store.updateTask(session.id, { taskId: assignment.taskId, status: 'completed' });
          record.stage = record.stage === 'prefill' ? 'finalize' : 'awaiting-approval';
          delete record.assignmentId;
          delete record.taskId;
          this.save(record);
        }
      }
      await this.advance(session, record);
    }
  }
  bind(input: DecisionPresentation): void {
    const record = this.get(input.sessionId, input.planId);
    if (input.kind === 'approval') {
      if (record.stage !== 'awaiting-approval') throw new Error('Plan is not ready for approval');
    } else if (
      !this.decisions(input.sessionId).some(
        (item) => item.id === input.decisionId && item.planId === input.planId,
      )
    )
      throw new Error('Decision must be persisted before presentation');
    const bindings = this.store.listBindings(input.sessionId);
    if (
      !bindings.some((item) => item.state === 'bound' && item.nativeAgentId === input.nativeAgentId)
    )
      throw new Error('Decision presentation has no bound native identity');
    const existing = this.store
      .records<DecisionPresentation & { id: string }>(input.sessionId, 'presentation')
      .find((item) => item.id === input.requestId);
    if (existing && JSON.stringify({ ...input, id: input.requestId }) !== JSON.stringify(existing))
      throw new Error('Native request is already correlated to another decision');
    this.store.putRecord(input.sessionId, 'presentation', { ...input, id: input.requestId });
  }
  async resolve(
    session: Session,
    input: { nativeAgentId: string; requestId: string; answer?: string; cancelled?: boolean },
  ): Promise<void> {
    const presentation = this.store
      .records<DecisionPresentation & { id: string }>(session.id, 'presentation')
      .find((item) => item.id === input.requestId && item.nativeAgentId === input.nativeAgentId);
    if (!presentation) throw new Error('Native response does not match a registered presentation');
    if (input.cancelled || input.answer === undefined) return;
    if (presentation.kind === 'approval') {
      if (input.answer !== 'yes' && input.answer !== 'no')
        throw new Error('Approval requires an explicit yes or no');
      await this.execute(
        session,
        { kind: 'user' },
        {
          type: input.answer === 'yes' ? 'planning.approve' : 'planning.reject',
          planId: presentation.planId,
        },
      );
    } else this.answer(session.id, presentation.planId, presentation.decisionId, input.answer);
  }
  approvedPass(sessionId: string, passId: string): boolean {
    const record = this.list(sessionId).find(
      (item) => item.passId === passId && item.stage === 'approved',
    );
    return (
      record !== undefined &&
      !this.decisions(sessionId).some(
        (item) => item.planId === record.id && item.blocking && item.answer === undefined,
      )
    );
  }
  authorize(
    sessionId: string,
    nativeAgentId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): ToolAuthorization {
    const binding = this.store
      .listBindings(sessionId)
      .find((item) => item.nativeAgentId === nativeAgentId && item.state === 'bound');
    if (!binding) return { allowed: false, reason: 'Native identity is not bound to this Session' };
    if (readTools.has(toolName) || toolName === 'ltcook_team')
      return { allowed: true, reason: 'Read-only investigation or guarded coordination' };
    if (['write', 'edit'].includes(toolName)) {
      const filePath = input.path;
      if (typeof filePath === 'string') {
        const candidate = path.resolve(this.store.getSession(sessionId).workspaceRoot, filePath);
        const parent = path.dirname(candidate);
        if (
          parent === path.join(this.documentsDirectory, 'plans') ||
          parent === path.join(this.documentsDirectory, 'designs')
        ) {
          try {
            this.reference(candidate, parent.endsWith(`${path.sep}plans`) ? 'plan' : 'design');
            return { allowed: true, reason: 'Team document directory' };
          } catch {
            return { allowed: false, reason: 'Document path is unsafe' };
          }
        }
      }
    }
    const passes = this.store
      .listPasses(sessionId)
      .filter((pass) => pass.status === 'running' && this.approvedPass(sessionId, pass.id));
    const allowed = passes.some((pass) =>
      this.store
        .listAssignments(sessionId)
        .some(
          (assignment) =>
            assignment.nativeAgentId === nativeAgentId &&
            assignment.status !== 'reported' &&
            this.store.getTask(sessionId, assignment.taskId).passId === pass.id,
        ),
    );
    return {
      allowed,
      reason: allowed
        ? 'Active approved Pass assignment'
        : 'Execution requires an active approved Pass without blocking decisions',
    };
  }
}

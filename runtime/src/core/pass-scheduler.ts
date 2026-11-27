import type { CoordinationStore } from '../storage/coordination.js';
import type {
  Assignment,
  Report,
  Pass,
  NativeBinding,
  RuntimeEvent,
  Session,
  Task,
  TeamPackage,
} from '../workflow-api/index.js';
import { taskGateBlockers } from './task-gates.js';

type SchedulingStore = Pick<
  CoordinationStore,
  | 'createAssignment'
  | 'createTask'
  | 'getPass'
  | 'getTask'
  | 'listApprovals'
  | 'listAssignments'
  | 'listBindings'
  | 'listPasses'
  | 'listReports'
  | 'listReviews'
  | 'listTasks'
  | 'setTaskAssignee'
  | 'updatePass'
  | 'updateTask'
>;

type SchedulerDependencies = {
  isClosed(): boolean;
  executionAllowed(sessionId: string, passId: string): boolean;
  teamFor(session: Session): TeamPackage;
  deliverAssignment(assignment: Assignment): Promise<void>;
  emit(event: RuntimeEvent): void;
  canDispatch?(session: Session, task: Task): boolean;
  prepareMember?(
    session: Session,
    task: Task,
    memberKey: string,
  ): Promise<NativeBinding | undefined>;
  reviewEvidence?(session: Session, pass: Pass): string | undefined;
  completesAfterReview?(session: Session, pass: Pass): boolean;
};

export class PassScheduler {
  private readonly pendingBySession = new Map<string, Promise<void>>();

  constructor(
    private readonly store: SchedulingStore,
    private readonly dependencies: SchedulerDependencies,
  ) {}

  /** Serializes dispatch decisions while native members perform their work concurrently. */
  schedule(session: Session): Promise<void> {
    const previous = this.pendingBySession.get(session.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        this.dependencies.emit({ type: 'scheduler.start', sessionId: session.id });
        try {
          await this.advanceSession(session);
        } finally {
          this.dependencies.emit({ type: 'scheduler.end', sessionId: session.id });
        }
      });
    this.pendingBySession.set(session.id, next);
    return next.finally(() => {
      if (this.pendingBySession.get(session.id) === next) this.pendingBySession.delete(session.id);
    });
  }

  isActiveExecutionPass(sessionId: string, passId: string | undefined): boolean {
    return (
      passId !== undefined &&
      this.store.getPass(sessionId, passId).status === 'running' &&
      this.dependencies.executionAllowed(sessionId, passId)
    );
  }

  private async advanceSession(session: Session): Promise<void> {
    if (this.dependencies.isClosed()) return;
    for (const pass of this.store.listPasses(session.id)) {
      if (pass.status !== 'running' || !this.dependencies.executionAllowed(session.id, pass.id))
        continue;
      const tasks = this.store.listTasks(session.id).filter((task) => task.passId === pass.id);
      const barrier = tasks.find((task) => task.requestId?.endsWith(':execution-handoff'));
      if (!barrier || barrier.status !== 'completed') continue;
      const readDispatchState = () => {
        const assignments = new Map<string, Assignment[]>();
        for (const assignment of this.store.listAssignments(session.id)) {
          const items = assignments.get(assignment.taskId) ?? [];
          items.push(assignment);
          assignments.set(assignment.taskId, items);
        }
        const reports = new Map<string, Report>();
        for (const report of this.store.listReports(session.id))
          if (!reports.has(report.assignmentId)) reports.set(report.assignmentId, report);
        return { assignments, reports };
      };
      let dispatchState = readDispatchState();
      for (const task of tasks.filter((item) => item.scheduled && item.phase !== 'review')) {
        if (['completed', 'failed', 'cancelled'].includes(task.status)) continue;
        const gates = taskGateBlockers(this.store, session.id, task);
        const assignment = (dispatchState.assignments.get(task.id) ?? [])
          .filter((item) => (item.attempt ?? 1) === (task.attempt ?? 1))
          .at(-1);
        const report = assignment && dispatchState.reports.get(assignment.id);
        if (report?.outcome === 'success' && gates.length === 0) {
          this.store.updateTask(session.id, { taskId: task.id, status: 'completed' });
          continue;
        }
        const failedDependency = (task.dependencyIds ?? []).some((id) =>
          ['failed', 'cancelled'].includes(this.store.getTask(session.id, id).status),
        );
        if (!assignment && failedDependency) {
          if (task.status !== 'blocked')
            this.store.updateTask(session.id, {
              taskId: task.id,
              status: 'blocked',
              blocker: gates.join('; '),
            });
          continue;
        }
        if (!assignment && task.status === 'blocked' && gates.length === 0)
          this.store.updateTask(session.id, { taskId: task.id, status: 'pending' });
        if (gates.length === 0 && !report) {
          await this.dispatchScheduled(session, this.store.getTask(session.id, task.id));
          // > Other commands may commit assignments or reports during the awaited send.
          dispatchState = readDispatchState();
        }
      }
      if (!this.isActiveExecutionPass(session.id, pass.id)) continue;
      const current = this.store.listTasks(session.id).filter((task) => task.passId === pass.id);
      const work = current.filter((task) => task.phase !== 'review');
      if (
        !current.some((task) => task.scheduled) ||
        !work.every(
          (task) =>
            task.status === 'completed' &&
            taskGateBlockers(this.store, session.id, task).length === 0,
        )
      )
        continue;
      let gate = current.find((task) => task.scheduled && task.phase === 'review');
      const policy = this.dependencies.teamFor(session).definition.reviewPolicy;
      if (!gate && policy.required) {
        const evidence = this.dependencies.reviewEvidence?.(session, pass);
        if (
          evidence === undefined &&
          this.dependencies.completesAfterReview?.(session, pass) === false
        )
          continue;
        gate = this.store.createTask(session.id, {
          passId: pass.id,
          workType: 'task.execute',
          phase: 'review',
          requestId: `${pass.id}:review`,
          title: `Review Pass: ${pass.title}`,
          description:
            evidence === undefined
              ? 'Review the complete Pass. Fix in-scope findings before acceptance, or request changes. Record review.create with this assignmentId and the current Pass revision.'
              : 'Review the complete verified tree. Use read-only source inspection. Request changes if a correction is required. Record review.create with this assignmentId and the current Pass revision.',
          acceptance: 'Current-revision Pass-wide acceptance by the declared reviewer',
        });
      }
      if (gate) {
        if (taskGateBlockers(this.store, session.id, gate).length) continue;
        if (gate.status !== 'completed') {
          if (gate.status !== 'failed') await this.dispatchScheduled(session, gate);
          continue;
        }
        const latest = this.store
          .listReviews(session.id)
          .filter((review) => review.passId === pass.id)
          .at(-1);
        if (
          latest?.outcome !== 'accepted' ||
          latest.revision !== this.store.getPass(session.id, pass.id).revision
        )
          continue;
      }
      if (this.dependencies.completesAfterReview?.(session, pass) !== false)
        this.store.updatePass(session.id, { passId: pass.id, status: 'completed' });
    }
  }

  private async dispatchScheduled(session: Session, task: Task): Promise<void> {
    if (
      !task.passId ||
      !this.isActiveExecutionPass(session.id, task.passId) ||
      this.dependencies.canDispatch?.(session, task) === false ||
      taskGateBlockers(this.store, session.id, task).length
    )
      return;
    const assignments = this.store.listAssignments(session.id);
    const previous = assignments
      .filter((item) => item.taskId === task.id && (item.attempt ?? 1) === (task.attempt ?? 1))
      .at(-1);
    if (previous && previous.status !== 'pending') return;
    const policy = this.dependencies.teamFor(session).definition.reviewPolicy;
    const review = task.phase === 'review';
    const eligible = this.dependencies.teamFor(session).definition.members.filter((member) => {
      if (!member.workTypes.includes('task.execute')) return false;
      if (!review) return true;
      if (policy.mode === 'self')
        return member.key === this.dependencies.teamFor(session).definition.leaderKey;
      return (
        policy.reviewerKeys.includes(member.key) &&
        member.key !== this.dependencies.teamFor(session).definition.leaderKey &&
        !assignments.some(
          (assignment) =>
            assignment.memberKey === member.key &&
            this.store.getTask(session.id, assignment.taskId).passId === task.passId &&
            this.store.getTask(session.id, assignment.taskId).phase !== 'review' &&
            this.store.getTask(session.id, assignment.taskId).correctionOfTaskId !== task.id,
        )
      );
    });
    let selected = task.assigneeKey;
    if (!selected) {
      selected = review
        ? (eligible.find((member) => member.lifetime === 'persistent')?.key ?? eligible[0]?.key)
        : ((await this.dependencies.teamFor(session).selectAssignee?.(
            Object.freeze({
              workType: 'task.execute',
              sessionId: session.id,
              workspaceRoot: session.workspaceRoot,
            }),
            Object.freeze(eligible.map((member) => Object.freeze({ ...member }))),
          )) ?? this.dependencies.teamFor(session).definition.routing['task.execute']);
      if (!selected) return;
      if (!eligible.some((member) => member.key === selected))
        throw new Error(
          `Selected member is not eligible for ${review ? 'Pass review' : 'task.execute'}`,
        );
      this.store.setTaskAssignee(session.id, task.id, selected);
    }
    // > A routing hook may yield while a new blocking decision is recorded.
    if (
      !this.isActiveExecutionPass(session.id, task.passId) ||
      taskGateBlockers(this.store, session.id, this.store.getTask(session.id, task.id)).length
    )
      return;
    if (!eligible.some((member) => member.key === selected))
      throw new Error(
        `Selected member is not eligible for ${review ? 'Pass review' : 'task.execute'}`,
      );
    if (
      assignments.some(
        (item) =>
          item.memberKey === selected && item.id !== previous?.id && item.status !== 'reported',
      )
    )
      return;
    let binding = this.store.listBindings(session.id).find((item) => item.memberKey === selected);
    if (binding?.state !== 'bound' && this.dependencies.prepareMember)
      binding = await this.dependencies.prepareMember(session, task, selected);
    if (binding?.state !== 'bound' || !binding.nativeAgentId) return;
    if (
      !this.isActiveExecutionPass(session.id, task.passId) ||
      this.dependencies.canDispatch?.(session, task) === false
    )
      return;
    const reviewedTree = review
      ? this.dependencies.reviewEvidence?.(session, this.store.getPass(session.id, task.passId))
      : undefined;
    const assignment =
      previous ??
      this.store.createAssignment(session.id, {
        taskId: task.id,
        memberKey: selected,
        nativeAgentId: binding.nativeAgentId,
        message: `${review ? 'Pass-wide review' : 'Scheduled Task'} ${task.id} in Pass ${task.passId}. ${task.description} ${reviewedTree ? `${reviewedTree} ` : ''}Acceptance: ${task.acceptance}. Verification requirements: ${JSON.stringify(task.verificationRequirements)}. ${review ? 'Submit review.create with assignmentId and the current Pass revision.' : 'Submit report.create with outcome success or failure and named verification entries with evidence.'}`,
      });
    if (task.status !== 'running')
      this.store.updateTask(session.id, { taskId: task.id, status: 'running' });
    await this.dependencies.deliverAssignment(assignment);
  }
}

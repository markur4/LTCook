import path from 'node:path';
import { TeamRegistry } from '../integrations/team-loader.js';
import { PlanningWorkflow } from './planning.js';
import type { WorkType } from '../team-api/index.js';
import type {
  AgentBackend,
  Assignment,
  MemberSnapshot,
  NativeAgent,
  NativeBinding,
  RuntimeActor,
  RuntimeCommand,
  RuntimeController as RuntimeControllerContract,
  RuntimeEvent,
  Session,
  SessionSnapshot,
  TeamPackage,
  PlanningRecord,
  DecisionPresentation,
  Task,
} from '../workflow-api/index.js';
import { CoordinationStore } from '../storage/coordination.js';
import { canonicalWorkspace } from './workspace.js';
import { RiedService, type RiedRequest } from '../ried.js';

type RuntimeOptions = {
  databasePath: string;
  team: TeamPackage;
  teams?: TeamRegistry;
  agents: AgentBackend;
  stateDirectory?: string;
  ried?: RiedService;
  onEvent?: (event: RuntimeEvent) => void;
  evaluation?: { sessionId: string; toolBudget?: number };
};

/** Creates one coordination owner with Session-specific Teams and native agents. */
export function createRuntime(options: RuntimeOptions): RuntimeController {
  return new RuntimeController(options);
}

export class RuntimeController implements RuntimeControllerContract {
  private readonly store: CoordinationStore;
  private evaluationPass: { sessionId: string; passId: string } | undefined;
  private readonly evaluationSessionId: string | undefined;
  private readonly evaluationToolBudget: number;
  private evaluationToolCalls = 0;
  private readonly defaultTeam: TeamPackage;
  private readonly teams: TeamRegistry;
  private readonly agents: AgentBackend;
  private readonly onEvent: (event: RuntimeEvent) => void;
  private readonly sessions = new Map<string, Session>();
  private readonly nativeById = new Map<string, NativeAgent>();
  private closed = false;
  private readonly planning: PlanningWorkflow;
  private readonly riedService: RiedService | undefined;
  private readonly initializedSessions = new Set<string>();
  private readonly initializingSessions = new Map<string, Promise<void>>();
  private readonly scheduling = new Map<string, Promise<void>>();
  constructor(options: RuntimeOptions) {
    if (options.team.apiVersion !== 3)
      throw new Error(`Unsupported team API version ${String(options.team.apiVersion)}`);
    this.defaultTeam = options.team;
    this.teams = options.teams ?? new TeamRegistry([options.team]);
    this.evaluationSessionId = options.evaluation?.sessionId;
    this.evaluationToolBudget = options.evaluation?.toolBudget ?? 64;
    this.agents = options.agents;
    this.onEvent = options.onEvent ?? (() => undefined);
    for (const type of ['design', 'plan.prefill', 'plan.finalize', 'task.execute'] as const) {
      const key = this.defaultTeam.definition.routing[type];
      if (
        !this.defaultTeam.definition.members.some(
          (member) => member.key === key && member.workTypes.includes(type),
        )
      )
        throw new Error(`Invalid routing for ${type}`);
    }
    this.store = new CoordinationStore(options.databasePath);
    this.riedService = options.ried;
    this.planning = new PlanningWorkflow(this.store, {
      stateDirectory:
        options.stateDirectory ??
        process.env.LTCOOK_RUNTIME_STATE_DIR ??
        path.join(path.dirname(options.databasePath), 'runtime'),
      executionAllowed: (sessionId, passId) => this.executionAllowed(sessionId, passId),
      dispatch: (session, record, stage) => this.dispatchPlanning(session, record, stage),
      scheduleExecution: (session, record) => this.scheduleExecution(session, record),
    });
  }

  /** Starts a predefined scenario in an evaluation-owned controller, without impersonating a user. */
  async startEvaluation(input: {
    sessionId: string;
    workspaceRoot: string;
    title: string;
    description: string;
  }): Promise<SessionSnapshot> {
    if (
      !this.evaluationSessionId ||
      input.sessionId !== this.evaluationSessionId ||
      this.evaluationPass
    )
      throw new Error('Evaluation authority is unavailable for this Session');
    await this.openSession({ id: input.sessionId, workspaceRoot: input.workspaceRoot });
    const pass = this.store.createPass(input.sessionId, { title: input.title });
    this.evaluationPass = { sessionId: input.sessionId, passId: pass.id };
    this.store.updatePass(input.sessionId, { passId: pass.id, status: 'running' });
    const task = this.store.createTask(input.sessionId, {
      passId: pass.id,
      title: input.title,
      description: input.description,
      acceptance:
        'Register the scenario Tasks, report the scheduling result, and complete this scheduling Task.',
      scheduled: false,
      requestId: `evaluation:${pass.id}:execution-handoff`,
    });
    const leader = this.store
      .listBindings(input.sessionId)
      .find((binding) => binding.memberKey === this.teamFor(input.sessionId).definition.leaderKey);
    if (leader?.state !== 'bound' || !leader.nativeAgentId)
      throw new Error(`Evaluation leader is unavailable: ${leader?.blocker ?? leader?.state}`);
    const assignment = this.store.createAssignment(input.sessionId, {
      taskId: task.id,
      memberKey: leader.memberKey,
      nativeAgentId: leader.nativeAgentId,
      message: `Predefined evaluation scope for Pass ${pass.id}. Interactive Plan approval is outside this evaluation. ${input.description} Register scheduled task.execute Tasks with this passId, submit report.create for this scheduling assignment, then task.update this scheduling Task to completed. The production scheduler dispatches the Tasks.`,
    });
    await this.deliverAssignment(assignment);
    await this.schedule(this.session(input.sessionId));
    return this.snapshot(input.sessionId);
  }

  private executionAllowed(sessionId: string, passId: string): boolean {
    return (
      (this.evaluationPass?.sessionId === sessionId && this.evaluationPass.passId === passId) ||
      this.planning.approvedPass(sessionId, passId)
    );
  }

  async openSession(input: {
    id?: string;
    workspaceRoot: string;
    teamSelection?: string;
    leaderAgentId?: string;
  }): Promise<SessionSnapshot> {
    this.assertOpen();
    if (this.evaluationSessionId && input.id !== this.evaluationSessionId)
      throw new Error('Evaluation controllers accept only their disposable Session');
    if (input.leaderAgentId && input.id !== input.leaderAgentId)
      throw new Error('Session ID must equal its adopted Leader ID');
    const selected = this.teams.resolve(input.teamSelection ?? this.defaultTeam.definition.id);
    const session =
      input.id === undefined
        ? this.store.createSession({
            teamId: selected.definition.id,
            workspaceRoot: input.workspaceRoot,
          })
        : this.loadOrCreateSession(input.id, input.workspaceRoot, selected.definition.id);
    this.assertSessionSelection(session, input.workspaceRoot);
    if (session.teamId !== selected.definition.id) throw new Error('Session Team is immutable');
    this.sessions.set(session.id, session);
    if (input.leaderAgentId) {
      const existing = this.store
        .listBindings(session.id)
        .find((binding) => binding.memberKey === selected.definition.leaderKey);
      if (
        session.id !== input.leaderAgentId ||
        (existing && existing.nativeAgentId !== input.leaderAgentId)
      )
        throw new Error('Session Leader identity is immutable');
      this.store.putBinding({
        sessionId: session.id,
        teamId: session.teamId,
        memberKey: selected.definition.leaderKey,
        nativeAgentId: input.leaderAgentId,
        workspaceRoot: session.workspaceRoot,
        state: 'bound',
      });
      return this.snapshot(session.id);
    }
    if (this.initializedSessions.has(session.id)) return this.snapshot(session.id);
    await this.initializeSession(session);
    void this.riedService?.get(session, { operation: 'summary' }).catch(() => undefined);
    return this.snapshot(session.id);
  }

  async ried(sessionId: string, request: RiedRequest): Promise<unknown> {
    this.assertOpen();
    if (!this.riedService) throw new Error('RIED is unavailable');
    return this.riedService.get(this.session(sessionId), request);
  }

  private assertSessionSelection(session: Session, workspaceRoot: string): void {
    this.teams.resolve(session.teamId);
    if (session.workspaceRoot !== canonicalWorkspace(workspaceRoot)) {
      throw new Error('A persisted session has a different selected team or workspace');
    }
  }

  private async initializeSession(session: Session): Promise<void> {
    if (this.initializedSessions.has(session.id)) return;
    const pending = this.initializingSessions.get(session.id);
    if (pending !== undefined) return pending;
    this.sessions.set(session.id, session);
    const initialization = (async () => {
      await this.reconcile(session);
      await this.planning.recover(session);
      this.initializedSessions.add(session.id);
      await this.schedule(session);
    })();
    this.initializingSessions.set(session.id, initialization);
    try {
      await initialization;
    } finally {
      this.initializingSessions.delete(session.id);
    }
  }

  private loadOrCreateSession(id: string, workspaceRoot: string, teamId: string): Session {
    const existing = this.store.listSessions().find((session) => session.id === id);
    return existing ?? this.store.createSession({ id, teamId, workspaceRoot });
  }

  snapshot(sessionId: string): SessionSnapshot {
    this.assertOpen();
    const session = this.session(sessionId);
    const bindings = this.store.listBindings(sessionId);
    const members: MemberSnapshot[] = this.teamFor(sessionId).definition.members.map((member) => {
      const binding = bindings.find((item) => item.memberKey === member.key) ?? null;
      return {
        member,
        binding,
        nativeStatus:
          binding?.state === 'bound' && binding.nativeAgentId
            ? (this.nativeById.get(binding.nativeAgentId)?.status ?? null)
            : null,
      };
    });
    const assignments = this.store.listAssignments(sessionId);
    const blockers = bindings
      .filter(
        (binding) =>
          binding.state === 'missing' ||
          binding.state === 'uncertain' ||
          binding.state === 'creating',
      )
      .map((binding) => `${binding.memberKey}: ${binding.blocker ?? binding.state}`);
    for (const task of this.store.listTasks(sessionId)) {
      if (task.scheduled && !['completed', 'failed', 'cancelled'].includes(task.status)) {
        const barrier = this.store
          .listTasks(sessionId)
          .find(
            (item) => item.passId === task.passId && item.requestId?.endsWith(':execution-handoff'),
          );
        if (barrier?.status !== 'completed')
          blockers.push(
            `Task ${task.id}: Waiting for Leader to complete initial Task registration`,
          );
        if (task.phase === 'review' && task.assigneeKey === undefined)
          blockers.push(`Task ${task.id}: Waiting for an available declared Pass reviewer`);
        blockers.push(
          ...this.taskGates(sessionId, task).map((reason) => `Task ${task.id}: ${reason}`),
        );
        if (task.assigneeKey) {
          const binding = bindings.find((item) => item.memberKey === task.assigneeKey);
          if (binding?.state !== 'bound')
            blockers.push(
              `Task ${task.id}: Member ${task.assigneeKey} is unavailable (${binding?.state ?? 'not spawned'})`,
            );
          else if (
            assignments.some(
              (item) =>
                item.memberKey === task.assigneeKey &&
                item.taskId !== task.id &&
                item.status !== 'reported',
            )
          )
            blockers.push(`Task ${task.id}: Member ${task.assigneeKey} has an active assignment`);
        }
      }
      if (task.requestId?.endsWith(':execution-handoff') && task.status === 'blocked')
        blockers.push(`Scheduling Task ${task.id}: ${task.blocker ?? 'blocked'}`);
    }
    for (const assignment of assignments) {
      if (assignment.status === 'uncertain')
        blockers.push(`Assignment ${assignment.id} may have been delivered; it was not resent`);
    }
    return {
      session,
      definition: this.teamFor(sessionId).definition,
      members,
      passes: this.store.listPasses(sessionId),
      tasks: this.store.listTasks(sessionId),
      steps: this.store.listSteps(sessionId),
      assignments,
      reports: this.store.listReports(sessionId),
      reviews: this.store.listReviews(sessionId),
      approvals: this.store.listApprovals(sessionId),
      documentsDirectory: this.planning.documentsDirectory,
      blockers,
      planning: this.planning.list(sessionId),
      decisions: this.planning.decisions(sessionId),
    };
  }

  async execute(sessionId: string, actor: RuntimeActor, command: RuntimeCommand): Promise<unknown> {
    const result = await this.executeCommand(sessionId, actor, command);
    if (this.initializedSessions.has(sessionId)) await this.schedule(this.session(sessionId));
    return result;
  }

  private async executeCommand(
    sessionId: string,
    actor: RuntimeActor,
    command: RuntimeCommand,
  ): Promise<unknown> {
    this.assertOpen();
    const session = this.session(sessionId);
    if (
      command.type === 'guidance.loaded' &&
      actor.kind === 'agent' &&
      this.store
        .listBindings(sessionId)
        .some(
          (binding) => binding.nativeAgentId === actor.nativeAgentId && binding.state === 'bound',
        )
    ) {
      const result = await this.planning.execute(session, actor, command);
      if (!this.initializedSessions.has(sessionId) && command.inspection.diagnostics.length === 0) {
        setTimeout(() => {
          void this.initializeSession(session).catch(() =>
            this.emit({ type: 'session.initialization.failed', sessionId }),
          );
        }, 0);
      }
      return result;
    }
    if (
      (actor.kind === 'agent' ||
        command.type === 'planning.start' ||
        command.type === 'planning.approve') &&
      !this.initializedSessions.has(sessionId)
    )
      throw new Error(
        'Session must be explicitly opened and reconciled before native work or execution approval',
      );
    const identity =
      actor.kind === 'agent'
        ? this.store
            .listBindings(sessionId)
            .find(
              (binding) =>
                binding.nativeAgentId === actor.nativeAgentId && binding.state === 'bound',
            )
        : undefined;
    if (actor.kind === 'agent' && identity === undefined)
      throw new Error('Agent identity is not bound to this session');
    const leader = identity?.memberKey === this.teamFor(sessionId).definition.leaderKey;
    if (
      this.evaluationSessionId === sessionId &&
      (command.type.startsWith('planning.') || command.type.startsWith('decision.'))
    )
      throw new Error('Interactive planning and user decisions are outside evaluation coverage');
    if (
      command.type.startsWith('planning.') ||
      command.type.startsWith('decision.') ||
      command.type.startsWith('guidance.')
    )
      return this.planning.execute(session, actor, command);

    const executionPass = (passId: string | undefined) => {
      if (
        passId === undefined ||
        this.store.getPass(sessionId, passId).status !== 'running' ||
        !this.executionAllowed(sessionId, passId)
      )
        throw new Error('Execution work requires an active approved Pass');
    };
    if (command.type === 'assignment.create') {
      const task = this.store.getTask(sessionId, command.taskId);
      if (task.workType === 'task.execute') executionPass(task.passId);
    }
    if (command.type === 'task.update' && command.status === 'running') {
      const task = this.store.getTask(sessionId, command.taskId);
      if (task.workType === 'task.execute') executionPass(task.passId);
    }
    if (actor.kind === 'agent') {
      const assertTask = (taskId: string) => {
        const task = this.store.getTask(sessionId, taskId);
        if (task.workType === 'task.execute') executionPass(task.passId);
      };
      switch (command.type) {
        case 'pass.create':
          throw new Error('Core creates execution Passes only after Plan approval');
        case 'task.create':
          if (command.workType === undefined || command.workType === 'task.execute')
            executionPass(command.passId);
          break;
        case 'task.retry':
        case 'task.update':
        case 'step.create':
        case 'assignment.create':
          assertTask(command.taskId);
          break;
        case 'step.update':
          assertTask(this.store.getStep(sessionId, command.stepId).taskId);
          break;
        case 'pass.update':
          executionPass(command.passId);
          break;
      }
    }
    switch (command.type) {
      case 'pass.create':
        this.requireLeader(actor, leader);
        return this.store.createPass(sessionId, command);
      case 'pass.update': {
        this.requireLeader(actor, leader);
        if (command.status === 'running' && !this.executionAllowed(sessionId, command.passId))
          throw new Error('Pass execution requires its registered Plan approval');
        if (
          command.status === 'completed' &&
          this.store
            .listTasks(sessionId)
            .some((task) => task.passId === command.passId && task.scheduled)
        )
          throw new Error('Scheduled Pass completion is owned by the runtime');
        if (
          command.status === 'completed' &&
          this.teamFor(sessionId).definition.reviewPolicy.required
        ) {
          const pass = this.store.getPass(sessionId, command.passId);
          const latest = this.store
            .listReviews(sessionId)
            .filter((review) => review.passId === pass.id)
            .at(-1);
          if (latest?.outcome !== 'accepted' || latest.revision !== pass.revision) {
            throw new Error('Pass requires an accepted review of its current revision');
          }
        }
        return this.store.updatePass(sessionId, command);
      }
      case 'task.create': {
        this.requireLeader(actor, leader);
        if (
          command.passId &&
          (command.workType === undefined || command.workType === 'task.execute')
        ) {
          if (command.scheduled === false)
            throw new Error('Pass execution Tasks are scheduled by the runtime');
          if (command.phase === 'review') {
            const policy = this.teamFor(sessionId).definition.reviewPolicy;
            if (policy.mode !== 'self')
              throw new Error('Core registers the independent Pass-wide review gate');
            const tasks = this.store
              .listTasks(sessionId)
              .filter((task) => task.passId === command.passId);
            if (
              tasks.some((task) => task.scheduled) &&
              tasks.filter((task) => task.scheduled).every((task) => task.status === 'completed')
            )
              throw new Error('Self-inspection must be registered before the final Task finishes');
            return this.store.createTask(sessionId, {
              ...command,
              requestId: `${command.passId}:review`,
              assigneeKey: this.teamFor(sessionId).definition.leaderKey,
            });
          }
        }
        if (
          command.assigneeKey &&
          !this.member(session, command.assigneeKey).workTypes.includes(
            command.workType === 'design' ? 'design' : 'task.execute',
          )
        )
          throw new Error('Selected member is not eligible for this Task');
        return this.store.createTask(sessionId, command);
      }
      case 'task.retry':
        this.requireLeader(actor, leader);
        return this.store.retryTask(sessionId, command);
      case 'task.update': {
        const task = this.store.getTask(sessionId, command.taskId);
        if (task.scheduled && command.status !== undefined && command.status !== task.status)
          throw new Error(
            'Scheduled Task status is owned by the runtime; report a result or retry it',
          );
        if (command.dependencyIds !== undefined) this.requireLeader(actor, leader);
        if (actor.kind === 'agent' && !leader) {
          const ownsTask = this.store
            .listAssignments(sessionId)
            .some(
              (assignment) =>
                assignment.taskId === task.id && assignment.nativeAgentId === actor.nativeAgentId,
            );
          if (
            !ownsTask ||
            command.status === undefined ||
            !['running', 'blocked', 'failed'].includes(command.status)
          )
            throw new Error(
              'Agents may update only the status of tasks assigned to their bound native identity',
            );
        }
        return this.store.updateTask(sessionId, command);
      }
      case 'step.create':
        this.requireLeader(actor, leader);
        return this.store.createStep(sessionId, command);
      case 'assignment.create': {
        this.requireLeader(actor, leader);
        const task = this.store.getTask(sessionId, command.taskId);
        if (task.scheduled) throw new Error('Scheduled Tasks are assigned by the runtime');
        const workType = task.workType === 'design' ? 'design' : 'task.execute';
        const eligible = this.teamFor(sessionId).definition.members.filter((member) =>
          member.workTypes.includes(workType),
        );
        const selected =
          command.memberKey ??
          (await this.teamFor(sessionId).selectAssignee?.(
            Object.freeze({
              workType,
              sessionId,
              workspaceRoot: session.workspaceRoot,
            }),
            Object.freeze(eligible.map((member) => Object.freeze({ ...member }))),
          )) ??
          this.teamFor(sessionId).definition.routing[workType];
        if (!eligible.some((member) => member.key === selected))
          throw new Error(`Selected member is not eligible for ${workType}`);
        const member = this.member(session, selected);
        const binding =
          member.lifetime === 'temporary'
            ? this.store.listBindings(sessionId).find((item) => item.memberKey === member.key)
            : await this.ensureMember(session, member.key);
        if (binding === undefined || binding.state !== 'bound' || binding.nativeAgentId === null)
          throw new Error(
            `Member ${member.key} is unavailable: ${binding?.blocker ?? binding?.state ?? 'temporary member has not been explicitly spawned'}`,
          );
        if (
          this.store
            .listAssignments(sessionId)
            .some((item) => item.taskId === command.taskId && item.memberKey === member.key)
        )
          throw new Error(
            'This task already has an assignment to that member; the handoff will not be replayed',
          );
        const assignment = this.store.createAssignment(sessionId, {
          ...command,
          memberKey: member.key,
          nativeAgentId: binding.nativeAgentId,
        });
        await this.deliverAssignment(assignment);
        return this.store.getAssignment(sessionId, assignment.id);
      }
      case 'report.create': {
        const assignment = this.store.getAssignment(sessionId, command.assignmentId);
        if (actor.kind !== 'agent' || assignment.nativeAgentId !== actor.nativeAgentId)
          throw new Error('Only the assigned native agent may report this task');
        const reportedTask = this.store.getTask(sessionId, assignment.taskId);
        if (reportedTask.scheduled && reportedTask.phase === 'review')
          throw new Error('Pass review requires review.create');
        const requestId = reportedTask.requestId;
        if (
          this.planning
            .list(sessionId)
            .some((record) =>
              [`${record.id}:prefill`, `${record.id}:finalize`].includes(requestId ?? ''),
            )
        )
          throw new Error('Planning stages require planning.submit with validated document output');
        const report = this.store.createReport(sessionId, {
          ...command,
          nativeAgentId: actor.nativeAgentId,
        });
        this.emit({
          type: 'assignment.reported',
          sessionId,
          taskId: assignment.taskId,
          assignmentId: assignment.id,
          memberKey: assignment.memberKey,
        });
        return report;
      }
      case 'step.update': {
        const step = this.store.getStep(sessionId, command.stepId);
        const task = this.store.getTask(sessionId, step.taskId);
        if (
          actor.kind === 'agent' &&
          !leader &&
          !this.store
            .listAssignments(sessionId)
            .some(
              (assignment) =>
                assignment.taskId === task.id && assignment.nativeAgentId === actor.nativeAgentId,
            )
        )
          throw new Error('Agents may update only Steps belonging to their assigned tasks');
        return this.store.updateStep(sessionId, command);
      }
      case 'review.create': {
        if (actor.kind !== 'agent' || identity === undefined)
          throw new Error('Review requires a bound agent');
        const reviewPolicy = this.teamFor(sessionId).definition.reviewPolicy;
        const selfReview =
          reviewPolicy.mode === 'self' &&
          identity.memberKey === this.teamFor(sessionId).definition.leaderKey;
        if (reviewPolicy.mode === 'self' && !selfReview)
          throw new Error('This team permits leader self-inspection only');
        if (
          reviewPolicy.mode === 'independent' &&
          (!reviewPolicy.reviewerKeys.includes(identity.memberKey) ||
            identity.memberKey === this.teamFor(sessionId).definition.leaderKey)
        )
          throw new Error('This member is not an independent reviewer');
        const gate = this.store
          .listTasks(sessionId)
          .find(
            (task) => task.passId === command.passId && task.scheduled && task.phase === 'review',
          );
        if (
          !gate &&
          this.store
            .listTasks(sessionId)
            .some((task) => task.passId === command.passId && task.scheduled)
        )
          throw new Error('Scheduled Pass review awaits its runtime review gate');
        if (gate) {
          if (!command.assignmentId || command.revision === undefined)
            throw new Error('Scheduled review requires its assignmentId and current Pass revision');
          const assignment = this.store.getAssignment(sessionId, command.assignmentId);
          if (assignment.taskId !== gate.id || assignment.nativeAgentId !== actor.nativeAgentId)
            throw new Error('Only the assigned Pass reviewer may submit this review');
          if (command.outcome === 'accepted' && this.taskGates(sessionId, gate).length)
            throw new Error('Pass review has unmet dependencies or approval gates');
          if (
            this.store
              .listTasks(sessionId)
              .some(
                (task) =>
                  task.passId === command.passId &&
                  task.id !== gate.id &&
                  task.status !== 'completed',
              )
          )
            throw new Error('Pass review requires all non-review Tasks to be completed');
        }
        if (reviewPolicy.mode === 'independent') {
          const assignments = this.store.listAssignments(sessionId);
          const assignedToPass = this.store
            .listTasks(sessionId)
            .filter(
              (task) =>
                task.passId === command.passId &&
                task.phase !== 'review' &&
                task.correctionOfTaskId !== gate?.id,
            )
            .some((task) =>
              assignments.some(
                (assignment) =>
                  assignment.taskId === task.id && assignment.memberKey === identity.memberKey,
              ),
            );
          if (assignedToPass)
            throw new Error('A member assigned to this Pass cannot independently review it');
        }
        return this.store.createReview(sessionId, {
          ...command,
          nativeAgentId: actor.nativeAgentId,
          kind: selfReview ? 'self' : 'independent',
        });
      }
      case 'approval.create':
        if (actor.kind !== 'user')
          throw new Error('Only the trusted user route can create approvals');
        return this.store.createApproval(sessionId, command);
      case 'team.spawn':
        this.requireLeader(actor, leader);
        if (this.member(session, command.memberKey).lifetime !== 'temporary')
          throw new Error('Only explicitly temporary members may be spawned on demand');
        return this.ensureMember(session, command.memberKey);
      case 'team.close':
        this.requireLeader(actor, leader);
        return this.closeTemporaryMember(session, command.memberKey);
      case 'team.message': {
        const recipient = this.member(session, command.memberKey);
        if (
          actor.kind === 'agent' &&
          !leader &&
          recipient.key !== this.teamFor(sessionId).definition.leaderKey
        ) {
          throw new Error('Bound non-leaders may send findings only to the leader');
        }
        const binding = this.store
          .listBindings(sessionId)
          .find((item) => item.memberKey === recipient.key);
        if (binding?.state !== 'bound' || binding.nativeAgentId === null) {
          throw new Error(
            `Member ${recipient.key} is unavailable: ${binding?.blocker ?? binding?.state ?? 'not bound'}`,
          );
        }
        const sender =
          actor.kind === 'user' ? 'user' : `${identity!.memberKey} (${actor.nativeAgentId})`;
        try {
          await this.agents.send(binding.nativeAgentId, `From ${sender}: ${command.message}`);
        } catch (error) {
          throw new Error(
            `Native message delivery outcome is uncertain; it was not retried: ${String(error)}`,
          );
        }
        this.emit({ type: 'team.message', sessionId, memberKey: recipient.key });
        return { submitted: true, recipientAgentId: binding.nativeAgentId };
      }
    }
  }

  /** Serializes dispatch decisions while native members perform their work concurrently. */
  private schedule(session: Session): Promise<void> {
    const previous = this.scheduling.get(session.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        this.emit({ type: 'scheduler.start', sessionId: session.id });
        try {
          await this.advanceSession(session);
        } finally {
          this.emit({ type: 'scheduler.end', sessionId: session.id });
        }
      });
    this.scheduling.set(session.id, next);
    return next.finally(() => {
      if (this.scheduling.get(session.id) === next) this.scheduling.delete(session.id);
    });
  }

  private taskGates(sessionId: string, task: Task): string[] {
    const reasons: string[] = [];
    for (const dependencyId of task.dependencyIds ?? []) {
      const dependency = this.store.getTask(sessionId, dependencyId);
      if (dependency.status !== 'completed')
        reasons.push(`Dependency ${dependency.id} is ${dependency.status}`);
    }
    for (const scope of task.approvalScopes ?? []) {
      const approval = this.store
        .listApprovals(sessionId)
        .filter(
          (item) =>
            item.scope.action === scope.action &&
            item.scope.resourceId === scope.resourceId &&
            item.scope.revision === scope.revision,
        )
        .at(-1);
      if (approval?.decision !== 'approved')
        reasons.push(`Approval required: ${scope.action} ${scope.resourceId} ${scope.revision}`);
    }
    return reasons;
  }

  private async advanceSession(session: Session): Promise<void> {
    if (this.closed) return;
    for (const pass of this.store.listPasses(session.id)) {
      if (pass.status !== 'running' || !this.executionAllowed(session.id, pass.id)) continue;
      const tasks = this.store.listTasks(session.id).filter((task) => task.passId === pass.id);
      const barrier = tasks.find((task) => task.requestId?.endsWith(':execution-handoff'));
      if (!barrier || barrier.status !== 'completed') continue;
      for (const task of tasks.filter((item) => item.scheduled && item.phase !== 'review')) {
        if (['completed', 'failed', 'cancelled'].includes(task.status)) continue;
        const gates = this.taskGates(session.id, task);
        const assignment = this.store
          .listAssignments(session.id)
          .filter((item) => item.taskId === task.id && (item.attempt ?? 1) === (task.attempt ?? 1))
          .at(-1);
        const report =
          assignment &&
          this.store.listReports(session.id).find((item) => item.assignmentId === assignment.id);
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
        if (gates.length === 0 && !report)
          await this.dispatchScheduled(session, this.store.getTask(session.id, task.id));
      }
      const current = this.store.listTasks(session.id).filter((task) => task.passId === pass.id);
      const work = current.filter((task) => task.phase !== 'review');
      if (
        !current.some((task) => task.scheduled) ||
        !work.every(
          (task) => task.status === 'completed' && this.taskGates(session.id, task).length === 0,
        )
      )
        continue;
      let gate = current.find((task) => task.scheduled && task.phase === 'review');
      const policy = this.teamFor(session).definition.reviewPolicy;
      if (!gate && policy.required) {
        gate = this.store.createTask(session.id, {
          passId: pass.id,
          workType: 'task.execute',
          phase: 'review',
          requestId: `${pass.id}:review`,
          title: `Review Pass: ${pass.title}`,
          description:
            'Review the complete Pass. Fix in-scope findings before acceptance, or request changes. Record review.create with this assignmentId and the current Pass revision.',
          acceptance: 'Current-revision Pass-wide acceptance by the declared reviewer',
        });
      }
      if (gate) {
        if (this.taskGates(session.id, gate).length) continue;
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
      this.store.updatePass(session.id, { passId: pass.id, status: 'completed' });
    }
  }

  private async dispatchScheduled(session: Session, task: Task): Promise<void> {
    if (
      !task.passId ||
      !this.executionAllowed(session.id, task.passId) ||
      this.taskGates(session.id, task).length
    )
      return;
    const assignments = this.store.listAssignments(session.id);
    const previous = assignments
      .filter((item) => item.taskId === task.id && (item.attempt ?? 1) === (task.attempt ?? 1))
      .at(-1);
    if (previous && previous.status !== 'pending') return;
    const policy = this.teamFor(session).definition.reviewPolicy;
    const review = task.phase === 'review';
    const eligible = this.teamFor(session).definition.members.filter((member) => {
      if (!member.workTypes.includes('task.execute')) return false;
      if (!review) return true;
      if (policy.mode === 'self') return member.key === this.teamFor(session).definition.leaderKey;
      return (
        policy.reviewerKeys.includes(member.key) &&
        member.key !== this.teamFor(session).definition.leaderKey &&
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
        : ((await this.teamFor(session).selectAssignee?.(
            Object.freeze({
              workType: 'task.execute',
              sessionId: session.id,
              workspaceRoot: session.workspaceRoot,
            }),
            Object.freeze(eligible.map((member) => Object.freeze({ ...member }))),
          )) ?? this.teamFor(session).definition.routing['task.execute']);
      if (!selected) return;
      if (!eligible.some((member) => member.key === selected))
        throw new Error(
          `Selected member is not eligible for ${review ? 'Pass review' : 'task.execute'}`,
        );
      this.store.setTaskAssignee(session.id, task.id, selected);
    }
    // > A routing hook may yield while a new blocking decision is recorded.
    if (
      !this.executionAllowed(session.id, task.passId) ||
      this.taskGates(session.id, this.store.getTask(session.id, task.id)).length
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
    const binding = this.store.listBindings(session.id).find((item) => item.memberKey === selected);
    if (binding?.state !== 'bound' || !binding.nativeAgentId) return;
    const assignment =
      previous ??
      this.store.createAssignment(session.id, {
        taskId: task.id,
        memberKey: selected,
        nativeAgentId: binding.nativeAgentId,
        message: `${review ? 'Pass-wide review' : 'Scheduled Task'} ${task.id} in Pass ${task.passId}. ${task.description} Acceptance: ${task.acceptance}. Verification requirements: ${JSON.stringify(task.verificationRequirements)}. ${review ? 'Submit review.create with assignmentId and the current Pass revision.' : 'Submit report.create with outcome success or failure and named verification entries with evidence.'}`,
      });
    if (task.status !== 'running')
      this.store.updateTask(session.id, { taskId: task.id, status: 'running' });
    await this.deliverAssignment(assignment);
  }

  private requireLeader(actor: RuntimeActor, leader: boolean): void {
    if (actor.kind === 'agent' && !leader)
      throw new Error('Only the bound leader may schedule team work');
  }

  private member(session: Session, memberKey: string) {
    const member = this.teamFor(session).definition.members.find((item) => item.key === memberKey);
    if (member === undefined) throw new Error(`Undeclared team member: ${memberKey}`);
    return member;
  }

  private async reconcile(session: Session): Promise<void> {
    const native = await this.agents.list();
    for (const agent of native) this.nativeById.set(agent.id, agent);
    const bindings = this.store.listBindings(session.id);
    const bindingsByMember = new Map(bindings.map((binding) => [binding.memberKey, binding]));
    for (const binding of bindings) {
      if (
        binding.state === 'creating' ||
        binding.state === 'uncertain' ||
        binding.state === 'closed'
      )
        continue;
      if (binding.nativeAgentId === null) continue;
      const found = await this.agents.inspect(binding.nativeAgentId);
      if (found === null)
        this.store.putBinding({
          ...binding,
          state: 'missing',
          blocker: 'Previously bound native agent is absent; automatic replacement is disabled',
        });
      else {
        this.nativeById.set(found.id, found);
        this.store.putBinding({ ...binding, state: 'bound', blocker: undefined });
      }
    }
    for (const member of this.teamFor(session).definition.members) {
      if (bindingsByMember.has(member.key)) continue;
      if (member.lifetime === 'temporary') {
        const binding = this.store.putBinding({
          sessionId: session.id,
          teamId: session.teamId,
          memberKey: member.key,
          nativeAgentId: null,
          workspaceRoot: session.workspaceRoot,
          state: 'closed',
        });
        bindingsByMember.set(member.key, binding);
        continue;
      }
      const binding = await this.ensureMember(session, member.key);
      bindingsByMember.set(member.key, binding);
    }
    for (const assignment of this.store.listAssignments(session.id)) {
      if (assignment.status === 'sending')
        this.store.updateAssignment(session.id, assignment.id, 'uncertain');
      else if (
        assignment.status === 'pending' &&
        !this.store.getTask(session.id, assignment.taskId).scheduled
      )
        await this.deliverAssignment(assignment);
    }
  }

  private async ensureMember(session: Session, memberKey: string): Promise<NativeBinding> {
    const member = this.member(session, memberKey);
    const binding = this.store
      .listBindings(session.id)
      .find((item) => item.memberKey === member.key);
    if (binding?.state === 'bound' && binding.nativeAgentId !== null) return binding;
    if (binding !== undefined && !(member.lifetime === 'temporary' && binding.state === 'closed'))
      throw new Error(
        `Member ${member.key} cannot be safely recreated: ${binding.blocker ?? binding.state}`,
      );
    this.store.putBinding({
      sessionId: session.id,
      teamId: session.teamId,
      memberKey,
      nativeAgentId: null,
      workspaceRoot: session.workspaceRoot,
      state: 'creating',
    });
    try {
      const native = await this.agents.create({
        member,
        sessionId: session.id,
        teamInstanceId: session.teamInstanceId,
        teamId: session.teamId,
        workspaceRoot: session.workspaceRoot,
        leaderAgentId:
          this.store
            .listBindings(session.id)
            .find((binding) => binding.memberKey === this.teamFor(session).definition.leaderKey)
            ?.nativeAgentId ?? undefined,
        parentAgentId:
          this.store
            .listBindings(session.id)
            .find((binding) => binding.memberKey === this.teamFor(session).definition.leaderKey)
            ?.nativeAgentId ?? undefined,
      });
      this.nativeById.set(native.id, native);
      const created = this.store.putBinding({
        sessionId: session.id,
        teamId: session.teamId,
        memberKey,
        nativeAgentId: native.id,
        workspaceRoot: session.workspaceRoot,
        state: 'bound',
      });
      return created;
    } catch (error) {
      const uncertain = this.store.putBinding({
        sessionId: session.id,
        teamId: session.teamId,
        memberKey,
        nativeAgentId: null,
        workspaceRoot: session.workspaceRoot,
        state: 'uncertain',
        blocker: `Native create may have succeeded: ${String(error)}`,
      });
      return uncertain;
    }
  }
  private async closeTemporaryMember(session: Session, memberKey: string): Promise<NativeBinding> {
    const member = this.member(session, memberKey);
    if (member.lifetime !== 'temporary')
      throw new Error('Only explicitly temporary members may be closed');
    const binding = this.store
      .listBindings(session.id)
      .find((item) => item.memberKey === member.key);
    if (binding === undefined)
      throw new Error(`Temporary member ${member.key} has not been spawned`);
    if (binding.state === 'closed') return binding;
    if (binding.state !== 'bound' || binding.nativeAgentId === null) {
      throw new Error(
        `Temporary member ${member.key} cannot be safely closed: ${binding.blocker ?? binding.state}`,
      );
    }
    const active = this.store
      .listAssignments(session.id)
      .some(
        (assignment) => assignment.memberKey === member.key && assignment.status !== 'reported',
      );
    if (active) throw new Error(`Temporary member ${member.key} has unreported assignments`);
    try {
      await this.agents.close(binding.nativeAgentId);
      this.nativeById.delete(binding.nativeAgentId);
    } catch (error) {
      this.store.putBinding({
        ...binding,
        state: 'uncertain',
        blocker: `Native close outcome is unknown: ${String(error)}`,
      });
      throw new Error(
        `Temporary member ${member.key} close outcome is uncertain; it was not retried`,
      );
    }
    return this.store.putBinding({ ...binding, state: 'closed' });
  }

  private async deliverAssignment(assignment: Assignment): Promise<void> {
    this.emit({
      type: 'assignment.dispatch',
      sessionId: assignment.sessionId,
      taskId: assignment.taskId,
      assignmentId: assignment.id,
      memberKey: assignment.memberKey,
    });
    this.store.updateAssignment(assignment.sessionId, assignment.id, 'sending');
    try {
      await this.agents.send(
        assignment.nativeAgentId,
        `Assignment ID: ${assignment.id}. Task ID: ${assignment.taskId}. Attempt: ${assignment.attempt ?? 1}.\n${assignment.handoff}`,
      );
      if (this.store.getAssignment(assignment.sessionId, assignment.id).status === 'sending')
        this.store.updateAssignment(assignment.sessionId, assignment.id, 'sent');
      this.emit({
        type: 'assignment.sent',
        sessionId: assignment.sessionId,
        taskId: assignment.taskId,
        assignmentId: assignment.id,
        memberKey: assignment.memberKey,
      });
    } catch (error) {
      // > A native result proves delivery even when its transport acknowledgement arrives late.
      if (this.store.getAssignment(assignment.sessionId, assignment.id).status === 'reported')
        return;
      this.store.updateAssignment(assignment.sessionId, assignment.id, 'uncertain');
      this.store.updateTask(assignment.sessionId, {
        taskId: assignment.taskId,
        status: 'blocked',
        blocker: `Native handoff outcome is unknown: ${String(error)}`,
      });
    }
  }

  private async scheduleExecution(session: Session, record: PlanningRecord): Promise<void> {
    if (
      record.passId === undefined ||
      this.store.getPass(session.id, record.passId).status !== 'running' ||
      !this.executionAllowed(session.id, record.passId)
    )
      return;
    const requestId = `${record.id}:execution-handoff`;
    const task =
      this.store.listTasks(session.id).find((item) => item.requestId === requestId) ??
      this.store.createTask(session.id, {
        passId: record.passId,
        title: `Schedule approved Plan: ${record.title}`,
        workType: 'task.execute',
        scheduled: false,
        requestId,
        description: `The user approved Plan ${record.id} at ${record.plan.path} for Pass ${record.passId}. Leader now schedules execution Tasks among the declared eligible members. Preserve the approved scope and recorded decisions. Append detailed execution reports, Emerging Issues and User decisions post approval to this same Plan; record lasting design decisions in ${record.design.path}. Submit a report for this scheduling assignment and mark this scheduling Task complete after registering the execution Tasks, dependencies, assignees and gates. The runtime dispatches them after this handoff is complete.`,
        acceptance:
          'Main receives the approved Plan/Pass, schedules execution Tasks, and reports the scheduling handoff.',
      });
    if (this.store.listAssignments(session.id).some((assignment) => assignment.taskId === task.id))
      return;
    const leader = this.store
      .listBindings(session.id)
      .find(
        (binding) =>
          binding.memberKey === this.teamFor(session).definition.leaderKey &&
          binding.state === 'bound' &&
          binding.nativeAgentId !== null,
      );
    if (!leader?.nativeAgentId) {
      this.store.updateTask(session.id, {
        taskId: task.id,
        status: 'blocked',
        blocker: 'Plan consent is recorded; leader scheduling awaits a reconciled bound Leader',
      });
      return;
    }
    const assignment = this.store.createAssignment(session.id, {
      taskId: task.id,
      memberKey: leader.memberKey,
      nativeAgentId: leader.nativeAgentId,
      message: `Approved Plan execution handoff. Scheduling Task ${task.id}. ${task.description}`,
    });
    await this.deliverAssignment(assignment);
  }

  private async dispatchPlanning(
    session: Session,
    record: PlanningRecord,
    stage: 'prefill' | 'finalize',
  ): Promise<Assignment> {
    const workType: WorkType = stage === 'prefill' ? 'plan.prefill' : 'plan.finalize';
    const eligible = this.teamFor(session).definition.members.filter((member) =>
      member.workTypes.includes(workType),
    );
    const context = {
      workType,
      sessionId: session.id,
      workspaceRoot: session.workspaceRoot,
    };
    const selected =
      (await this.teamFor(session).selectAssignee?.(
        Object.freeze(context),
        Object.freeze(eligible.map((member) => Object.freeze({ ...member }))),
      )) ?? this.teamFor(session).definition.routing[workType];
    if (!eligible.some((member) => member.key === selected))
      throw new Error(`Assignee hook selected ineligible member ${selected} for ${workType}`);
    const binding = await this.ensureMember(session, selected);
    if (binding.state !== 'bound' || binding.nativeAgentId === null)
      throw new Error(`Planning member ${selected} is unavailable`);
    const requestId = `${record.id}:${stage}`;
    let summaryTimer: ReturnType<typeof setTimeout> | undefined;
    let riedSummary: unknown;
    try {
      riedSummary = await Promise.race([
        this.ried(session.id, { operation: 'summary' }).catch(() => ({
          status: 'partial',
          diagnostics: ['RIED unavailable'],
        })),
        new Promise((resolve) => {
          summaryTimer = setTimeout(
            () =>
              resolve({
                status: 'partial',
                diagnostics: ['RIED discovery is pending; call ltcook_ried for the inventory'],
              }),
            250,
          );
        }),
      ]);
    } finally {
      clearTimeout(summaryTimer);
    }
    const task =
      this.store.listTasks(session.id).find((task) => task.requestId === requestId) ??
      this.store.createTask(session.id, {
        title: `${workType}: ${record.title}`,
        description: `Read Design ${record.design.path}; ${stage === 'prefill' ? 'write the proposed Plan' : 'investigate gaps and finalize the same Plan'} at ${record.plan.path}. Consult the required planning skill and preserve Modes requirements. Include document metadata createdAt ${record.plan.createdAt} and timezone ${record.plan.timezone}. Register user questions through decision.create. Submit planning.submit for this assignment. RIED summary: ${JSON.stringify(riedSummary)}. Use ltcook_ried for sections or refresh`,
        acceptance:
          'Team-authored Plan with all six coverage topics; required user decisions are persisted',
        workType: 'design',
        requestId,
      });
    const existing = this.store
      .listAssignments(session.id)
      .find((assignment) => assignment.taskId === task.id);
    if (existing) return existing;
    const assignment = this.store.createAssignment(session.id, {
      taskId: task.id,
      memberKey: selected,
      nativeAgentId: binding.nativeAgentId,
      message: `Planning ${workType}. Plan ID: ${record.id}. ${task.description}`,
    });
    record.taskId = task.id;
    record.assignmentId = assignment.id;
    this.store.putRecord(session.id, 'planning', record);
    await this.deliverAssignment(assignment);
    return this.store.getAssignment(session.id, assignment.id);
  }
  authorizeTool(
    sessionId: string,
    nativeAgentId: string,
    toolName: string,
    input: Record<string, unknown>,
  ) {
    this.assertOpen();
    this.session(sessionId);
    if (!this.initializedSessions.has(sessionId))
      return { allowed: false, reason: 'Session native bindings have not been reconciled' };
    const member = this.snapshot(sessionId).members.find(
      (item) => item.binding?.nativeAgentId === nativeAgentId && item.binding.state === 'bound',
    )?.member;
    if (this.evaluationSessionId === sessionId && member) {
      if (this.evaluationToolCalls >= this.evaluationToolBudget)
        return { allowed: false, reason: 'Evaluation tool budget exceeded' };
      this.evaluationToolCalls++;
    }
    if (
      member?.readOnly &&
      ![
        'read',
        'grep',
        'find',
        'ls',
        'web_search',
        'fetch_content',
        'get_search_content',
        'code_search',
        'code_fetch',
        'ltcook_team',
        'ltcook_ried',
        'web_enable',
      ].includes(toolName)
    )
      return { allowed: false, reason: 'Member is read-only' };
    if (
      (member?.key === this.teamFor(sessionId).definition.leaderKey ||
        (member &&
          this.teamFor(sessionId).definition.reviewPolicy.reviewerKeys.includes(member.key))) &&
      this.store
        .listPasses(sessionId)
        .some((pass) => pass.status === 'running' && this.executionAllowed(sessionId, pass.id))
    ) {
      // > Leader may execute directly while it schedules the active Pass.
      if (
        !this.planning
          .decisions(sessionId)
          .some(
            (decision) =>
              decision.blocking &&
              decision.answer === undefined &&
              this.planning.get(sessionId, decision.planId).stage === 'approved',
          )
      )
        return { allowed: true, reason: 'Leader of an active approved Pass' };
    }
    return this.planning.authorize(sessionId, nativeAgentId, toolName, input);
  }
  bindDecisionPresentation(input: DecisionPresentation): void {
    this.assertOpen();
    this.session(input.sessionId);
    if (!this.initializedSessions.has(input.sessionId))
      throw new Error('Session native bindings have not been reconciled');
    this.planning.bind(input);
  }
  async resolveDecisionPresentation(input: {
    sessionId: string;
    nativeAgentId: string;
    requestId: string;
    answer?: string;
    cancelled?: boolean;
  }): Promise<void> {
    this.assertOpen();
    if (!this.initializedSessions.has(input.sessionId))
      throw new Error('Session native bindings have not been reconciled');
    await this.planning.resolve(this.session(input.sessionId), input);
    await this.schedule(this.session(input.sessionId));
  }
  private session(sessionId: string): Session {
    const cached = this.sessions.get(sessionId);
    if (cached !== undefined) return cached;
    // > Metadata recovery is read-only; native work still requires explicit reconciliation.
    const persisted = this.store.getSession(sessionId);
    this.teams.resolve(persisted.teamId);
    this.sessions.set(sessionId, persisted);
    return persisted;
  }
  private teamFor(session: Session | string): TeamPackage {
    return this.teams.resolve(
      typeof session === 'string' ? this.session(session).teamId : session.teamId,
    );
  }
  teamCatalog() {
    return this.teams.catalog();
  }
  listSessions(workspaceRoot: string, teamSelection?: string): Session[] {
    const root = canonicalWorkspace(workspaceRoot);
    const teamId = teamSelection ? this.teams.resolve(teamSelection).definition.id : undefined;
    return this.store
      .listSessions()
      .filter(
        (session) => session.workspaceRoot === root && (!teamId || session.teamId === teamId),
      );
  }
  private emit(event: RuntimeEvent): void {
    this.onEvent(event);
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('Runtime is closed');
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.evaluationPass = undefined;
    this.store.close();
    this.closed = true;
  }
}

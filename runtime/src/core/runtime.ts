import path from 'node:path';
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
  ProjectSnapshot,
} from '../workflow-api/index.js';
import { CoordinationStore } from '../storage/coordination.js';
import { canonicalWorkspace } from './workspace.js';

type RuntimeOptions = {
  databasePath: string;
  team: TeamPackage;
  agents: AgentBackend;
  stateDirectory?: string;
  projectContext?: (workspaceRoot: string) => Promise<ProjectSnapshot>;
  onEvent?: (event: RuntimeEvent) => void;
};

/** Creates an exclusive runtime over one fixed team and native-agent backend. */
export function createRuntime(options: RuntimeOptions): RuntimeController {
  return new RuntimeController(options);
}

export class RuntimeController implements RuntimeControllerContract {
  private readonly store: CoordinationStore;
  private readonly team: TeamPackage;
  private readonly agents: AgentBackend;
  private readonly onEvent: (event: RuntimeEvent) => void;
  private readonly sessions = new Map<string, Session>();
  private readonly nativeById = new Map<string, NativeAgent>();
  private closed = false;
  private readonly planning: PlanningWorkflow;
  private readonly initializedSessions = new Set<string>();
  private readonly initializingSessions = new Map<string, Promise<void>>();
  constructor(options: RuntimeOptions) {
    if (options.team.apiVersion !== 2)
      throw new Error(`Unsupported team API version ${String(options.team.apiVersion)}`);
    this.team = options.team;
    this.agents = options.agents;
    this.onEvent = options.onEvent ?? (() => undefined);
    for (const type of ['design', 'plan.prefill', 'plan.finalize', 'task.execute'] as const) {
      const key = this.team.definition.routing[type];
      if (
        !this.team.definition.members.some(
          (member) => member.key === key && member.workTypes.includes(type),
        )
      )
        throw new Error(`Invalid routing for ${type}`);
    }
    this.store = new CoordinationStore(options.databasePath);
    this.planning = new PlanningWorkflow(this.store, {
      stateDirectory:
        options.stateDirectory ??
        process.env.LTCOOK_RUNTIME_STATE_DIR ??
        path.join(path.dirname(options.databasePath), 'runtime'),
      ...(options.projectContext ? { projectContext: options.projectContext } : {}),
      dispatch: (session, record, stage) => this.dispatchPlanning(session, record, stage),
      scheduleExecution: (session, record) => this.scheduleExecution(session, record),
    });
  }

  async openSession(input: { id?: string; workspaceRoot: string }): Promise<SessionSnapshot> {
    this.assertOpen();
    const session =
      input.id === undefined
        ? this.store.createSession({
            teamId: this.team.definition.id,
            workspaceRoot: input.workspaceRoot,
          })
        : this.loadOrCreateSession(input.id, input.workspaceRoot);
    this.assertSessionSelection(session, input.workspaceRoot);
    if (this.initializedSessions.has(session.id)) return this.snapshot(session.id);
    await this.initializeSession(session);
    return this.snapshot(session.id);
  }

  private assertSessionSelection(session: Session, workspaceRoot: string): void {
    if (
      session.teamId !== this.team.definition.id ||
      session.workspaceRoot !== canonicalWorkspace(workspaceRoot)
    ) {
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
    })();
    this.initializingSessions.set(session.id, initialization);
    try {
      await initialization;
    } finally {
      this.initializingSessions.delete(session.id);
    }
  }

  private loadOrCreateSession(id: string, workspaceRoot: string): Session {
    const existing = this.store.listSessions().find((session) => session.id === id);
    return (
      existing ?? this.store.createSession({ id, teamId: this.team.definition.id, workspaceRoot })
    );
  }

  snapshot(sessionId: string): SessionSnapshot {
    this.assertOpen();
    const session = this.session(sessionId);
    const bindings = this.store.listBindings(sessionId);
    const members: MemberSnapshot[] = this.team.definition.members.map((member) => {
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
      if (task.requestId?.endsWith(':execution-handoff') && task.status === 'blocked')
        blockers.push(`Scheduling Task ${task.id}: ${task.blocker ?? 'blocked'}`);
    }
    for (const assignment of assignments) {
      if (assignment.status === 'uncertain')
        blockers.push(`Assignment ${assignment.id} may have been delivered; it was not resent`);
    }
    return {
      session,
      definition: this.team.definition,
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
    this.assertOpen();
    const session = this.session(sessionId);
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
    const coordinator = identity?.memberKey === this.team.definition.coordinatorKey;
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
        !this.planning.approvedPass(sessionId, passId)
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
        this.requireCoordinator(actor, coordinator);
        return this.store.createPass(sessionId, command);
      case 'pass.update': {
        this.requireCoordinator(actor, coordinator);
        if (command.status === 'running' && !this.planning.approvedPass(sessionId, command.passId))
          throw new Error('Pass execution requires its registered Plan approval');
        if (command.status === 'completed' && this.team.definition.reviewPolicy.required) {
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
      case 'task.create':
        this.requireCoordinator(actor, coordinator);
        return this.store.createTask(sessionId, command);
      case 'task.update': {
        const task = this.store.getTask(sessionId, command.taskId);
        if (actor.kind === 'agent' && !coordinator) {
          const ownsTask = this.store
            .listAssignments(sessionId)
            .some(
              (assignment) =>
                assignment.taskId === task.id && assignment.nativeAgentId === actor.nativeAgentId,
            );
          if (!ownsTask || !['running', 'blocked', 'failed'].includes(command.status))
            throw new Error(
              'Agents may update only the status of tasks assigned to their bound native identity',
            );
        }
        return this.store.updateTask(sessionId, command);
      }
      case 'step.create':
        this.requireCoordinator(actor, coordinator);
        return this.store.createStep(sessionId, command);
      case 'assignment.create': {
        this.requireCoordinator(actor, coordinator);
        const task = this.store.getTask(sessionId, command.taskId);
        const workType = task.workType === 'design' ? 'design' : 'task.execute';
        const eligible = this.team.definition.members.filter((member) =>
          member.workTypes.includes(workType),
        );
        const selected =
          command.memberKey ??
          (await this.team.selectAssignee?.(
            Object.freeze({
              workType,
              sessionId,
              workspaceRoot: session.workspaceRoot,
            }),
            Object.freeze(eligible.map((member) => Object.freeze({ ...member }))),
          )) ??
          this.team.definition.routing[workType];
        if (!eligible.some((member) => member.key === selected))
          throw new Error(`Selected member is not eligible for ${workType}`);
        const member = this.member(selected);
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
        const requestId = this.store.getTask(sessionId, assignment.taskId).requestId;
        if (
          this.planning
            .list(sessionId)
            .some((record) =>
              [`${record.id}:prefill`, `${record.id}:finalize`].includes(requestId ?? ''),
            )
        )
          throw new Error('Planning stages require planning.submit with validated document output');
        return this.store.createReport(sessionId, {
          ...command,
          nativeAgentId: actor.nativeAgentId,
        });
      }
      case 'step.update': {
        const step = this.store.getStep(sessionId, command.stepId);
        const task = this.store.getTask(sessionId, step.taskId);
        if (
          actor.kind === 'agent' &&
          !coordinator &&
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
        const reviewPolicy = this.team.definition.reviewPolicy;
        const selfReview =
          reviewPolicy.mode === 'self' &&
          identity.memberKey === this.team.definition.coordinatorKey;
        if (reviewPolicy.mode === 'self' && !selfReview)
          throw new Error('This team permits coordinator self-inspection only');
        if (
          reviewPolicy.mode === 'independent' &&
          (!reviewPolicy.reviewerKeys.includes(identity.memberKey) ||
            identity.memberKey === this.team.definition.coordinatorKey)
        )
          throw new Error('This member is not an independent reviewer');
        if (reviewPolicy.mode === 'independent') {
          const assignments = this.store.listAssignments(sessionId);
          const assignedToPass = this.store
            .listTasks(sessionId)
            .filter((task) => task.passId === command.passId)
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
        this.requireCoordinator(actor, coordinator);
        if (this.member(command.memberKey).lifetime !== 'temporary')
          throw new Error('Only explicitly temporary members may be spawned on demand');
        return this.ensureMember(session, command.memberKey);
      case 'team.close':
        this.requireCoordinator(actor, coordinator);
        return this.closeTemporaryMember(session, command.memberKey);
      case 'team.message': {
        const recipient = this.member(command.memberKey);
        if (
          actor.kind === 'agent' &&
          !coordinator &&
          recipient.key !== this.team.definition.coordinatorKey
        ) {
          throw new Error('Bound non-coordinators may send findings only to the coordinator');
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

  private requireCoordinator(actor: RuntimeActor, coordinator: boolean): void {
    if (actor.kind === 'agent' && !coordinator)
      throw new Error('Only the bound coordinator may schedule team work');
  }

  private member(memberKey: string) {
    const member = this.team.definition.members.find((item) => item.key === memberKey);
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
    for (const member of this.team.definition.members) {
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
      if (assignment.status === 'pending') await this.deliverAssignment(assignment);
      else if (assignment.status === 'sending')
        this.store.updateAssignment(session.id, assignment.id, 'uncertain');
    }
  }

  private async ensureMember(session: Session, memberKey: string): Promise<NativeBinding> {
    const member = this.member(memberKey);
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
    const member = this.member(memberKey);
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
    this.store.updateAssignment(assignment.sessionId, assignment.id, 'sending');
    try {
      await this.agents.send(assignment.nativeAgentId, assignment.handoff);
      this.store.updateAssignment(assignment.sessionId, assignment.id, 'sent');
      this.emit({
        type: 'assignment.sent',
        sessionId: assignment.sessionId,
        taskId: assignment.taskId,
        assignmentId: assignment.id,
        memberKey: assignment.memberKey,
      });
    } catch (error) {
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
      !this.planning.approvedPass(session.id, record.passId)
    )
      return;
    const requestId = `${record.id}:execution-handoff`;
    const task =
      this.store.listTasks(session.id).find((item) => item.requestId === requestId) ??
      this.store.createTask(session.id, {
        passId: record.passId,
        title: `Schedule approved Plan: ${record.title}`,
        workType: 'task.execute',
        requestId,
        description: `The user approved Plan ${record.id} at ${record.plan.path} for Pass ${record.passId}. Main now schedules execution Tasks among the declared eligible members. Preserve the approved scope and recorded decisions. Append detailed execution reports, Emerging Issues and User decisions post approval to this same Plan; record lasting design decisions in ${record.design.path}. Submit a report for this scheduling assignment and mark this scheduling Task complete after assigning the execution work.`,
        acceptance:
          'Main receives the approved Plan/Pass, schedules execution Tasks, and reports the scheduling handoff.',
      });
    if (this.store.listAssignments(session.id).some((assignment) => assignment.taskId === task.id))
      return;
    const coordinator = this.store
      .listBindings(session.id)
      .find(
        (binding) =>
          binding.memberKey === this.team.definition.coordinatorKey &&
          binding.state === 'bound' &&
          binding.nativeAgentId !== null,
      );
    if (!coordinator?.nativeAgentId) {
      this.store.updateTask(session.id, {
        taskId: task.id,
        status: 'blocked',
        blocker: 'Plan consent is recorded; coordinator scheduling awaits a reconciled bound Main',
      });
      return;
    }
    const assignment = this.store.createAssignment(session.id, {
      taskId: task.id,
      memberKey: coordinator.memberKey,
      nativeAgentId: coordinator.nativeAgentId,
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
    const eligible = this.team.definition.members.filter((member) =>
      member.workTypes.includes(workType),
    );
    const context = {
      workType,
      sessionId: session.id,
      workspaceRoot: session.workspaceRoot,
      ...(record.projectContext ? { projectContext: record.projectContext } : {}),
    };
    const selected =
      (await this.team.selectAssignee?.(
        Object.freeze(context),
        Object.freeze(eligible.map((member) => Object.freeze({ ...member }))),
      )) ?? this.team.definition.routing[workType];
    if (!eligible.some((member) => member.key === selected))
      throw new Error(`Assignee hook selected ineligible member ${selected} for ${workType}`);
    const binding = await this.ensureMember(session, selected);
    if (binding.state !== 'bound' || binding.nativeAgentId === null)
      throw new Error(`Planning member ${selected} is unavailable`);
    const requestId = `${record.id}:${stage}`;
    const task =
      this.store.listTasks(session.id).find((task) => task.requestId === requestId) ??
      this.store.createTask(session.id, {
        title: `${workType}: ${record.title}`,
        description: `Read Design ${record.design.path}; ${stage === 'prefill' ? 'write the proposed Plan' : 'investigate gaps and finalize the same Plan'} at ${record.plan.path}. Consult the required planning skill and preserve Modes requirements. Include document metadata createdAt ${record.plan.createdAt} and timezone ${record.plan.timezone}. Register user questions through decision.create. Submit planning.submit for this assignment. Project context: ${JSON.stringify(record.projectContext ?? { incomplete: ['Project context provider unavailable'] })}`,
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
        'web_enable',
      ].includes(toolName)
    )
      return { allowed: false, reason: 'Member is read-only' };
    if (
      (member?.key === this.team.definition.coordinatorKey ||
        (member && this.team.definition.reviewPolicy.reviewerKeys.includes(member.key))) &&
      this.store
        .listPasses(sessionId)
        .some((pass) => pass.status === 'running' && this.planning.approvedPass(sessionId, pass.id))
    ) {
      // > Main may execute directly while it schedules the active Pass.
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
        return { allowed: true, reason: 'Coordinator of an active approved Pass' };
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
  }
  private session(sessionId: string): Session {
    const cached = this.sessions.get(sessionId);
    if (cached !== undefined) return cached;
    // > Metadata recovery is read-only; native work still requires explicit reconciliation.
    const persisted = this.store.getSession(sessionId);
    if (persisted.teamId !== this.team.definition.id)
      throw new Error('Persisted Session belongs to a different selected Team');
    this.sessions.set(sessionId, persisted);
    return persisted;
  }
  private emit(event: RuntimeEvent): void {
    this.onEvent(event);
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('Runtime is closed');
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.store.close();
    this.closed = true;
  }
}

import type {
  AgentBackend, Assignment, MemberSnapshot, NativeAgent, NativeBinding, RuntimeActor,
  RuntimeCommand, RuntimeController as RuntimeControllerContract, RuntimeEvent, Session,
  SessionSnapshot, TeamPackage, TeamServiceRuntime, WorkflowPolicy,
} from '../api/team.js';
import { CoordinationStore } from '../storage/coordination.js';

type RuntimeOptions = {
  databasePath: string;
  team: TeamPackage;
  agents: AgentBackend;
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
  private readonly workflows = new Map<string, WorkflowPolicy>();
  private closed = false;
  private readonly initializedSessions = new Set<string>();
  private readonly initializingSessions = new Map<string, Promise<void>>();
  private startupInitialization: Promise<void> | null = null;

  constructor(options: RuntimeOptions) {
    if (options.team.apiVersion !== 1) throw new Error(`Unsupported team API version ${String(options.team.apiVersion)}`);
    this.team = options.team;
    this.agents = options.agents;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.store = new CoordinationStore(options.databasePath);
  }

  async openSession(input: { id?: string; workspaceRoot: string }): Promise<SessionSnapshot> {
    this.assertOpen();
    const session = input.id === undefined
      ? this.store.createSession({ teamId: this.team.definition.id, workspaceRoot: input.workspaceRoot })
      : this.loadOrCreateSession(input.id, input.workspaceRoot);
    this.assertSessionSelection(session, input.workspaceRoot);
    if (this.initializedSessions.has(session.id)) return this.snapshot(session.id);
    await this.initializeStartupSessions();
    await this.initializeSession(session);
    return this.snapshot(session.id);
  }

  private assertSessionSelection(session: Session, workspaceRoot: string): void {
    if (session.teamId !== this.team.definition.id || session.workspaceRoot !== workspaceRoot) {
      throw new Error('A persisted session has a different selected team or workspace');
    }
  }

  private initializeStartupSessions(): Promise<void> {
    if (this.startupInitialization === null) {
      this.startupInitialization = this.rehydrateSessions();
    }
    return this.startupInitialization;
  }

  private async rehydrateSessions(): Promise<void> {
    for (const session of this.store.listSessions()) {
      if (session.teamId === this.team.definition.id) await this.initializeSession(session);
    }
  }

  private async initializeSession(session: Session): Promise<void> {
    if (this.initializedSessions.has(session.id)) return;
    const pending = this.initializingSessions.get(session.id);
    if (pending !== undefined) return pending;
    this.sessions.set(session.id, session);
    const initialization = (async () => {
      await this.reconcile(session);
      await this.team.activateService(this.serviceRuntime(session));
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
    return existing ?? this.store.createSession({ id, teamId: this.team.definition.id, workspaceRoot });
  }

  snapshot(sessionId: string): SessionSnapshot {
    this.assertOpen();
    const session = this.session(sessionId);
    const bindings = this.store.listBindings(sessionId);
    const members: MemberSnapshot[] = this.team.definition.members.map((member) => {
      const binding = bindings.find((item) => item.memberKey === member.key) ?? null;
      return { member, binding, nativeStatus: binding?.state === 'bound' && binding.nativeAgentId ? this.nativeById.get(binding.nativeAgentId)?.status ?? null : null };
    });
    const assignments = this.store.listAssignments(sessionId);
    const blockers = bindings.filter((binding) => binding.state === 'missing' || binding.state === 'uncertain' || binding.state === 'creating').map((binding) => `${binding.memberKey}: ${binding.blocker ?? binding.state}`);
    for (const assignment of assignments) {
      if (assignment.status === 'uncertain') blockers.push(`Assignment ${assignment.id} may have been delivered; it was not resent`);
    }
    return {
      session, definition: this.team.definition, members,
      passes: this.store.listPasses(sessionId), tasks: this.store.listTasks(sessionId),
      assignments, reports: this.store.listReports(sessionId),
      reviews: this.store.listReviews(sessionId), approvals: this.store.listApprovals(sessionId), blockers,
    };
  }

  async execute(sessionId: string, actor: RuntimeActor, command: RuntimeCommand): Promise<unknown> {
    this.assertOpen();
    const session = this.session(sessionId);
    const identity = actor.kind === 'agent'
      ? this.store.listBindings(sessionId).find((binding) => binding.nativeAgentId === actor.nativeAgentId && binding.state === 'bound')
      : undefined;
    if (actor.kind === 'agent' && identity === undefined) throw new Error('Agent identity is not bound to this session');
    const coordinator = identity?.memberKey === this.team.definition.coordinatorKey;
    switch (command.type) {
      case 'task.create':
        this.requireCoordinator(actor, coordinator);
        return this.store.createTask(sessionId, command);
      case 'task.update': {
        const task = this.store.getTask(sessionId, command.taskId);
        if (actor.kind === 'agent' && !coordinator) {
          const ownsTask = this.store.listAssignments(sessionId).some((assignment) => assignment.taskId === task.id && assignment.nativeAgentId === actor.nativeAgentId);
          if (!ownsTask || !['running', 'blocked', 'failed'].includes(command.status)) {
            throw new Error('Agents may update only the status of tasks assigned to their bound native identity');
          }
        }
        if (command.status === 'completed' && this.workflow(sessionId).review.required) {
          const latestReport = this.store.listReports(sessionId).filter((report) => report.taskId === task.id).at(-1);
          const latestReview = latestReport === undefined ? undefined : this.store.listReviews(sessionId).filter((review) => review.reportId === latestReport.id).at(-1);
          if (latestReview?.outcome !== 'accepted') throw new Error('Latest task report does not have an accepted review');
        }
        return this.store.updateTask(sessionId, command);
      }
      case 'assignment.create': {
        this.requireCoordinator(actor, coordinator);
        const member = this.member(command.memberKey);
        const workflow = this.workflow(sessionId);
        const binding = member.lifetime === 'temporary'
          ? this.store.listBindings(sessionId).find((item) => item.memberKey === member.key)
          : await this.ensureMember(session, member.key);
        if (binding === undefined || binding.state !== 'bound' || binding.nativeAgentId === null) throw new Error(`Member ${member.key} is unavailable: ${binding?.blocker ?? binding?.state ?? 'temporary member has not been explicitly spawned'}`);
        if (this.store.listAssignments(sessionId).some((item) => item.taskId === command.taskId && item.memberKey === member.key)) {
          throw new Error('This task already has an assignment to that member; the handoff will not be replayed');
        }
        const assignment = this.store.createAssignment(sessionId, { ...command, nativeAgentId: binding.nativeAgentId });
        await this.deliverAssignment(assignment);
        return this.store.getAssignment(sessionId, assignment.id);
      }
      case 'report.create': {
        const assignment = this.store.getAssignment(sessionId, command.assignmentId);
        if (actor.kind !== 'agent' || assignment.nativeAgentId !== actor.nativeAgentId) throw new Error('Only the assigned native agent may report this task');
        return this.store.createReport(sessionId, { ...command, nativeAgentId: actor.nativeAgentId });
      }
      case 'review.create': {
        if (actor.kind !== 'agent' || identity === undefined) throw new Error('Review requires a bound agent');
        const report = this.store.listReports(sessionId).find((item) => item.id === command.reportId);
        if (report === undefined) throw new Error('Report not found');
        const assignment = this.store.getAssignment(sessionId, report.assignmentId);
        const selfReview = identity.memberKey === assignment.memberKey && identity.memberKey === this.team.definition.coordinatorKey;
        if (this.workflow(sessionId).review.mode === 'self' && !selfReview) throw new Error('This team permits coordinator self-inspection only');
        if (this.workflow(sessionId).review.mode === 'independent' && (!this.workflow(sessionId).review.reviewerKeys.includes(identity.memberKey) || identity.memberKey === assignment.memberKey)) {
          throw new Error('This member is not an independent reviewer for the assigned work');
        }
        return this.store.createReview(sessionId, { ...command, nativeAgentId: actor.nativeAgentId, kind: selfReview ? 'self' : 'independent' });
      }
      case 'approval.create':
        if (actor.kind !== 'user') throw new Error('Only the trusted user route can create approvals');
        return this.store.createApproval(sessionId, command);
      case 'team.spawn':
        this.requireCoordinator(actor, coordinator);
        if (this.member(command.memberKey).lifetime !== 'temporary') throw new Error('Only explicitly temporary members may be spawned on demand');
        return this.ensureMember(session, command.memberKey);
      case 'team.close':
        this.requireCoordinator(actor, coordinator);
        return this.closeTemporaryMember(session, command.memberKey);
      case 'team.message': {
        const recipient = this.member(command.memberKey);
        if (actor.kind === 'agent' && !coordinator && recipient.key !== this.team.definition.coordinatorKey) {
          throw new Error('Bound non-coordinators may send findings only to the coordinator');
        }
        const binding = this.store.listBindings(sessionId).find((item) => item.memberKey === recipient.key);
        if (binding?.state !== 'bound' || binding.nativeAgentId === null) {
          throw new Error(`Member ${recipient.key} is unavailable: ${binding?.blocker ?? binding?.state ?? 'not bound'}`);
        }
        const sender = actor.kind === 'user' ? 'user' : `${identity!.memberKey} (${actor.nativeAgentId})`;
        try {
          await this.agents.send(binding.nativeAgentId, `From ${sender}: ${command.message}`);
        } catch (error) {
          throw new Error(`Native message delivery outcome is uncertain; it was not retried: ${String(error)}`);
        }
        this.emit({ type: 'team.message', sessionId, memberKey: recipient.key });
        return { submitted: true, recipientAgentId: binding.nativeAgentId };
      }
    }
  }

  private requireCoordinator(actor: RuntimeActor, coordinator: boolean): void {
    if (actor.kind === 'agent' && !coordinator) throw new Error('Only the bound coordinator may schedule team work');
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
      if (binding.state === 'creating' || binding.state === 'uncertain' || binding.state === 'closed') continue;
      if (binding.nativeAgentId === null) continue;
      const found = await this.agents.inspect(binding.nativeAgentId);
      if (found === null) this.store.putBinding({ ...binding, state: 'missing', blocker: 'Previously bound native agent is absent; automatic replacement is disabled' });
      else {
        this.nativeById.set(found.id, found);
        this.store.putBinding({ ...binding, state: 'bound', blocker: undefined });
      }
    }
    for (const member of this.team.definition.members) {
      if (bindingsByMember.has(member.key)) continue;
      if (member.lifetime === 'temporary') {
        const binding = this.store.putBinding({ sessionId: session.id, teamId: session.teamId, memberKey: member.key, nativeAgentId: null, workspaceRoot: session.workspaceRoot, state: 'closed' });
        bindingsByMember.set(member.key, binding);
        continue;
      }
      // Persist intent before the external create; an interrupted create is never blindly repeated.
      const creating = this.store.putBinding({ sessionId: session.id, teamId: session.teamId, memberKey: member.key, nativeAgentId: null, workspaceRoot: session.workspaceRoot, state: 'creating', blocker: 'Native create outcome is unknown; explicit reconciliation is required' });
      bindingsByMember.set(member.key, creating);
      try {
        const created = await this.agents.create({ member, sessionId: session.id, teamId: session.teamId, workspaceRoot: session.workspaceRoot });
        this.nativeById.set(created.id, created);
        const bound = this.store.putBinding({ sessionId: session.id, teamId: session.teamId, memberKey: member.key, nativeAgentId: created.id, workspaceRoot: session.workspaceRoot, state: 'bound' });
        bindingsByMember.set(member.key, bound);
      } catch (error) {
        const uncertain = this.store.putBinding({ sessionId: session.id, teamId: session.teamId, memberKey: member.key, nativeAgentId: null, workspaceRoot: session.workspaceRoot, state: 'uncertain', blocker: `Native create may have succeeded: ${String(error)}` });
        bindingsByMember.set(member.key, uncertain);
      }
    }
    for (const assignment of this.store.listAssignments(session.id)) {
      if (assignment.status === 'pending') await this.deliverAssignment(assignment);
      else if (assignment.status === 'sending') this.store.updateAssignment(session.id, assignment.id, 'uncertain');
    }
  }

  private async ensureMember(session: Session, memberKey: string): Promise<NativeBinding> {
    const member = this.member(memberKey);
    const binding = this.store.listBindings(session.id).find((item) => item.memberKey === member.key);
    if (binding?.state === 'bound' && binding.nativeAgentId !== null) return binding;
    if (binding !== undefined && !(member.lifetime === 'temporary' && binding.state === 'closed')) throw new Error(`Member ${member.key} cannot be safely recreated: ${binding.blocker ?? binding.state}`);
    this.store.putBinding({ sessionId: session.id, teamId: session.teamId, memberKey, nativeAgentId: null, workspaceRoot: session.workspaceRoot, state: 'creating' });
    try {
      const native = await this.agents.create({ member, sessionId: session.id, teamId: session.teamId, workspaceRoot: session.workspaceRoot });
      this.nativeById.set(native.id, native);
      const created = this.store.putBinding({ sessionId: session.id, teamId: session.teamId, memberKey, nativeAgentId: native.id, workspaceRoot: session.workspaceRoot, state: 'bound' });
      return created;
    } catch (error) {
      const uncertain = this.store.putBinding({ sessionId: session.id, teamId: session.teamId, memberKey, nativeAgentId: null, workspaceRoot: session.workspaceRoot, state: 'uncertain', blocker: `Native create may have succeeded: ${String(error)}` });
      return uncertain;
    }
  }
  private async closeTemporaryMember(session: Session, memberKey: string): Promise<NativeBinding> {
    const member = this.member(memberKey);
    if (member.lifetime !== 'temporary') throw new Error('Only explicitly temporary members may be closed');
    const binding = this.store.listBindings(session.id).find((item) => item.memberKey === member.key);
    if (binding === undefined) throw new Error(`Temporary member ${member.key} has not been spawned`);
    if (binding.state === 'closed') return binding;
    if (binding.state !== 'bound' || binding.nativeAgentId === null) {
      throw new Error(`Temporary member ${member.key} cannot be safely closed: ${binding.blocker ?? binding.state}`);
    }
    const active = this.store.listAssignments(session.id).some((assignment) => assignment.memberKey === member.key && assignment.status !== 'reported');
    if (active) throw new Error(`Temporary member ${member.key} has unreported assignments`);
    try {
      await this.agents.close(binding.nativeAgentId);
      this.nativeById.delete(binding.nativeAgentId);
    } catch (error) {
      this.store.putBinding({ ...binding, state: 'uncertain', blocker: `Native close outcome is unknown: ${String(error)}` });
      throw new Error(`Temporary member ${member.key} close outcome is uncertain; it was not retried`);
    }
    return this.store.putBinding({ ...binding, state: 'closed' });
  }

  private async deliverAssignment(assignment: Assignment): Promise<void> {
    this.store.updateAssignment(assignment.sessionId, assignment.id, 'sending');
    try {
      await this.agents.send(assignment.nativeAgentId, assignment.handoff);
      this.store.updateAssignment(assignment.sessionId, assignment.id, 'sent');
      this.emit({ type: 'assignment.sent', sessionId: assignment.sessionId, taskId: assignment.taskId, assignmentId: assignment.id, memberKey: assignment.memberKey });
    } catch (error) {
      this.store.updateAssignment(assignment.sessionId, assignment.id, 'uncertain');
      this.store.updateTask(assignment.sessionId, { taskId: assignment.taskId, status: 'blocked', blocker: `Native handoff outcome is unknown: ${String(error)}` });
    }
  }

  private serviceRuntime(session: Session): TeamServiceRuntime {
    const operations = this.operations(session.id);
    return {
      definition: this.team.definition, session, coordination: operations,
      agents: {
        ensure: (key) => {
          const member = this.member(key);
          if (member.lifetime === 'temporary') throw new Error('Temporary members require an explicit team.spawn command');
          return this.ensureMember(session, key);
        },
        list: () => this.snapshot(session.id).members,
        close: async (key) => { await this.closeTemporaryMember(session, key); },
      },
      messaging: { send: async (key, message) => { await this.execute(session.id, { kind: 'user' }, { type: 'team.message', memberKey: key, message }); } },
      workflows: { register: (policy) => this.registerWorkflow(session, policy) },
    };
  }
  private registerWorkflow(session: Session, policy: WorkflowPolicy): void {
    const keys = new Set(this.team.definition.members.map((member) => member.key));
    if (policy.coordinatorKey !== this.team.definition.coordinatorKey || policy.delegateKeys.some((key) => !keys.has(key) || key === policy.coordinatorKey)) {
      throw new Error('Team workflow references an undeclared member or coordinator');
    }
    if (policy.review.mode !== this.team.definition.reviewPolicy.mode
      || policy.review.required !== this.team.definition.reviewPolicy.required
      || policy.review.reviewerKeys.length !== this.team.definition.reviewPolicy.reviewerKeys.length
      || policy.review.reviewerKeys.some((key) => !this.team.definition.reviewPolicy.reviewerKeys.includes(key))) {
      throw new Error('Team workflow review policy differs from its selected definition');
    }
    this.workflows.set(session.id, policy);
  }
  private workflow(sessionId: string): WorkflowPolicy {
    const workflow = this.workflows.get(sessionId);
    if (workflow === undefined) throw new Error('Selected team workflow has not been registered');
    return workflow;
  }

  private operations(sessionId: string, actor: RuntimeActor = { kind: 'user' }) {
    return { snapshot: async () => this.snapshot(sessionId), execute: (command: RuntimeCommand) => this.execute(sessionId, actor, command) };
  }
  private session(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`Session is not open in this runtime: ${sessionId}`);
    return session;
  }
  private emit(event: RuntimeEvent): void { this.onEvent(event); }
  private assertOpen(): void { if (this.closed) throw new Error('Runtime is closed'); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.store.close(); this.closed = true;
  }
}

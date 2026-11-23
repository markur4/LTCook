export {
  RuntimeCommandSchema,
  RuntimeCommandInputSchema,
  AgentRuntimeCommandSchema,
  AgentRuntimeCommandInputSchema,
  isRuntimeCommand,
} from './commands.js';
import type { TeamDefinition, TeamMember } from '../team-api/index.js';
export type { TeamDefinition, TeamMember, TeamPackage, ModelAlias } from '../team-api/index.js';
/** Public, versioned contract shared by native hosts and interchangeable teams. */
export type {
  WorkStatus,
  TaskPhase,
  RuntimeCommand,
  CreatePassInput,
  UpdatePassInput,
  CreateTaskInput,
  UpdateTaskInput,
  RetryTaskInput,
  CreateStepInput,
  UpdateStepInput,
  CreateAssignmentInput,
  CreateReportInput,
  CreateReviewInput,
  CreateApprovalInput,
} from './commands.js';
import type {
  WorkStatus,
  TaskPhase,
  RuntimeCommand,
  CreatePassInput,
  UpdatePassInput,
  CreateTaskInput,
  UpdateTaskInput,
  RetryTaskInput,
  CreateStepInput,
  UpdateStepInput,
  CreateAssignmentInput,
  CreateReportInput,
  CreateReviewInput,
  CreateApprovalInput,
} from './commands.js';
export interface TeamInstance {
  id: string;
  teamId: string;
  workspaceRoot: string;
  createdAt: string;
}
export interface Session {
  id: string;
  teamId: string;
  teamInstanceId: string;
  workspaceRoot: string;
  createdAt: string;
}
export interface Pass {
  id: string;
  sessionId: string;
  title: string;
  status: WorkStatus;
  revision: number;
  planRef?: string;
  createdAt: string;
}
export interface Task {
  workType: 'design' | 'task.investigate' | 'task.execute';
  id: string;
  sessionId: string;
  passId?: string;
  title: string;
  description: string;
  acceptance: string;
  status: WorkStatus;
  revision: number;
  phase?: TaskPhase;
  requestId?: string;
  blocker?: string;
  report?: string;
  scheduled?: boolean;
  attempt?: number;
  assigneeKey?: string;
  dependencyIds?: string[];
  verificationRequirements?: string[];
  approvalScopes?: ApprovalScope[];
  correctionOfTaskId?: string;
}
export interface Step {
  id: string;
  sessionId: string;
  taskId: string;
  title: string;
  position: number;
  status: WorkStatus;
}
export interface Assignment {
  id: string;
  sessionId: string;
  taskId: string;
  memberKey: string;
  nativeAgentId: string;
  status: 'pending' | 'sending' | 'sent' | 'uncertain' | 'reported';
  handoff: string;
  attempt?: number;
  requestId?: string;
}
export interface Report {
  id: string;
  sessionId: string;
  taskId: string;
  assignmentId: string;
  nativeAgentId: string;
  summary: string;
  evidence: string;
  outcome?: 'success' | 'failure';
  verification?: VerificationEntry[];
  revision: number;
}
export interface VerificationEntry {
  requirement: string;
  result: 'passed' | 'failed';
  evidence: string;
}
export interface Review {
  id: string;
  sessionId: string;
  passId: string;
  nativeAgentId: string;
  kind: 'independent' | 'self';
  assignmentId?: string;
  verification?: VerificationEntry[];
  outcome: 'accepted' | 'changes-requested';
  summary: string;
  revision: number;
}
export interface ApprovalScope {
  action: string;
  resourceId: string;
  revision: string;
}
export interface Approval {
  id: string;
  sessionId: string;
  scope: ApprovalScope;
  decision: 'approved' | 'rejected';
  source: 'user';
  createdAt: string;
}
export interface NativeBinding {
  sessionId: string;
  teamId: string;
  memberKey: string;
  nativeAgentId: string | null;
  workspaceRoot: string;
  state: 'creating' | 'bound' | 'missing' | 'uncertain' | 'closed';
  blocker?: string;
}
export interface NativeAgent {
  id: string;
  status: string;
}
export interface CreateAgentOptions {
  parentAgentId?: string;
  leaderAgentId?: string;
  member: TeamMember;
  sessionId: string;
  teamInstanceId: string;
  teamId: string;
  workspaceRoot: string;
}
export interface AgentBackend {
  list(): Promise<NativeAgent[]>;
  create(options: CreateAgentOptions): Promise<NativeAgent>;
  inspect(id: string): Promise<NativeAgent | null>;
  send(id: string, message: string): Promise<void>;
  close(id: string): Promise<void>;
}
export interface MemberSnapshot {
  member: TeamMember;
  binding: NativeBinding | null;
  nativeStatus: string | null;
}
export interface SessionSnapshot {
  documentsDirectory: string;
  session: Session;
  definition: TeamDefinition;
  members: MemberSnapshot[];
  passes: Pass[];
  tasks: Task[];
  steps: Step[];
  assignments: Assignment[];
  reports: Report[];
  reviews: Review[];
  approvals: Approval[];
  blockers: string[];
  planning: PlanningRecord[];
  decisions: Decision[];
}
export type RuntimeActor = { kind: 'user' } | { kind: 'agent'; nativeAgentId: string };
export interface RuntimeEvent {
  type: string;
  sessionId: string;
  taskId?: string;
  assignmentId?: string;
  memberKey?: string;
}
export interface RuntimeController {
  openSession(options: {
    id?: string;
    workspaceRoot: string;
    teamSelection?: string;
    leaderAgentId?: string;
  }): Promise<SessionSnapshot>;
  teamCatalog(): import('../integrations/team-loader.js').TeamCatalogEntry[];
  listSessions(workspaceRoot: string, teamSelection?: string): Session[];
  snapshot(sessionId: string): SessionSnapshot;
  ried(
    sessionId: string,
    request: import('../repository/requests.js').RiedRequest,
  ): Promise<unknown>;
  execute(sessionId: string, actor: RuntimeActor, command: RuntimeCommand): Promise<unknown>;
  authorizeTool(
    sessionId: string,
    nativeAgentId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): ToolAuthorization;
  bindDecisionPresentation(input: DecisionPresentation): void;
  resolveDecisionPresentation(input: {
    sessionId: string;
    nativeAgentId: string;
    requestId: string;
    answer?: string;
    cancelled?: boolean;
  }): Promise<void>;
  close(): Promise<void>;
}
/** Storage operations are synchronous and owned by the single runtime, never agent processes. */
export interface CoordinationApi {
  createSession(input: { id?: string; teamId: string; workspaceRoot: string }): Session;
  getSession(sessionId: string): Session;
  listSessions(): Session[];
  createPass(sessionId: string, input: CreatePassInput): Pass;
  updatePass(sessionId: string, input: UpdatePassInput): Pass;
  getPass(sessionId: string, passId: string): Pass;
  listPasses(sessionId: string): Pass[];
  createTask(sessionId: string, input: CreateTaskInput): Task;
  getTask(sessionId: string, taskId: string): Task;
  listTasks(sessionId: string): Task[];
  updateTask(sessionId: string, input: UpdateTaskInput): Task;
  retryTask(sessionId: string, input: RetryTaskInput): Task;
  setTaskAssignee(sessionId: string, taskId: string, memberKey: string): Task;
  createStep(sessionId: string, input: CreateStepInput): Step;
  getStep(sessionId: string, stepId: string): Step;
  listSteps(sessionId: string): Step[];
  updateStep(sessionId: string, input: UpdateStepInput): Step;
  createAssignment(
    sessionId: string,
    input: CreateAssignmentInput & { nativeAgentId: string; memberKey: string },
  ): Assignment;
  getAssignment(sessionId: string, assignmentId: string): Assignment;
  listAssignments(sessionId: string): Assignment[];
  updateAssignment(
    sessionId: string,
    assignmentId: string,
    status: Assignment['status'],
  ): Assignment;
  createReport(sessionId: string, input: CreateReportInput & { nativeAgentId: string }): Report;
  listReports(sessionId: string): Report[];
  createReview(
    sessionId: string,
    input: CreateReviewInput & { nativeAgentId: string; kind: Review['kind'] },
  ): Review;
  listReviews(sessionId: string): Review[];
  createApproval(sessionId: string, input: CreateApprovalInput): Approval;
  listApprovals(sessionId: string): Approval[];
  putBinding(binding: NativeBinding): NativeBinding;
  listBindings(sessionId: string): NativeBinding[];
}

export type PlanCoverage = NonNullable<
  Extract<RuntimeCommand, { type: 'planning.submit' }>['coverage']
>[number];
export type PlanTopic = PlanCoverage['topic'];
export interface DocumentReference {
  id: string;
  kind: 'design' | 'plan';
  path: string;
  createdAt: string;
  timezone: string;
}
export interface PlanningRecord {
  id: string;
  sessionId: string;
  design: DocumentReference;
  plan: DocumentReference;
  title: string;
  stage: 'prefill' | 'finalize' | 'awaiting-approval' | 'approved' | 'rejected';
  taskId?: string;
  assignmentId?: string;
  passId?: string;
  coverage: PlanCoverage[];
}
export interface Decision {
  id: string;
  sessionId: string;
  planId: string;
  category: 'intent' | 'breaking-changes' | 'verification' | 'other';
  prompt: string;
  blocking: boolean;
  answer?: string;
  answeredAt?: string;
}
export interface DecisionPresentation {
  sessionId: string;
  planId: string;
  decisionId: string;
  nativeAgentId: string;
  requestId: string;
  kind?: 'question' | 'approval';
}
export interface ToolAuthorization {
  allowed: boolean;
  reason: string;
}

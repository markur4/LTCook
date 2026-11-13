/** Public, versioned contract shared by native hosts and interchangeable teams. */
export type {
  WorkStatus,
  TaskPhase,
  RuntimeCommand,
  CreatePassInput,
  UpdatePassInput,
  CreateTaskInput,
  UpdateTaskInput,
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
  CreateStepInput,
  UpdateStepInput,
  CreateAssignmentInput,
  CreateReportInput,
  CreateReviewInput,
  CreateApprovalInput,
} from './commands.js';
export type ModelAlias = 'smart' | 'smol' | 'plan';
export interface InstructionResource {
  path: string;
  url: string;
}
export interface TeamMember {
  key: string;
  name: string;
  lifetime: 'persistent' | 'temporary';
  modelAlias: ModelAlias;
  thinking: string;
  readOnly: boolean;
  instructionPaths: readonly string[];
}
export interface ReviewPolicy {
  mode: 'independent' | 'self';
  reviewerKeys: readonly string[];
  required: boolean;
}
export interface TeamDefinition {
  id: string;
  name: string;
  coordinatorKey: string;
  members: readonly TeamMember[];
  resources: readonly InstructionResource[];
  reviewPolicy: ReviewPolicy;
}
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
}
export interface Report {
  id: string;
  sessionId: string;
  taskId: string;
  assignmentId: string;
  nativeAgentId: string;
  summary: string;
  evidence: string;
  revision: number;
}
export interface Review {
  id: string;
  sessionId: string;
  passId: string;
  nativeAgentId: string;
  kind: 'independent' | 'self';
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
  openSession(options: { id?: string; workspaceRoot: string }): Promise<SessionSnapshot>;
  snapshot(sessionId: string): SessionSnapshot;
  execute(sessionId: string, actor: RuntimeActor, command: RuntimeCommand): Promise<unknown>;
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
  createStep(sessionId: string, input: CreateStepInput): Step;
  getStep(sessionId: string, stepId: string): Step;
  listSteps(sessionId: string): Step[];
  updateStep(sessionId: string, input: UpdateStepInput): Step;
  createAssignment(
    sessionId: string,
    input: CreateAssignmentInput & { nativeAgentId: string },
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
export interface SessionOperations {
  snapshot(): Promise<SessionSnapshot>;
  execute(command: RuntimeCommand): Promise<unknown>;
}
export interface NativeAgentOperations {
  ensure(memberKey: string): Promise<NativeBinding>;
  list(): readonly MemberSnapshot[];
  close(memberKey: string): Promise<void>;
}
export interface TeamServiceRuntime {
  definition: TeamDefinition;
  session: Session;
  coordination: SessionOperations;
  agents: NativeAgentOperations;
  messaging: { send(memberKey: string, message: string): Promise<void> };
}
export interface TeamAgentRuntime {
  definition: TeamDefinition;
  identity: {
    sessionId: string;
    teamInstanceId: string;
    teamId: string;
    memberKey: string;
    nativeAgentId: string;
  };
  coordination: SessionOperations;
  instructions: { register(resources: readonly InstructionResource[]): void };
}
export interface TeamPackage {
  apiVersion: 1;
  definition: TeamDefinition;
  activateService(runtime: TeamServiceRuntime): void | Promise<void>;
  activateAgent(runtime: TeamAgentRuntime): void | Promise<void>;
}

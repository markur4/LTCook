import { randomUUID } from 'node:crypto';
import Database from 'libsql';
import process from 'node:process';
import type {
  Approval,
  PlanningRecord,
  Assignment,
  CoordinationApi,
  CreateApprovalInput,
  CreateAssignmentInput,
  CreatePassInput,
  CreateReportInput,
  CreateReviewInput,
  CreateStepInput,
  CreateTaskInput,
  NativeBinding,
  Pass,
  Report,
  Review,
  Session,
  Step,
  Task,
  UpdatePassInput,
  UpdateStepInput,
  UpdateTaskInput,
  RetryTaskInput,
  VerificationEntry,
} from '../workflow-api/index.js';
import { canonicalWorkspace } from '../core/workspace.js';

type TaskRow = Omit<Task, 'passId' | 'blocker' | 'report' | 'phase' | 'requestId'> & {
  passId: string | null;
  blocker: string | null;
  report: string | null;
  phase: Task['phase'] | null;
  requestId: string | null;
  metadata: string;
};
type BindingRow = Omit<NativeBinding, 'blocker'> & { blocker: string | null };
type PassRow = Omit<Pass, 'planRef'> & { planRef: string | null };
const SCHEMA_VERSION = 3;

/** Owns the coordination database exclusively until close(). */
export class CoordinationStore implements CoordinationApi {
  private readonly database: Database.Database;
  private readonly ownerToken = randomUUID();
  private closed = false;

  constructor(databasePath: string) {
    this.database = new Database(databasePath);
    const version = (this.database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    const tables = this.database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const expectedTables = [
      'team_instances',
      'sessions',
      'passes',
      'tasks',
      'assignments',
      'reports',
      'reviews',
      'steps',
      'approvals',
      'bindings',
      'workflow_records',
      'owner',
    ];
    if (
      version === SCHEMA_VERSION &&
      expectedTables.some((name) => !tables.some((table) => table.name === name))
    ) {
      this.database.close();
      throw new Error('Incompatible coordination database schema: missing required tables');
    }
    if (version !== SCHEMA_VERSION && (version !== 0 || tables.length > 0)) {
      this.database.close();
      throw new Error(
        `Incompatible coordination database schema ${version}; use a new empty store`,
      );
    }
    this.database.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON');
    if (version === 0)
      this.database.exec(`BEGIN IMMEDIATE;
        CREATE TABLE team_instances (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, workspace_root TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(team_id, workspace_root));
        CREATE TABLE sessions (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, workspace_root TEXT NOT NULL, created_at TEXT NOT NULL, team_instance_id TEXT REFERENCES team_instances(id));
        CREATE TABLE passes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), title TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', revision INTEGER NOT NULL DEFAULT 1, plan_ref TEXT);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), pass_id TEXT REFERENCES passes(id), title TEXT NOT NULL, description TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, blocker TEXT, report TEXT, phase TEXT, request_id TEXT, work_type TEXT NOT NULL, metadata TEXT NOT NULL);
        CREATE TABLE assignments (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id), member_key TEXT NOT NULL, native_agent_id TEXT NOT NULL, status TEXT NOT NULL, handoff TEXT NOT NULL, attempt INTEGER NOT NULL, request_id TEXT);
        CREATE TABLE reports (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id), assignment_id TEXT NOT NULL REFERENCES assignments(id), native_agent_id TEXT NOT NULL, summary TEXT NOT NULL, evidence TEXT NOT NULL, revision INTEGER NOT NULL, outcome TEXT, verification TEXT);
        CREATE TABLE reviews (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), pass_id TEXT NOT NULL REFERENCES passes(id), native_agent_id TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL, summary TEXT NOT NULL, revision INTEGER NOT NULL, assignment_id TEXT);
        CREATE TABLE steps (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id), title TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL, UNIQUE(task_id, position));
        CREATE TABLE approvals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), action TEXT NOT NULL, resource_id TEXT NOT NULL, revision TEXT NOT NULL, decision TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE bindings (session_id TEXT NOT NULL REFERENCES sessions(id), team_id TEXT NOT NULL, member_key TEXT NOT NULL, native_agent_id TEXT, workspace_root TEXT NOT NULL, state TEXT NOT NULL, blocker TEXT, PRIMARY KEY(session_id, member_key));
      CREATE TABLE owner (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), pid INTEGER NOT NULL, token TEXT NOT NULL);
      CREATE TABLE workflow_records (session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(session_id,kind,id));
      CREATE UNIQUE INDEX task_request ON tasks(session_id,request_id) WHERE request_id IS NOT NULL;
      CREATE INDEX steps_task_order ON steps(task_id,position);
      PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
    this.acquireOwner();
  }
  approvePlan(record: PlanningRecord): PlanningRecord {
    return this.transaction(() => {
      const pass = this.createPass(record.sessionId, { title: record.title, planRef: record.id });
      this.createApproval(record.sessionId, {
        scope: { action: 'plan.execute', resourceId: record.id, revision: 'registered-plan' },
        decision: 'approved',
      });
      this.updatePass(record.sessionId, { passId: pass.id, status: 'running' });
      return this.putRecord(record.sessionId, 'planning', {
        ...record,
        passId: pass.id,
        stage: 'approved',
      });
    });
  }
  records<T>(sessionId: string, kind: string): T[] {
    return this.rows<{ value: string }>(
      'SELECT value FROM workflow_records WHERE session_id=? AND kind=? ORDER BY rowid',
      sessionId,
      kind,
    ).map((row) => JSON.parse(row.value) as T);
  }
  putRecord<T extends { id: string }>(sessionId: string, kind: string, record: T): T {
    this.getSession(sessionId);
    this.database
      .prepare(
        'INSERT INTO workflow_records VALUES (?,?,?,?) ON CONFLICT(session_id,kind,id) DO UPDATE SET value=excluded.value',
      )
      .run(sessionId, kind, record.id, JSON.stringify(record));
    return record;
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('Coordination store is closed');
  }
  private acquireOwner(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(
        'CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), pid INTEGER NOT NULL, token TEXT NOT NULL)',
      );
      const owner = this.database
        .prepare('SELECT pid, token FROM owner WHERE singleton = 1')
        .get() as { pid: number; token: string } | undefined;
      if (owner !== undefined) {
        let dead = false;
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') dead = true;
          else
            throw new Error(
              `Coordination database owner PID ${owner.pid} is live or cannot be proven dead`,
            );
        }
        if (!dead) throw new Error(`Coordination database is owned by live PID ${owner.pid}`);
        this.database
          .prepare('DELETE FROM owner WHERE singleton = 1 AND token = ?')
          .run(owner.token);
      }
      this.database
        .prepare('INSERT INTO owner (singleton, pid, token) VALUES (1, ?, ?)')
        .run(process.pid, this.ownerToken);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      this.database.close();
      throw error;
    }
  }
  private rows<T>(sql: string, ...params: (string | number | null)[]): T[] {
    this.assertOpen();
    return this.database.prepare(sql).all(...params) as T[];
  }
  private row<T>(sql: string, ...params: (string | number | null)[]): T {
    const value = this.database.prepare(sql).get(...params) as T | undefined;
    if (value === undefined) throw new Error('Coordination record not found');
    return value;
  }
  private transaction<T>(run: () => T): T {
    this.assertOpen();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  createSession(input: { id?: string; teamId: string; workspaceRoot: string }): Session {
    const workspaceRoot = canonicalWorkspace(input.workspaceRoot);
    const session: Session = {
      id: input.id ?? randomUUID(),
      teamId: input.teamId,
      workspaceRoot,
      teamInstanceId: '',
      createdAt: new Date().toISOString(),
    };
    return this.transaction(() => {
      let instance = this.database
        .prepare('SELECT id FROM team_instances WHERE team_id = ? AND workspace_root = ?')
        .get(session.teamId, workspaceRoot) as { id: string } | undefined;
      if (instance === undefined) {
        instance = { id: randomUUID() };
        this.database
          .prepare('INSERT INTO team_instances VALUES (?, ?, ?, ?)')
          .run(instance.id, session.teamId, workspaceRoot, session.createdAt);
      }
      session.teamInstanceId = instance.id;
      this.database
        .prepare(
          'INSERT INTO sessions (id,team_id,workspace_root,created_at,team_instance_id) VALUES (?,?,?,?,?)',
        )
        .run(session.id, session.teamId, workspaceRoot, session.createdAt, session.teamInstanceId);
      return session;
    });
  }
  getSession(sessionId: string): Session {
    return this.row<Session>(
      'SELECT id, team_id AS teamId, team_instance_id AS teamInstanceId, workspace_root AS workspaceRoot, created_at AS createdAt FROM sessions WHERE id = ?',
      sessionId,
    );
  }
  listSessions(): Session[] {
    return this.rows<Session>(
      'SELECT id, team_id AS teamId, team_instance_id AS teamInstanceId, workspace_root AS workspaceRoot, created_at AS createdAt FROM sessions ORDER BY created_at',
    );
  }
  createPass(sessionId: string, input: CreatePassInput): Pass {
    const pass: Pass = {
      id: randomUUID(),
      sessionId,
      title: input.title,
      createdAt: new Date().toISOString(),
      status: 'pending',
      revision: 1,
      ...(input.planRef === undefined ? {} : { planRef: input.planRef }),
    };
    this.database
      .prepare(
        'INSERT INTO passes (id,session_id,title,created_at,status,revision,plan_ref) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        pass.id,
        sessionId,
        pass.title,
        pass.createdAt,
        pass.status,
        pass.revision,
        pass.planRef ?? null,
      );
    return pass;
  }
  updatePass(sessionId: string, input: UpdatePassInput): Pass {
    const pass = this.getPass(sessionId, input.passId);
    if (pass.status === 'completed' && input.status !== 'completed')
      throw new Error('A completed Pass cannot be reopened');
    if (
      input.status === 'completed' &&
      this.listTasks(sessionId).some(
        (task) => task.passId === pass.id && task.status !== 'completed',
      )
    ) {
      throw new Error('All Pass tasks must be completed first');
    }
    this.database.prepare('UPDATE passes SET status = ? WHERE id = ?').run(input.status, pass.id);
    return this.getPass(sessionId, pass.id);
  }
  private passFromRow({ planRef, ...pass }: PassRow): Pass {
    return { ...pass, ...(planRef === null ? {} : { planRef }) };
  }
  getPass(sessionId: string, passId: string): Pass {
    return this.passFromRow(
      this.row<PassRow>(
        'SELECT id, session_id AS sessionId, title, status, revision, plan_ref AS planRef, created_at AS createdAt FROM passes WHERE session_id = ? AND id = ?',
        sessionId,
        passId,
      ),
    );
  }
  listPasses(sessionId: string): Pass[] {
    return this.rows<PassRow>(
      'SELECT id, session_id AS sessionId, title, status, revision, plan_ref AS planRef, created_at AS createdAt FROM passes WHERE session_id = ? ORDER BY created_at',
      sessionId,
    ).map((pass) => this.passFromRow(pass));
  }
  private bumpPassForTask(sessionId: string, passId: string | undefined): void {
    if (passId === undefined) return;
    const pass = this.getPass(sessionId, passId);
    if (pass.status === 'completed') throw new Error('Tasks in a completed Pass cannot be changed');
    this.database.prepare('UPDATE passes SET revision = revision + 1 WHERE id = ?').run(passId);
  }
  createTask(sessionId: string, input: CreateTaskInput): Task {
    return this.transaction(() => {
      const original = JSON.stringify(input);
      if (input.requestId !== undefined) {
        const duplicate = this.listTasks(sessionId).find(
          (task) => task.requestId === input.requestId,
        );
        if (duplicate) {
          const row = this.row<{ metadata: string }>(
            'SELECT metadata FROM tasks WHERE id=?',
            duplicate.id,
          );
          if (JSON.parse(row.metadata).original !== original)
            throw new Error('Conflicting duplicate Task request');
          return duplicate;
        }
      }
      if (input.passId !== undefined) {
        this.getPass(sessionId, input.passId);
        this.bumpPassForTask(sessionId, input.passId);
      }
      const task: Task = {
        id: randomUUID(),
        sessionId,
        ...(input.passId === undefined ? {} : { passId: input.passId }),
        workType: input.workType ?? 'task.execute',
        title: input.title,
        description: input.description,
        acceptance: input.acceptance,
        status: 'pending',
        revision: 1,
        ...(input.phase === undefined ? {} : { phase: input.phase }),
        ...(input.requestId === undefined
          ? input.passId
            ? { requestId: randomUUID() }
            : {}
          : { requestId: input.requestId }),
        scheduled:
          input.scheduled ??
          (input.passId !== undefined && (input.workType ?? 'task.execute') === 'task.execute'),
        ...(input.assigneeKey === undefined ? {} : { assigneeKey: input.assigneeKey }),
        attempt: 1,
        dependencyIds: input.dependencyIds ?? [],
        verificationRequirements: input.verificationRequirements ?? [],
        approvalScopes: input.approvalScopes ?? [],
        ...(input.correctionOfTaskId === undefined
          ? {}
          : { correctionOfTaskId: input.correctionOfTaskId }),
      };
      this.validateDependencies(sessionId, task, task.dependencyIds ?? []);
      if (task.correctionOfTaskId !== undefined) {
        const originalTask = this.getTask(sessionId, task.correctionOfTaskId);
        if (!task.passId || task.passId !== originalTask.passId)
          throw new Error('Correction must link to a Task in the same Pass');
      }
      this.database
        .prepare(
          'INSERT INTO tasks (id,session_id,pass_id,title,description,acceptance,status,revision,blocker,report,phase,request_id,work_type,metadata) VALUES (?,?,?,?,?,?,?, ?,NULL,NULL,?,?,?,?)',
        )
        .run(
          task.id,
          sessionId,
          task.passId ?? null,
          task.title,
          task.description,
          task.acceptance,
          task.status,
          task.revision,
          task.phase ?? null,
          task.requestId ?? null,
          task.workType,
          JSON.stringify({
            original,
            attempt: task.attempt,
            scheduled: task.scheduled,
            assigneeKey: task.assigneeKey,
            dependencyIds: task.dependencyIds,
            verificationRequirements: task.verificationRequirements,
            approvalScopes: task.approvalScopes,
            correctionOfTaskId: task.correctionOfTaskId,
          }),
        );
      return task;
    });
  }
  getTask(sessionId: string, taskId: string): Task {
    return this.taskFromRow(
      this.row<TaskRow>(
        'SELECT id, session_id AS sessionId, pass_id AS passId, title, description, acceptance, status, revision, blocker, report, phase, request_id AS requestId, work_type AS workType, metadata FROM tasks WHERE session_id = ? AND id = ?',
        sessionId,
        taskId,
      ),
    );
  }
  listTasks(sessionId: string): Task[] {
    return this.rows<TaskRow>(
      'SELECT id, session_id AS sessionId, pass_id AS passId, title, description, acceptance, status, revision, blocker, report, phase, request_id AS requestId, work_type AS workType, metadata FROM tasks WHERE session_id = ? ORDER BY rowid',
      sessionId,
    ).map((row) => this.taskFromRow(row));
  }
  private taskFromRow(row: TaskRow): Task {
    const { blocker, report, phase, requestId, passId, metadata, ...task } = row;
    const { original: _original, ...fields } = JSON.parse(metadata);
    return {
      ...task,
      ...fields,
      ...(passId === null ? {} : { passId }),
      ...(phase === null ? {} : { phase }),
      ...(requestId === null ? {} : { requestId }),
      ...(blocker === null ? {} : { blocker }),
      ...(report === null ? {} : { report }),
    };
  }
  private validateDependencies(sessionId: string, task: Task, ids: string[]): void {
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate dependency');
    for (const id of ids) {
      if (id === task.id) throw new Error('A Task cannot depend on itself');
      const dependency = this.getTask(sessionId, id);
      if (!task.passId || dependency.passId !== task.passId)
        throw new Error('Dependencies must belong to the same Pass');
      const visited = new Set<string>();
      const visit = (current: Task): void => {
        if (current.id === task.id) throw new Error('Cyclic Task dependency');
        if (visited.has(current.id)) return;
        visited.add(current.id);
        for (const parent of current.dependencyIds ?? []) visit(this.getTask(sessionId, parent));
      };
      visit(dependency);
    }
  }
  private updateTaskMetadata(
    sessionId: string,
    taskId: string,
    fields: Record<string, unknown>,
  ): void {
    const row = this.row<{ metadata: string }>(
      'SELECT metadata FROM tasks WHERE session_id=? AND id=?',
      sessionId,
      taskId,
    );
    this.database
      .prepare('UPDATE tasks SET metadata=? WHERE id=?')
      .run(JSON.stringify({ ...JSON.parse(row.metadata), ...fields }), taskId);
  }
  setTaskAssignee(sessionId: string, taskId: string, memberKey: string): Task {
    const task = this.getTask(sessionId, taskId);
    if (task.assigneeKey !== undefined && task.assigneeKey !== memberKey)
      throw new Error('Task assignee already selected');
    this.updateTaskMetadata(sessionId, taskId, { assigneeKey: memberKey });
    return this.getTask(sessionId, taskId);
  }
  retryTask(sessionId: string, input: RetryTaskInput): Task {
    return this.transaction(() => {
      const previous = this.records<{ id: string; input: string }>(sessionId, 'task-retry').find(
        (record) => record.id === input.requestId,
      );
      if (previous) {
        if (previous.input !== JSON.stringify(input)) throw new Error('Conflicting retry request');
        return this.getTask(sessionId, input.taskId);
      }
      const task = this.getTask(sessionId, input.taskId);
      if (!task.scheduled || task.status !== 'failed')
        throw new Error('Only a failed scheduled Task may be retried');
      if (input.correctionTaskId) {
        const correction = this.getTask(sessionId, input.correctionTaskId);
        if (correction.correctionOfTaskId !== task.id || correction.status !== 'completed')
          throw new Error('Retry correction must be linked and completed');
      }
      this.bumpPassForTask(sessionId, task.passId);
      this.updateTaskMetadata(sessionId, task.id, { attempt: (task.attempt ?? 1) + 1 });
      this.database
        .prepare(
          "UPDATE tasks SET status='pending', blocker=NULL, report=NULL, revision=revision+1 WHERE id=?",
        )
        .run(task.id);
      this.putRecord(sessionId, 'task-retry', {
        id: input.requestId,
        input: JSON.stringify(input),
      });
      return this.getTask(sessionId, task.id);
    });
  }
  updateTask(sessionId: string, input: UpdateTaskInput): Task {
    this.transaction(() => {
      const task = this.getTask(sessionId, input.taskId);
      if (input.dependencyIds !== undefined) {
        if (
          task.status !== 'pending' ||
          task.assigneeKey !== undefined ||
          this.listAssignments(sessionId).some((a) => a.taskId === task.id)
        )
          throw new Error('Dependencies may change only while pending and unassigned');
        this.validateDependencies(sessionId, task, input.dependencyIds);
        this.updateTaskMetadata(sessionId, task.id, { dependencyIds: input.dependencyIds });
      }
      const status = input.status ?? task.status;
      if (
        status === task.status &&
        input.blocker === task.blocker &&
        input.dependencyIds === undefined
      )
        return;
      this.bumpPassForTask(sessionId, task.passId);
      this.database
        .prepare('UPDATE tasks SET status = ?, revision = ?, blocker = ? WHERE id = ?')
        .run(status, task.revision + 1, input.blocker ?? null, task.id);
    });
    return this.getTask(sessionId, input.taskId);
  }
  createStep(sessionId: string, input: CreateStepInput): Step {
    return this.transaction(() => {
      const task = this.getTask(sessionId, input.taskId);
      this.bumpPassForTask(sessionId, task.passId);
      const position =
        input.position ??
        (this.rows<{ max: number | null }>(
          'SELECT MAX(position) AS max FROM steps WHERE task_id = ?',
          task.id,
        )[0]?.max ?? -1) + 1;
      const step: Step = {
        id: randomUUID(),
        sessionId,
        taskId: task.id,
        title: input.title,
        position,
        status: 'pending',
      };
      this.database
        .prepare('INSERT INTO steps VALUES (?,?,?,?,?,?)')
        .run(step.id, sessionId, task.id, step.title, step.position, step.status);
      return step;
    });
  }
  getStep(sessionId: string, stepId: string): Step {
    return this.row<Step>(
      'SELECT id, session_id AS sessionId, task_id AS taskId, title, position, status FROM steps WHERE session_id = ? AND id = ?',
      sessionId,
      stepId,
    );
  }
  listSteps(sessionId: string): Step[] {
    return this.rows<Step>(
      'SELECT id, session_id AS sessionId, task_id AS taskId, title, position, status FROM steps WHERE session_id = ? ORDER BY task_id, position, rowid',
      sessionId,
    );
  }
  updateStep(sessionId: string, input: UpdateStepInput): Step {
    return this.transaction(() => {
      const step = this.getStep(sessionId, input.stepId);
      const task = this.getTask(sessionId, step.taskId);
      this.bumpPassForTask(sessionId, task.passId);
      this.database.prepare('UPDATE steps SET status = ? WHERE id = ?').run(input.status, step.id);
      return this.getStep(sessionId, step.id);
    });
  }
  createAssignment(
    sessionId: string,
    input: CreateAssignmentInput & { nativeAgentId: string; memberKey: string },
  ): Assignment {
    return this.transaction(() => {
      const task = this.getTask(sessionId, input.taskId);
      if (task.scheduled) {
        const previous = this.listAssignments(sessionId).find(
          (assignment) =>
            assignment.taskId === task.id && assignment.attempt === (task.attempt ?? 1),
        );
        if (previous) {
          if (
            previous.memberKey !== input.memberKey ||
            previous.nativeAgentId !== input.nativeAgentId ||
            previous.handoff !== input.message
          )
            throw new Error('Conflicting assignment attempt');
          return previous;
        }
      }
      this.bumpPassForTask(sessionId, task.passId);
      const assignment: Assignment = {
        id: randomUUID(),
        sessionId,
        taskId: task.id,
        memberKey: input.memberKey,
        nativeAgentId: input.nativeAgentId,
        status: 'pending',
        handoff: input.message,
        attempt: task.scheduled
          ? (task.attempt ?? 1)
          : this.listAssignments(sessionId).filter((a) => a.taskId === task.id).length + 1,
        ...(task.scheduled ? { requestId: `${task.requestId}:${task.attempt ?? 1}` } : {}),
      };
      this.database
        .prepare('INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          assignment.id,
          sessionId,
          assignment.taskId,
          assignment.memberKey,
          assignment.nativeAgentId,
          assignment.status,
          assignment.handoff,
          assignment.attempt ?? 1,
          assignment.requestId ?? null,
        );
      return assignment;
    });
  }
  getAssignment(sessionId: string, assignmentId: string): Assignment {
    return this.row<Assignment>(
      'SELECT id, session_id AS sessionId, task_id AS taskId, member_key AS memberKey, native_agent_id AS nativeAgentId, status, handoff, attempt, request_id AS requestId FROM assignments WHERE session_id = ? AND id = ?',
      sessionId,
      assignmentId,
    );
  }
  listAssignments(sessionId: string): Assignment[] {
    return this.rows<Assignment>(
      'SELECT id, session_id AS sessionId, task_id AS taskId, member_key AS memberKey, native_agent_id AS nativeAgentId, status, handoff, attempt, request_id AS requestId FROM assignments WHERE session_id = ? ORDER BY rowid',
      sessionId,
    );
  }
  updateAssignment(
    sessionId: string,
    assignmentId: string,
    status: Assignment['status'],
  ): Assignment {
    this.getAssignment(sessionId, assignmentId);
    this.database
      .prepare('UPDATE assignments SET status = ? WHERE session_id = ? AND id = ?')
      .run(status, sessionId, assignmentId);
    return this.getAssignment(sessionId, assignmentId);
  }
  createReport(sessionId: string, input: CreateReportInput & { nativeAgentId: string }): Report {
    return this.transaction(() => {
      const assignment = this.getAssignment(sessionId, input.assignmentId);
      const previous = this.listReports(sessionId).find(
        (report) => report.assignmentId === assignment.id,
      );
      if (previous) {
        if (
          previous.nativeAgentId !== input.nativeAgentId ||
          previous.summary !== input.summary ||
          previous.evidence !== input.evidence ||
          previous.outcome !== input.outcome ||
          JSON.stringify(previous.verification ?? []) !== JSON.stringify(input.verification ?? [])
        )
          throw new Error('Conflicting duplicate result');
        return previous;
      }
      if (assignment.nativeAgentId !== input.nativeAgentId)
        throw new Error('Only the assigned agent may report');
      const task = this.getTask(sessionId, assignment.taskId);
      if (task.scheduled && input.outcome === undefined)
        throw new Error('Scheduled Task results require an outcome');
      const verification = input.verification ?? [];
      this.validateVerification(task, verification);
      const report: Report = {
        id: randomUUID(),
        sessionId,
        taskId: assignment.taskId,
        assignmentId: input.assignmentId,
        nativeAgentId: input.nativeAgentId,
        summary: input.summary,
        evidence: input.evidence,
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        ...(input.verification === undefined ? {} : { verification: input.verification }),
        revision: 1,
      };
      this.database
        .prepare('INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          report.id,
          sessionId,
          report.taskId,
          report.assignmentId,
          report.nativeAgentId,
          report.summary,
          report.evidence,
          report.revision,
          report.outcome ?? null,
          report.verification === undefined ? null : JSON.stringify(report.verification),
        );
      this.updateAssignment(sessionId, assignment.id, 'reported');
      this.bumpPassForTask(sessionId, task.passId);
      this.database
        .prepare('UPDATE tasks SET report = ?, revision = ? WHERE id = ?')
        .run(report.summary, task.revision + 1, task.id);
      if (
        task.scheduled &&
        (input.outcome === 'failure' || verification.some((entry) => entry.result !== 'passed'))
      ) {
        this.database.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(task.id);
      }
      return report;
    });
  }
  listReports(sessionId: string): Report[] {
    return this.rows<
      Omit<Report, 'outcome' | 'verification'> & {
        outcome: Report['outcome'] | null;
        verification: string | null;
      }
    >(
      'SELECT id, session_id AS sessionId, task_id AS taskId, assignment_id AS assignmentId, native_agent_id AS nativeAgentId, summary, evidence, revision, outcome, verification FROM reports WHERE session_id = ? ORDER BY rowid',
      sessionId,
    ).map(({ outcome, verification, ...report }) => ({
      ...report,
      ...(outcome === null ? {} : { outcome }),
      ...(verification === null ? {} : { verification: JSON.parse(verification) }),
    }));
  }
  createReview(
    sessionId: string,
    input: CreateReviewInput & { nativeAgentId: string; kind: Review['kind'] },
  ): Review {
    return this.transaction(() => {
      const previous =
        input.assignmentId === undefined
          ? undefined
          : this.listReviews(sessionId).find(
              (review) => review.assignmentId === input.assignmentId,
            );
      if (previous) {
        const request = this.records<{
          id: string;
          revision?: number;
          verification?: VerificationEntry[];
        }>(sessionId, 'review-request').find((item) => item.id === previous.id);
        if (
          previous.outcome !== input.outcome ||
          previous.summary !== input.summary ||
          previous.nativeAgentId !== input.nativeAgentId ||
          previous.passId !== input.passId ||
          request?.revision !== input.revision ||
          JSON.stringify(request?.verification ?? []) !== JSON.stringify(input.verification ?? [])
        )
          throw new Error('Conflicting duplicate review');
        return previous;
      }
      let pass = this.getPass(sessionId, input.passId);
      if (pass.status === 'completed') throw new Error('A completed Pass cannot be reviewed again');
      if (input.revision !== undefined && input.revision !== pass.revision)
        throw new Error('Review revision is stale');
      if (input.assignmentId !== undefined) {
        const assignment = this.getAssignment(sessionId, input.assignmentId);
        const task = this.getTask(sessionId, assignment.taskId);
        if (
          task.passId !== pass.id ||
          task.phase !== 'review' ||
          assignment.nativeAgentId !== input.nativeAgentId
        )
          throw new Error('Review must match the assigned Pass review gate');
        this.validateVerification(task, input.verification ?? [], input.outcome === 'accepted');
        this.bumpPassForTask(sessionId, task.passId);
        this.database
          .prepare('UPDATE tasks SET status=?, revision=revision+1, blocker=NULL WHERE id=?')
          .run(input.outcome === 'accepted' ? 'completed' : 'failed', task.id);
        this.updateAssignment(sessionId, assignment.id, 'reported');
        pass = this.getPass(sessionId, pass.id);
      }
      const review: Review = {
        id: randomUUID(),
        sessionId,
        passId: pass.id,
        nativeAgentId: input.nativeAgentId,
        kind: input.kind,
        outcome: input.outcome,
        summary: input.summary,
        revision: pass.revision,
        ...(input.assignmentId === undefined ? {} : { assignmentId: input.assignmentId }),
        ...(input.verification === undefined ? {} : { verification: input.verification }),
      };
      this.putRecord(sessionId, 'review-request', {
        id: review.id,
        revision: input.revision,
        verification: input.verification,
      });
      this.database
        .prepare('INSERT INTO reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          review.id,
          sessionId,
          review.passId,
          review.nativeAgentId,
          review.kind,
          review.outcome,
          review.summary,
          review.revision,
          review.assignmentId ?? null,
        );
      return review;
    });
  }
  listReviews(sessionId: string): Review[] {
    const requests = this.records<{ id: string; verification?: VerificationEntry[] }>(
      sessionId,
      'review-request',
    );
    return this.rows<Review>(
      'SELECT id, session_id AS sessionId, pass_id AS passId, native_agent_id AS nativeAgentId, kind, outcome, summary, revision, assignment_id AS assignmentId FROM reviews WHERE session_id = ? ORDER BY rowid',
      sessionId,
    ).map((review) => {
      const request = requests.find((item) => item.id === review.id);
      return {
        ...review,
        ...(request?.verification === undefined ? {} : { verification: request.verification }),
      };
    });
  }
  private validateVerification(
    task: Task,
    entries: VerificationEntry[],
    requirePassed = false,
  ): void {
    if (new Set(entries.map((entry) => entry.requirement)).size !== entries.length)
      throw new Error('Duplicate verification entries');
    for (const requirement of task.verificationRequirements ?? []) {
      const entry = entries.find((item) => item.requirement === requirement);
      if (!entry?.evidence.trim()) throw new Error(`Missing verification evidence: ${requirement}`);
      if (requirePassed && entry.result !== 'passed')
        throw new Error(`Verification did not pass: ${requirement}`);
    }
    if (requirePassed && entries.some((entry) => entry.result !== 'passed'))
      throw new Error('Review verification did not pass');
  }
  createApproval(sessionId: string, input: CreateApprovalInput): Approval {
    const approval: Approval = {
      id: randomUUID(),
      sessionId,
      scope: input.scope,
      decision: input.decision,
      source: 'user',
      createdAt: new Date().toISOString(),
    };
    this.database
      .prepare('INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        approval.id,
        sessionId,
        input.scope.action,
        input.scope.resourceId,
        input.scope.revision,
        input.decision,
        approval.source,
        approval.createdAt,
      );
    return approval;
  }
  listApprovals(sessionId: string): Approval[] {
    return this.rows<{
      id: string;
      sessionId: string;
      action: string;
      resourceId: string;
      revision: string;
      decision: Approval['decision'];
      source: 'user';
      createdAt: string;
    }>(
      'SELECT id, session_id AS sessionId, action, resource_id AS resourceId, revision, decision, source, created_at AS createdAt FROM approvals WHERE session_id = ? ORDER BY created_at',
      sessionId,
    ).map(
      ({
        id,
        sessionId: scopedSession,
        action,
        resourceId,
        revision,
        decision,
        source,
        createdAt,
      }) => ({
        id,
        sessionId: scopedSession,
        scope: { action, resourceId, revision },
        decision,
        source,
        createdAt,
      }),
    );
  }
  putBinding(binding: NativeBinding): NativeBinding {
    this.database
      .prepare(
        'INSERT INTO bindings VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, member_key) DO UPDATE SET team_id=excluded.team_id, native_agent_id=excluded.native_agent_id, workspace_root=excluded.workspace_root, state=excluded.state, blocker=excluded.blocker',
      )
      .run(
        binding.sessionId,
        binding.teamId,
        binding.memberKey,
        binding.nativeAgentId,
        binding.workspaceRoot,
        binding.state,
        binding.blocker ?? null,
      );
    return binding;
  }
  listBindings(sessionId: string): NativeBinding[] {
    return this.rows<BindingRow>(
      'SELECT session_id AS sessionId, team_id AS teamId, member_key AS memberKey, native_agent_id AS nativeAgentId, workspace_root AS workspaceRoot, state, blocker FROM bindings WHERE session_id = ? ORDER BY rowid',
      sessionId,
    ).map(({ blocker, ...binding }) => ({ ...binding, ...(blocker === null ? {} : { blocker }) }));
  }
  close(): void {
    if (this.closed) return;
    this.database
      .prepare('DELETE FROM owner WHERE singleton = 1 AND pid = ? AND token = ?')
      .run(process.pid, this.ownerToken);
    this.database.close();
    this.closed = true;
  }
}

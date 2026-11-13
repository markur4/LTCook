import { randomUUID } from 'node:crypto';
import Database from 'libsql';
import process from 'node:process';
import type {
  Approval, Assignment, CoordinationApi, CreateApprovalInput, CreateAssignmentInput,
  CreateReportInput, CreateReviewInput, CreateTaskInput, NativeBinding, Pass, Report,
  Review, Session, Task, UpdateTaskInput,
} from '../api/team.js';

type TaskRow = Omit<Task, 'blocker' | 'report'> & { blocker: string | null; report: string | null };
type BindingRow = Omit<NativeBinding, 'blocker'> & { blocker: string | null };
/** Owns the coordination database exclusively until close(). */
export class CoordinationStore implements CoordinationApi {
  private readonly database: Database.Database;
  private readonly ownerToken = randomUUID();
  private closed = false;

  constructor(databasePath: string) {
    this.database = new Database(databasePath);
    this.database.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON');
    this.acquireOwner();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, workspace_root TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS passes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), pass_id TEXT NOT NULL REFERENCES passes(id), title TEXT NOT NULL, description TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, blocker TEXT, report TEXT);
      CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id), member_key TEXT NOT NULL, native_agent_id TEXT NOT NULL, status TEXT NOT NULL, handoff TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id), assignment_id TEXT NOT NULL REFERENCES assignments(id), native_agent_id TEXT NOT NULL, summary TEXT NOT NULL, evidence TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id), report_id TEXT NOT NULL REFERENCES reports(id), native_agent_id TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), action TEXT NOT NULL, resource_id TEXT NOT NULL, revision TEXT NOT NULL, decision TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings (session_id TEXT NOT NULL REFERENCES sessions(id), team_id TEXT NOT NULL, member_key TEXT NOT NULL, native_agent_id TEXT, workspace_root TEXT NOT NULL, state TEXT NOT NULL, blocker TEXT, PRIMARY KEY(session_id, member_key));
    `);
  }

  private assertOpen(): void { if (this.closed) throw new Error('Coordination store is closed'); }
  private acquireOwner(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec('CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), pid INTEGER NOT NULL, token TEXT NOT NULL)');
      const owner = this.database.prepare('SELECT pid, token FROM owner WHERE singleton = 1').get() as { pid: number; token: string } | undefined;
      if (owner !== undefined) {
        let dead = false;
        try { process.kill(owner.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') dead = true;
          else throw new Error(`Coordination database owner PID ${owner.pid} is live or cannot be proven dead`);
        }
        if (!dead) throw new Error(`Coordination database is owned by live PID ${owner.pid}`);
        this.database.prepare('DELETE FROM owner WHERE singleton = 1 AND token = ?').run(owner.token);
      }
      this.database.prepare('INSERT INTO owner (singleton, pid, token) VALUES (1, ?, ?)').run(process.pid, this.ownerToken);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      this.database.close();
      throw error;
    }
  }
  private rows<T>(sql: string, ...params: (string | number)[]): T[] {
    this.assertOpen(); return this.database.prepare(sql).all(...params) as T[];
  }
  private row<T>(sql: string, ...params: (string | number)[]): T {
    const value = this.database.prepare(sql).get(...params) as T | undefined;
    if (value === undefined) throw new Error('Coordination record not found');
    return value;
  }
  private transaction<T>(run: () => T): T {
    this.assertOpen(); this.database.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  createSession(input: { id?: string; teamId: string; workspaceRoot: string }): Session {
    const session: Session = { id: input.id ?? randomUUID(), teamId: input.teamId, workspaceRoot: input.workspaceRoot, createdAt: new Date().toISOString() };
    this.transaction(() => { this.database.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(session.id, session.teamId, session.workspaceRoot, session.createdAt); });
    return session;
  }
  getSession(sessionId: string): Session { return this.row<Session>('SELECT id, team_id AS teamId, workspace_root AS workspaceRoot, created_at AS createdAt FROM sessions WHERE id = ?', sessionId); }
  listSessions(): Session[] { return this.rows<Session>('SELECT id, team_id AS teamId, workspace_root AS workspaceRoot, created_at AS createdAt FROM sessions ORDER BY created_at'); }
  createPass(sessionId: string, title: string): Pass {
    const pass: Pass = { id: randomUUID(), sessionId, title, createdAt: new Date().toISOString() };
    this.database.prepare('INSERT INTO passes VALUES (?, ?, ?, ?)').run(pass.id, sessionId, title, pass.createdAt); return pass;
  }
  getPass(sessionId: string, passId: string): Pass { return this.row<Pass>('SELECT id, session_id AS sessionId, title, created_at AS createdAt FROM passes WHERE session_id = ? AND id = ?', sessionId, passId); }
  listPasses(sessionId: string): Pass[] { return this.rows<Pass>('SELECT id, session_id AS sessionId, title, created_at AS createdAt FROM passes WHERE session_id = ? ORDER BY created_at', sessionId); }
  createTask(sessionId: string, input: CreateTaskInput): Task {
    return this.transaction(() => {
      const pass = input.passId === undefined ? this.createPass(sessionId, input.passTitle ?? input.title) : this.getPass(sessionId, input.passId);
      const task: Task = { id: randomUUID(), sessionId, passId: pass.id, title: input.title, description: input.description, acceptance: input.acceptance, status: 'pending', revision: 1 };
      this.database.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)').run(task.id, sessionId, task.passId, task.title, task.description, task.acceptance, task.status, task.revision);
      return task;
    });
  }
  getTask(sessionId: string, taskId: string): Task { return this.taskFromRow(this.row<TaskRow>('SELECT id, session_id AS sessionId, pass_id AS passId, title, description, acceptance, status, revision, blocker, report FROM tasks WHERE session_id = ? AND id = ?', sessionId, taskId)); }
  listTasks(sessionId: string): Task[] { return this.rows<TaskRow>('SELECT id, session_id AS sessionId, pass_id AS passId, title, description, acceptance, status, revision, blocker, report FROM tasks WHERE session_id = ? ORDER BY rowid', sessionId).map((row) => this.taskFromRow(row)); }
  private taskFromRow(row: TaskRow): Task {
    const { blocker, report, ...task } = row;
    return { ...task, ...(blocker === null ? {} : { blocker }), ...(report === null ? {} : { report }) };
  }
  updateTask(sessionId: string, input: UpdateTaskInput): Task {
    this.transaction(() => { const task = this.getTask(sessionId, input.taskId); this.database.prepare('UPDATE tasks SET status = ?, revision = ?, blocker = ? WHERE id = ?').run(input.status, task.revision + 1, input.blocker ?? null, task.id); });
    return this.getTask(sessionId, input.taskId);
  }
  createAssignment(sessionId: string, input: CreateAssignmentInput & { nativeAgentId: string }): Assignment {
    this.getTask(sessionId, input.taskId);
    const assignment: Assignment = { id: randomUUID(), sessionId, taskId: input.taskId, memberKey: input.memberKey, nativeAgentId: input.nativeAgentId, status: 'pending', handoff: input.message };
    this.database.prepare('INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?, ?)').run(assignment.id, sessionId, assignment.taskId, assignment.memberKey, assignment.nativeAgentId, assignment.status, assignment.handoff); return assignment;
  }
  getAssignment(sessionId: string, assignmentId: string): Assignment { return this.row<Assignment>('SELECT id, session_id AS sessionId, task_id AS taskId, member_key AS memberKey, native_agent_id AS nativeAgentId, status, handoff FROM assignments WHERE session_id = ? AND id = ?', sessionId, assignmentId); }
  listAssignments(sessionId: string): Assignment[] { return this.rows<Assignment>('SELECT id, session_id AS sessionId, task_id AS taskId, member_key AS memberKey, native_agent_id AS nativeAgentId, status, handoff FROM assignments WHERE session_id = ? ORDER BY rowid', sessionId); }
  updateAssignment(sessionId: string, assignmentId: string, status: Assignment['status']): Assignment {
    this.getAssignment(sessionId, assignmentId); this.database.prepare('UPDATE assignments SET status = ? WHERE session_id = ? AND id = ?').run(status, sessionId, assignmentId); return this.getAssignment(sessionId, assignmentId);
  }
  createReport(sessionId: string, input: CreateReportInput & { nativeAgentId: string }): Report {
    return this.transaction(() => {
      const assignment = this.getAssignment(sessionId, input.assignmentId);
      if (this.rows('SELECT id FROM reports WHERE session_id = ? AND assignment_id = ?', sessionId, assignment.id).length > 0) {
        throw new Error('This assignment already has a report');
      }
      const report: Report = { id: randomUUID(), sessionId, taskId: assignment.taskId, assignmentId: input.assignmentId, nativeAgentId: input.nativeAgentId, summary: input.summary, evidence: input.evidence, revision: 1 };
      this.database.prepare('INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(report.id, sessionId, report.taskId, report.assignmentId, report.nativeAgentId, report.summary, report.evidence, report.revision);
      this.updateAssignment(sessionId, assignment.id, 'reported');
      const task = this.getTask(sessionId, assignment.taskId);
      this.database.prepare('UPDATE tasks SET report = ?, revision = ? WHERE id = ?').run(report.summary, task.revision + 1, task.id);
      return report;
    });
  }
  listReports(sessionId: string): Report[] { return this.rows<Report>('SELECT id, session_id AS sessionId, task_id AS taskId, assignment_id AS assignmentId, native_agent_id AS nativeAgentId, summary, evidence, revision FROM reports WHERE session_id = ? ORDER BY rowid', sessionId); }
  createReview(sessionId: string, input: CreateReviewInput & { nativeAgentId: string; kind: Review['kind'] }): Review {
    const report = this.rows<Report>('SELECT id, session_id AS sessionId, task_id AS taskId, assignment_id AS assignmentId, native_agent_id AS nativeAgentId, summary, evidence, revision FROM reports WHERE session_id = ? AND id = ?', sessionId, input.reportId)[0];
    if (report === undefined) throw new Error('Report not found');
    const review: Review = { id: randomUUID(), sessionId, taskId: report.taskId, reportId: report.id, nativeAgentId: input.nativeAgentId, kind: input.kind, outcome: input.outcome, summary: input.summary };
    this.database.prepare('INSERT INTO reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(review.id, sessionId, review.taskId, review.reportId, review.nativeAgentId, review.kind, review.outcome, review.summary); return review;
  }
  listReviews(sessionId: string): Review[] { return this.rows<Review>('SELECT id, session_id AS sessionId, task_id AS taskId, report_id AS reportId, native_agent_id AS nativeAgentId, kind, outcome, summary FROM reviews WHERE session_id = ? ORDER BY rowid', sessionId); }
  createApproval(sessionId: string, input: CreateApprovalInput): Approval {
    const approval: Approval = { id: randomUUID(), sessionId, scope: input.scope, decision: input.decision, source: 'user', createdAt: new Date().toISOString() };
    this.database.prepare('INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(approval.id, sessionId, input.scope.action, input.scope.resourceId, input.scope.revision, input.decision, approval.source, approval.createdAt); return approval;
  }
  listApprovals(sessionId: string): Approval[] {
    return this.rows<{ id: string; sessionId: string; action: string; resourceId: string; revision: string; decision: Approval['decision']; source: 'user'; createdAt: string }>('SELECT id, session_id AS sessionId, action, resource_id AS resourceId, revision, decision, source, created_at AS createdAt FROM approvals WHERE session_id = ? ORDER BY created_at', sessionId)
      .map(({ id, sessionId: scopedSession, action, resourceId, revision, decision, source, createdAt }) => ({ id, sessionId: scopedSession, scope: { action, resourceId, revision }, decision, source, createdAt }));
  }
  putBinding(binding: NativeBinding): NativeBinding {
    this.database.prepare(`INSERT INTO bindings VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, member_key) DO UPDATE SET team_id=excluded.team_id, native_agent_id=excluded.native_agent_id, workspace_root=excluded.workspace_root, state=excluded.state, blocker=excluded.blocker`).run(binding.sessionId, binding.teamId, binding.memberKey, binding.nativeAgentId, binding.workspaceRoot, binding.state, binding.blocker ?? null); return binding;
  }
  listBindings(sessionId: string): NativeBinding[] {
    return this.rows<BindingRow>('SELECT session_id AS sessionId, team_id AS teamId, member_key AS memberKey, native_agent_id AS nativeAgentId, workspace_root AS workspaceRoot, state, blocker FROM bindings WHERE session_id = ? ORDER BY rowid', sessionId)
      .map(({ blocker, ...binding }) => ({ ...binding, ...(blocker === null ? {} : { blocker }) }));
  }
  close(): void {
    if (this.closed) return;
    this.database.prepare('DELETE FROM owner WHERE singleton = 1 AND pid = ? AND token = ?').run(process.pid, this.ownerToken);
    this.database.close(); this.closed = true;
  }
}

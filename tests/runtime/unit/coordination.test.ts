import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'libsql';
import { CoordinationStore } from '../../../runtime/src/storage/coordination.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ltcook-runtime-'));
  directories.push(directory);
  return join(directory, 'coordination.sqlite');
}

describe('CoordinationStore', () => {
  test('creates tasks and preserves identity and data through status updates and restart', () => {
    const path = databasePath();
    const first = new CoordinationStore(path);
    const session = first.createSession({ teamId: 'test-team', workspaceRoot: '/workspace' });
    const task = first.createTask(session.id, {
      title: 'Task',
      description: 'Details',
      acceptance: 'Done',
    });
    first.updateTask(session.id, { taskId: task.id, status: 'running' });
    first.close();

    const reopened = new CoordinationStore(path);
    const restored = reopened.getTask(session.id, task.id);
    expect(restored).toMatchObject({
      id: task.id,
      title: 'Task',
      description: 'Details',
      acceptance: 'Done',
      status: 'running',
      revision: 2,
    });
    expect(restored).not.toHaveProperty('passId');
    expect(reopened.getSession(session.id)).toMatchObject({
      teamId: 'test-team',
      workspaceRoot: '/workspace',
    });
    reopened.close();
  });

  test('refuses a second owner while the current process holds the database', () => {
    const path = databasePath();
    const first = new CoordinationStore(path);
    expect(() => new CoordinationStore(path)).toThrow(/owned by live PID/);
    first.close();
  });

  test('recovers only a recorded owner PID proven absent', () => {
    const path = databasePath();
    const first = new CoordinationStore(path);
    first.close();
    const database = new Database(path);
    database
      .prepare('INSERT INTO owner (singleton, pid, token) VALUES (1, ?, ?)')
      .run(2147483647, 'dead-owner');
    database.close();
    const recovered = new CoordinationStore(path);
    expect(recovered.listSessions()).toEqual([]);
    recovered.close();
  });
  test('reuses a canonical TeamInstance while keeping Session IDs and bindings separate', () => {
    const store = new CoordinationStore(databasePath());
    const first = store.createSession({
      teamId: 'test-team',
      workspaceRoot: '/workspace/../workspace',
    });
    const second = store.createSession({ teamId: 'test-team', workspaceRoot: '/workspace' });
    expect(second.id).not.toBe(first.id);
    expect(second.teamInstanceId).toBe(first.teamInstanceId);
    store.putBinding({
      sessionId: first.id,
      teamId: first.teamId,
      memberKey: 'main',
      nativeAgentId: 'native-one',
      workspaceRoot: first.workspaceRoot,
      state: 'bound',
    });
    store.putBinding({
      sessionId: second.id,
      teamId: second.teamId,
      memberKey: 'main',
      nativeAgentId: 'native-two',
      workspaceRoot: second.workspaceRoot,
      state: 'bound',
    });
    expect(store.listBindings(first.id)[0]?.nativeAgentId).toBe('native-one');
    expect(store.listBindings(second.id)[0]?.nativeAgentId).toBe('native-two');
    store.close();
  });

  test('keeps Pass creation explicit, orders Steps, and invalidates reviews on mutations', () => {
    const store = new CoordinationStore(databasePath());
    const session = store.createSession({ teamId: 'test-team', workspaceRoot: '/workspace' });
    const withoutPass = store.createTask(session.id, {
      title: 'Unplanned',
      description: 'Details',
      acceptance: 'Done',
    });
    expect(withoutPass).not.toHaveProperty('passId');
    expect(store.listPasses(session.id)).toEqual([]);
    const pass = store.createPass(session.id, { title: 'Release', planRef: 'plans/release.md' });
    const task = store.createTask(session.id, {
      passId: pass.id,
      title: 'Ship',
      description: 'Details',
      acceptance: 'Done',
    });
    const first = store.createStep(session.id, { taskId: task.id, title: 'Build' });
    const second = store.createStep(session.id, { taskId: task.id, title: 'Review', position: 8 });
    expect(store.listSteps(session.id).map((step) => step.id)).toEqual([first.id, second.id]);
    const initialRevision = store.getPass(session.id, pass.id).revision;
    store.updateStep(session.id, { stepId: first.id, status: 'completed' });
    expect(store.getPass(session.id, pass.id).revision).toBe(initialRevision + 1);
    expect(() => store.getStep('another-session', first.id)).toThrow();
    store.close();
  });
  test('migrates legacy rows with foreign keys and preserves their relationships and approvals', () => {
    const path = databasePath();
    const legacy = new Database(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, workspace_root TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE passes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), pass_id TEXT NOT NULL REFERENCES passes(id), title TEXT NOT NULL, description TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, blocker TEXT, report TEXT);
      CREATE TABLE assignments (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id), member_key TEXT NOT NULL, native_agent_id TEXT NOT NULL, status TEXT NOT NULL, handoff TEXT NOT NULL);
      CREATE TABLE reports (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id), assignment_id TEXT NOT NULL REFERENCES assignments(id), native_agent_id TEXT NOT NULL, summary TEXT NOT NULL, evidence TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE reviews (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id), report_id TEXT NOT NULL REFERENCES reports(id), native_agent_id TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE TABLE approvals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), action TEXT NOT NULL, resource_id TEXT NOT NULL, revision TEXT NOT NULL, decision TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE bindings (session_id TEXT NOT NULL REFERENCES sessions(id), team_id TEXT NOT NULL, member_key TEXT NOT NULL, native_agent_id TEXT, workspace_root TEXT NOT NULL, state TEXT NOT NULL, blocker TEXT, PRIMARY KEY(session_id, member_key));
      INSERT INTO sessions VALUES ('session-legacy', 'team', '/workspace', '2026-01-01');
      INSERT INTO passes VALUES ('pass-legacy', 'session-legacy', 'Old pass', '2026-01-01');
      INSERT INTO tasks VALUES ('task-legacy', 'session-legacy', 'pass-legacy', 'Old task', 'Details', 'Done', 'completed', 2, NULL, NULL);
      INSERT INTO assignments VALUES ('assignment-legacy', 'session-legacy', 'task-legacy', 'main', 'native-old', 'reported', 'handoff');
      INSERT INTO reports VALUES ('report-legacy', 'session-legacy', 'task-legacy', 'assignment-legacy', 'native-old', 'done', 'evidence', 1);
      INSERT INTO reviews VALUES ('review-legacy', 'session-legacy', 'task-legacy', 'report-legacy', 'native-reviewer', 'independent', 'accepted', 'old approval');
      INSERT INTO approvals VALUES ('approval-legacy', 'session-legacy', 'publish', 'release', '1', 'approved', 'user', '2026-01-01');
      INSERT INTO bindings VALUES ('session-legacy', 'team', 'main', 'native-old', '/workspace', 'bound', NULL);
    `);
    legacy.close();

    const store = new CoordinationStore(path);
    expect(store.getSession('session-legacy')).toMatchObject({
      id: 'session-legacy',
      teamInstanceId: expect.any(String),
    });
    expect(store.getTask('session-legacy', 'task-legacy')).toMatchObject({
      id: 'task-legacy',
      status: 'completed',
      passId: 'pass-legacy',
    });
    expect(store.listBindings('session-legacy')[0]).toMatchObject({
      memberKey: 'main',
      nativeAgentId: 'native-old',
      state: 'bound',
    });
    expect(store.listApprovals('session-legacy')).toContainEqual(
      expect.objectContaining({ id: 'approval-legacy', decision: 'approved' }),
    );
    expect(store.listAssignments('session-legacy')).toContainEqual(
      expect.objectContaining({ id: 'assignment-legacy', nativeAgentId: 'native-old' }),
    );
    expect(store.listReports('session-legacy')).toContainEqual(
      expect.objectContaining({ id: 'report-legacy', revision: 1 }),
    );
    expect(store.listReviews('session-legacy')).toEqual([]);
    store.close();

    const reopened = new CoordinationStore(path);
    expect(reopened.getTask('session-legacy', 'task-legacy').id).toBe('task-legacy');
    reopened.close();
    const migrated = new Database(path);
    const review = migrated
      .prepare('SELECT id, outcome FROM legacy_reviews WHERE id = ?')
      .get('review-legacy') as { id: string; outcome: string };
    expect(review).toMatchObject({ id: 'review-legacy', outcome: 'accepted' });
    expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    migrated.close();
  });
  test('rejects a newer schema version and releases the owner without changing it', () => {
    const path = databasePath();
    const database = new Database(path);
    database.exec('PRAGMA user_version = 2');
    database.close();

    expect(() => new CoordinationStore(path)).toThrow(/newer than supported version/);
    const reopened = new Database(path);
    expect(
      (reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(2);
    expect(reopened.prepare('SELECT pid FROM owner').all()).toEqual([]);
    reopened.close();
  });

  test('rolls back a migration with legacy foreign-key violations and releases the owner', () => {
    const path = databasePath();
    const legacy = new Database(path);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, workspace_root TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE bindings (session_id TEXT NOT NULL REFERENCES sessions(id), team_id TEXT NOT NULL, member_key TEXT NOT NULL, native_agent_id TEXT, workspace_root TEXT NOT NULL, state TEXT NOT NULL, blocker TEXT, PRIMARY KEY(session_id, member_key));
      INSERT INTO bindings VALUES ('missing-session', 'team', 'main', NULL, '/workspace', 'closed', NULL);
    `);
    legacy.close();

    expect(() => new CoordinationStore(path)).toThrow(/foreign-key violations/);
    const reopened = new Database(path);
    expect(
      (reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(0);
    expect(
      reopened
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_instances'")
        .all(),
    ).toEqual([]);
    expect(reopened.prepare('SELECT pid FROM owner').all()).toEqual([]);
    reopened.close();
  });

  test('preserves Pass-less tasks when migrating an older nullable schema', () => {
    const path = databasePath();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, workspace_root TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE passes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, pass_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL, acceptance TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, blocker TEXT, report TEXT);
      INSERT INTO sessions VALUES ('session-free', 'team', '/workspace', '2026-01-01');
      INSERT INTO tasks VALUES ('task-free', 'session-free', NULL, 'Free task', 'Details', 'Done', 'pending', 1, NULL, NULL);
    `);
    legacy.close();

    const store = new CoordinationStore(path);
    const task = store.getTask('session-free', 'task-free');
    expect(task).toMatchObject({ id: 'task-free', title: 'Free task' });
    expect(task).not.toHaveProperty('passId');
    expect(store.listPasses('session-free')).toEqual([]);
    store.close();
  });
});

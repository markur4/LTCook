import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
  test.each([0, 1, 3])('rejects incompatible schema %s without modifying any bytes', (version) => {
    const path = databasePath();
    const legacy = new Database(path);
    legacy.exec(
      `CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('keep'); PRAGMA user_version=${version}`,
    );
    legacy.close();
    const original = readFileSync(path);
    expect(() => new CoordinationStore(path)).toThrow(/Incompatible coordination database schema/);
    expect(readFileSync(path)).toEqual(original);
    const probe = new Database(path);
    expect(probe.prepare('SELECT value FROM preserved').get()).toMatchObject({ value: 'keep' });
    expect(
      probe.prepare("SELECT name FROM sqlite_master WHERE name='owner'").get(),
    ).toBeUndefined();
    probe.close();
  });
  test('rejects an incomplete current schema before creating an owner', () => {
    const path = databasePath();
    const invalid = new Database(path);
    invalid.exec('PRAGMA user_version=2');
    invalid.close();
    const original = readFileSync(path);
    expect(() => new CoordinationStore(path)).toThrow(/missing required tables/);
    expect(readFileSync(path)).toEqual(original);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'libsql';
import { CoordinationStore } from '../../../runtime/src/storage/coordination.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
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
    const task = first.createTask(session.id, { title: 'Task', description: 'Details', acceptance: 'Done' });
    first.updateTask(session.id, { taskId: task.id, status: 'running' });
    first.close();

    const reopened = new CoordinationStore(path);
    const restored = reopened.getTask(session.id, task.id);
    expect(restored).toMatchObject({ id: task.id, passId: task.passId, title: 'Task', description: 'Details', acceptance: 'Done', status: 'running', revision: 2 });
    expect(reopened.getSession(session.id)).toMatchObject({ teamId: 'test-team', workspaceRoot: '/workspace' });
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
    database.prepare('UPDATE owner SET pid = ?, token = ? WHERE singleton = 1').run(2147483647, 'dead-owner');
    database.close();
    const recovered = new CoordinationStore(path);
    expect(recovered.listSessions()).toEqual([]);
    recovered.close();
  });
});

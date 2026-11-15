import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EvalRunService } from '../../../runtime/src/evals/service.js';
import { agentBearer, RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);
async function stateRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ltcook-evals-test-'));
  roots.push(root);
  return root;
}
async function finish(service: EvalRunService, runId: string) {
  for (let count = 0; count < 100; count++) {
    const value = await service.status(runId);
    if (value.summary.status !== 'running') return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Agent Evals fake run did not finish');
}

describe('Agent Evals run service', () => {
  test('reports the number of checks in each preset', async () => {
    const service = new EvalRunService(await stateRoot(), async () => ({ result: {}, trace: {} }));
    await service.initialize();
    for (const [preset, total] of [
      ['quick', 2],
      ['audit', 2],
      ['behavior', 6],
      ['bottlenecks', 18],
      ['full', 26],
    ] as const) {
      const runId = await service.start(preset);
      expect((await service.status(runId)).summary.total).toBe(total);
      await finish(service, runId);
    }
  });

  test('API requires user authentication for Agent Evals operations', async () => {
    const service = new EvalRunService(await stateRoot(), async () => ({ result: {}, trace: {} }));
    await service.initialize();
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const address = socket.address();
    if (!address || typeof address === 'string') throw new Error('No test port assigned');
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const secret = 'test-user-token';
    const api = new RuntimeApi(undefined, secret, `127.0.0.1:${address.port}`);
    api.setEval(service);
    const base = await api.listen();
    try {
      const invoke = (token: string, body = '{}') =>
        fetch(`${base}/v1/evals/list`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body,
        });
      expect((await invoke('invalid')).status).toBe(401);
      expect(
        (await invoke(agentBearer(secret, 'agent-1'), '{"nativeAgentId":"agent-1"}')).status,
      ).toBe(403);
      expect((await invoke(secret)).status).toBe(200);
    } finally {
      await api.close();
    }
  });

  test('persists actual progress and reports; limits concurrency and allows deletion', async () => {
    const service = new EvalRunService(await stateRoot(), async ({ progress }) => {
      progress({ event: 'suite.started', suite: 'fixture', completed: 0, total: 1 });
      progress({
        event: 'case.completed',
        suite: 'fixture',
        case: 'fixed',
        completed: 1,
        total: 1,
      });
      return { result: { passed: true, prompt: 'must not persist' }, trace: { spans: 1 } };
    });
    await service.initialize();
    const runId = await service.start('quick');
    await expect(service.start('quick')).rejects.toThrow('already active');
    const completed = await finish(service, runId);
    expect(completed.summary.status).toBe('completed');
    expect(completed.events.map(({ event }) => event)).toEqual([
      'run.started',
      'suite.started',
      'case.completed',
      'run.completed',
    ]);
    expect(service.report(runId).result).toEqual({ passed: true });
    await service.delete(runId);
    expect(service.list()).toHaveLength(0);
  });

  test('cancels a running run and marks unfinished persisted runs interrupted on restart', async () => {
    const root = await stateRoot();
    let release!: () => void;
    const service = new EvalRunService(root, async ({ signal }) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      signal.throwIfAborted();
      return { result: {}, trace: {} };
    });
    await service.initialize();
    const runId = await service.start('quick');
    const cancelled = await service.cancel(runId);
    expect(cancelled.status).toBe('cancelled');
    release();

    const second = await service.start('quick');
    const restarted = new EvalRunService(root, async () => ({ result: {}, trace: {} }));
    await restarted.initialize();
    expect(restarted.list().find(({ runId: id }) => id === second)?.status).toBe('interrupted');
  });
});

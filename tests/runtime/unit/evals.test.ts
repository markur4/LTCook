import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EvalRunService } from '../../../runtime/src/evals/service.js';
import { createEvalEngine } from '../../../runtime/src/evals/engine.js';
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
    // > Terminal summaries precede the final persisted event; wait for both before asserting it.
    if (
      value.summary.status !== 'running' &&
      value.events.some((event) => event.event === `run.${value.summary.status}`)
    )
      return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Agent Evals fake run did not finish');
}

describe('Agent Evals run service', () => {
  test('runs static audit without accessing Ollama', async () => {
    const root = await stateRoot();
    await writeFile(path.join(root, 'guide.md'), 'guidance '.repeat(3001));
    await writeFile(
      path.join(root, 'catalog.json'),
      JSON.stringify([{ path: 'guide.md', kind: 'rule', required: true }]),
    );
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.reject(new Error('unexpected network')),
    );
    try {
      const service = new EvalRunService(
        root,
        createEvalEngine({
          resources: root,
          context: {
            teamSelection: 'default-minimal',
            guidanceDirectory: root,
            webConfiguration: {},
            limitations: [],
          },
        }),
      );
      await service.initialize();
      const runId = await service.start({ preset: 'audit', setup: 'current', staticOnly: true });
      const completed = await finish(service, runId);
      expect(completed.summary.status).toBe('completed');
      expect(completed.summary.total).toBe(1);
      expect(service.report(runId).result).toMatchObject({
        results: {
          static: {
            findings: expect.arrayContaining([
              expect.objectContaining({ kind: 'large_resource', source: 'core/guide.md' }),
            ]),
            resources: expect.arrayContaining([
              expect.objectContaining({ name: 'guide.md', loaded: true }),
            ]),
          },
        },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      await expect(
        service.start({ preset: 'quick', setup: 'current', staticOnly: true }),
      ).rejects.toThrow('staticOnly requires the audit preset');
    } finally {
      fetchSpy.mockRestore();
    }
  });
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
      const runId = await service.start({ preset, setup: 'current' });
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
    const runId = await service.start({ preset: 'quick', setup: 'current' });
    await expect(service.start({ preset: 'quick', setup: 'current' })).rejects.toThrow(
      'already active',
    );
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
    const runId = await service.start({ preset: 'quick', setup: 'current' });
    const cancelled = await service.cancel(runId);
    expect(cancelled.status).toBe('cancelled');
    release();

    const second = await service.start({ preset: 'quick', setup: 'current' });
    const restarted = new EvalRunService(root, async () => ({ result: {}, trace: {} }));
    await restarted.initialize();
    expect(restarted.list().find(({ runId: id }) => id === second)?.status).toBe('interrupted');
  });
});

test('missing Spark is a hard failure and never invokes another provider', async () => {
  const root = await stateRoot();
  const engine = createEvalEngine({
    resources: root,
    context: {
      teamSelection: 'default-minimal',
      guidanceDirectory: '',
      webConfiguration: {},
      limitations: [],
    },
  });
  const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ models: [] }), { status: 200 }),
  );
  try {
    await expect(
      engine({
        preset: 'behavior',
        setup: 'synthetic',
        staticOnly: false,
        runDirectory: root,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    ).rejects.toThrow('no fallback');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://127.0.0.1:11434/api/tags');
    await expect(
      (await import('node:fs/promises'))
        .readdir(root)
        .then((entries) => entries.filter((entry) => entry.startsWith('.execution-'))),
    ).resolves.toEqual([]);
  } finally {
    fetchSpy.mockRestore();
  }
});

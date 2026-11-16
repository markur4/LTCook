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
      ['behavior', 3],
      ['bottlenecks', 3],
      ['full', 5],
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

  test('Current Setup uses the selected registered Leader Team and reports ambiguous CLI workspaces', async () => {
    const root = await stateRoot();
    const observed: Array<{ teamSelection?: string; limitations?: string[] }> = [];
    const service = new EvalRunService(root, async (input) => {
      observed.push({ teamSelection: input.teamSelection, limitations: input.limitations });
      if (observed.length === 3) throw new Error('fixture startup failure');
      return { result: {}, trace: {} };
    });
    await service.initialize();
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const address = socket.address();
    if (!address || typeof address === 'string') throw new Error('No test port assigned');
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const api = new RuntimeApi(undefined, 'test-user-token', `127.0.0.1:${address.port}`);
    api.setEval(service);
    api.setRuntime({
      snapshot: () => ({ session: { workspaceRoot: root, teamId: 'team-b' } }),
      listSessions: () => [{ teamId: 'team-a' }, { teamId: 'team-b' }],
      teamCatalog: () => [{ teamId: 'team-b', selection: 'team-b-selection', status: 'installed' }],
    } as never);
    api.setSession(root, 'leader-b');
    const base = await api.listen();
    const start = (body: Record<string, unknown>) =>
      fetch(`${base}/v1/evals/start`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-user-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          preset: 'audit',
          setup: 'current',
          staticOnly: true,
          workspaceRoot: root,
          ...body,
        }),
      });
    try {
      let response = await start({ sessionId: 'leader-b' });
      expect(response.status).toBe(200);
      await finish(service, ((await response.json()) as { runId: string }).runId);
      expect(observed[0]?.teamSelection).toBe('team-b-selection');
      response = await start({});
      expect(response.status).toBe(200);
      await finish(service, ((await response.json()) as { runId: string }).runId);
      expect(observed[1]?.teamSelection).toBeUndefined();
      expect(observed[1]?.limitations).toEqual([
        'Multiple Teams have Sessions in this workspace; using the configured runtime Team.',
      ]);
      response = await start({});
      const failedRunId = ((await response.json()) as { runId: string }).runId;
      expect((await finish(service, failedRunId)).summary.status).toBe('failed');
      const restarted = new EvalRunService(root, async () => ({ result: {}, trace: {} }));
      await restarted.initialize();
      expect(restarted.report(failedRunId).summary.limitations).toEqual(observed[1]?.limitations);
      expect((await start({ sessionId: 'unregistered' })).status).not.toBe(200);
      expect(
        (await start({ sessionId: 'leader-b', workspaceRoot: path.dirname(root) })).status,
      ).not.toBe(200);
      expect((await start({ sessionId: 'leader-b', setup: 'synthetic' })).status).not.toBe(200);
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

test('Current Setup preserves allowed caller overrides while rejecting credentials and Session mismatches', async () => {
  const root = await stateRoot();
  const observed: Array<{ teamSelection?: string; environmentOverrides?: unknown }> = [];
  const service = new EvalRunService(root, async (input) => {
    observed.push({
      teamSelection: input.teamSelection,
      environmentOverrides: input.environmentOverrides,
    });
    return { result: {}, trace: {} };
  });
  await service.initialize();
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No test port assigned');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const api = new RuntimeApi(undefined, 'user-secret', `127.0.0.1:${address.port}`);
  api.setEval(service);
  api.setRuntime({
    snapshot: () => ({ session: { workspaceRoot: root, teamId: 'team-b' } }),
    listSessions: () => [],
    teamCatalog: () => [
      { teamId: 'team-a', selection: 'team-a-selection', status: 'installed' },
      { teamId: 'team-b', selection: 'team-b-selection', status: 'installed' },
    ],
  } as never);
  api.setSession(root, 'leader-b');
  const base = await api.listen();
  const start = (body: Record<string, unknown>, token = 'user-secret') =>
    fetch(`${base}/v1/evals/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        preset: 'audit',
        setup: 'current',
        staticOnly: true,
        workspaceRoot: root,
        ...body,
      }),
    });
  try {
    const overrides = {
      LTCOOK_TEAM: 'team-a-selection',
      LTCOOK_SEARXNG_URL: 'http://127.0.0.1:8123',
    };
    const response = await start({ environmentOverrides: overrides });
    expect(response.status).toBe(200);
    const id = ((await response.json()) as { runId: string }).runId;
    await finish(service, id);
    expect(observed).toEqual([
      { teamSelection: 'team-a-selection', environmentOverrides: overrides },
    ]);
    expect(JSON.stringify(service.report(id))).not.toContain('8123');
    const matching = await start({
      sessionId: 'leader-b',
      environmentOverrides: { LTCOOK_TEAM: 'team-b' },
    });
    expect(matching.status).toBe(200);
    await finish(service, ((await matching.json()) as { runId: string }).runId);
    expect(observed[1]?.teamSelection).toBe('team-b');
    expect((await start({ environmentOverrides: { OPENAI_API_KEY: 'not-allowed' } })).status).toBe(
      400,
    );
    expect((await start({ environmentOverrides: { LTCOOK_TEAM: 'missing' } })).status).toBe(400);
    expect((await start({ sessionId: 'leader-b', environmentOverrides: overrides })).status).toBe(
      400,
    );
    expect((await start({ environmentOverrides: overrides }, 'wrong-token')).status).toBe(401);
    expect(observed).toHaveLength(2);
  } finally {
    await api.close();
    await service.close();
  }
});

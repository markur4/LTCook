import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EvalRunService } from '../../../runtime/src/evals/service.js';
import { createEvalEngine } from '../../../runtime/src/evals/engine.js';
import { EVAL_MODEL } from '../../../runtime/src/evals/setup.js';
import { agentBearer, RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import { SessionActivation } from '../../../runtime/src/integrations/session-activation.js';

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
  test('runs static audit offline and retains the engine startup bundle fingerprint', async () => {
    const root = await stateRoot();
    await mkdir(path.join(root, 'teams', 'fixture-selected'), { recursive: true });
    await writeFile(
      path.join(root, 'teams', 'fixture-selected', 'package.json'),
      JSON.stringify({ name: '@ltcook/team-default-minimal' }),
    );
    const projectRoot = path.resolve(import.meta.dir, '../../..');
    await symlink(
      path.join(projectRoot, 'node_modules'),
      path.join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const bundle = await Bun.build({
      entrypoints: [path.join(projectRoot, 'runtime/src/evals/engine.ts')],
      outdir: path.join(root, 'runtime/dist'),
      naming: 'engine.js',
      target: 'node',
      packages: 'external',
    });
    expect(bundle.success).toBe(true);
    const bundlePath = bundle.outputs[0]!.path;
    const startupHash = createHash('sha256')
      .update(await readFile(bundlePath))
      .digest('hex');
    const compiled = (await import(
      pathToFileURL(bundlePath).href
    )) as typeof import('../../../runtime/src/evals/engine.js');
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
        compiled.createEvalEngine({
          resources: root,
          appRoot: root,
          context: {
            teamSelection: 'fixture-selected',
            guidanceDirectory: root,
            sharedSkillsDirectory: '',
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
      await writeFile(bundlePath, '// Replacement bundle written while the engine was live.\n');
      const summarizationRun = await service.start({
        preset: 'behavior',
        setup: 'synthetic',
        scenario: 'summarization',
      });
      await finish(service, summarizationRun);
      expect(service.report(summarizationRun).result).toMatchObject({
        results: { summarization: { code: { kind: 'bundle', sha256: startupHash } } },
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
      ['behavior', 4],
      ['bottlenecks', 3],
      ['full', 6],
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
    const api = new RuntimeApi(
      undefined,
      secret,
      `127.0.0.1:${address.port}`,
      new SessionActivation(),
    );
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
    const activation = new SessionActivation();
    const api = new RuntimeApi(
      undefined,
      'test-user-token',
      `127.0.0.1:${address.port}`,
      activation,
    );
    api.setEval(service);
    api.setRuntime({
      snapshot: () => ({ session: { workspaceRoot: root, teamId: 'team-b' } }),
      listSessions: () => [{ teamId: 'team-a' }, { teamId: 'team-b' }],
      teamCatalog: () => [{ teamId: 'team-b', selection: 'team-b-selection', status: 'installed' }],
    } as never);
    activation.register(root, 'leader-b');
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

test('missing Bonsai is a hard failure and never invokes another provider', async () => {
  const root = await stateRoot();
  const engine = createEvalEngine({
    resources: root,
    context: {
      teamSelection: 'default-minimal',
      guidanceDirectory: '',
      sharedSkillsDirectory: '',
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

test('an incorrectly configured Bonsai context fails before inference', async () => {
  const root = await stateRoot();
  const engine = createEvalEngine({
    resources: root,
    context: {
      teamSelection: 'default-minimal',
      guidanceDirectory: '',
      sharedSkillsDirectory: '',
      webConfiguration: {},
      limitations: [],
    },
  });
  const fetchSpy = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: EVAL_MODEL }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ modelfile: 'PARAMETER num_ctx 8192' })));
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
    ).rejects.toThrow('65536 context tokens');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
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
  const activation = new SessionActivation();
  const api = new RuntimeApi(undefined, 'user-secret', `127.0.0.1:${address.port}`, activation);
  api.setEval(service);
  api.setRuntime({
    snapshot: () => ({ session: { workspaceRoot: root, teamId: 'team-b' } }),
    listSessions: () => [],
    teamCatalog: () => [
      { teamId: 'team-a', selection: 'team-a-selection', status: 'installed' },
      { teamId: 'team-b', selection: 'team-b-selection', status: 'installed' },
    ],
  } as never);
  activation.register(root, 'leader-b');
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

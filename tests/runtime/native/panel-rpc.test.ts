import { describe, expect, test } from 'bun:test';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import contribute from '../../../runtime/src/paseo-plugin/index.server.js';

type Handler = (input: never, context?: never) => Promise<unknown>;

async function registerHandlers() {
  const handlers = new Map<string, Handler>();
  const hooks: string[] = [];
  const dispose = await contribute({
    addHook(name: string) {
      hooks.push(name);
      return () => undefined;
    },
    handle(contract: { name: string }, handler: Handler) {
      handlers.set(contract.name, handler);
    },
  } as unknown as PluginServerContext);
  return { handlers, hooks, dispose };
}

function runtimeEnvironment() {
  const oldEndpoint = process.env.LTCOOK_RUNTIME_API_URL;
  const oldToken = process.env.LTCOOK_RUNTIME_USER_TOKEN;
  process.env.LTCOOK_RUNTIME_API_URL = 'http://runtime.invalid';
  process.env.LTCOOK_RUNTIME_USER_TOKEN = 'private-runtime-token';
  return () => {
    if (oldEndpoint === undefined) delete process.env.LTCOOK_RUNTIME_API_URL;
    else process.env.LTCOOK_RUNTIME_API_URL = oldEndpoint;
    if (oldToken === undefined) delete process.env.LTCOOK_RUNTIME_USER_TOKEN;
    else process.env.LTCOOK_RUNTIME_USER_TOKEN = oldToken;
  };
}

const catalogEntry = {
  selection: 'default',
  teamId: 'team-id',
  name: 'Test team',
  description: 'Local test Team',
  origin: 'bundled',
  status: 'installed',
  leader: { key: 'leader', name: 'Leader' },
  persistentMembers: 1,
  temporaryMembers: 1,
};

describe('Paseo Team RPC', () => {
  test('registers native lifecycle hooks and loads the local catalog with server credentials', async () => {
    const restoreEnvironment = runtimeEnvironment();
    const originalFetch = globalThis.fetch;
    let received: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      received = { url: String(input), init: init ?? {} };
      return Response.json({ teams: [catalogEntry] });
    }) as typeof fetch;

    const { handlers, hooks, dispose } = await registerHandlers();
    try {
      expect(hooks).toContain('agent.open.before');
      expect(hooks).toContain('agent.archive.after');
      const catalog = handlers.get('ltcook.team.catalog');
      expect(catalog).toBeDefined();

      const result = await catalog!({} as never);
      expect(result).toEqual({ teams: [catalogEntry] });
      expect(received?.url).toBe('http://runtime.invalid/v1/team/catalog');
      expect(received?.init.headers).toEqual({
        authorization: 'Bearer private-runtime-token',
        'content-type': 'application/json',
      });
      expect(JSON.parse(String(received?.init.body))).toEqual({});
      expect(JSON.stringify(result)).not.toContain('private-runtime-token');
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      restoreEnvironment();
    }
  });

  test('lists enriched Leaders, reuses the most recent Session, and creates an explicit new one', async () => {
    const restoreEnvironment = runtimeEnvironment();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: unknown }> = [];
    const creations: unknown[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      requests.push({ url, body });
      if (url.endsWith('/v1/session/list'))
        return Response.json({
          sessions: [
            {
              sessionId: 'leader-id',
              teamId: 'team-id',
              workspaceRoot: '/project',
              leaderAgentId: 'leader-id',
              createdAt: '2026-02-01T00:00:00Z',
            },
          ],
        });
      if (url.endsWith('/v1/team/catalog')) return Response.json({ teams: [catalogEntry] });
      return Response.json({ error: 'unexpected route' }, { status: 404 });
    }) as typeof fetch;

    let modelsAvailable = true;
    const paseo = {
      providers: {
        async listModels(provider: string) {
          expect(provider).toBe('ltcook');
          return {
            models: modelsAvailable
              ? [{ id: 'fixture/first' }, { id: 'fixture/preferred', isDefault: true }]
              : [],
          };
        },
      },
      agents: {
        ref(agentId: string) {
          return {
            async refresh() {
              return {
                agent: {
                  id: agentId,
                  title: 'Most recent Leader',
                  status: 'idle',
                  updatedAt: '2026-02-02T00:00:00Z',
                  archivedAt: null,
                },
              };
            },
          };
        },
        async create(input: unknown) {
          creations.push(input);
          const value = input as { agentId: string };
          return { id: value.agentId };
        },
      },
    };

    const { handlers, dispose } = await registerHandlers();
    try {
      const list = handlers.get('ltcook.session.list');
      const open = handlers.get('ltcook.session.open');
      expect(list).toBeDefined();
      expect(open).toBeDefined();

      const listed = await list!(
        { workspaceRoot: '/project', teamSelection: 'default' } as never,
        { paseo } as never,
      );
      expect(listed).toEqual({
        sessions: [
          {
            sessionId: 'leader-id',
            teamId: 'team-id',
            workspaceRoot: '/project',
            leaderAgentId: 'leader-id',
            createdAt: '2026-02-01T00:00:00Z',
            title: 'Most recent Leader',
            status: 'idle',
            lastActivityAt: '2026-02-02T00:00:00Z',
          },
        ],
      });
      expect(requests[0]).toEqual({
        url: 'http://runtime.invalid/v1/session/list',
        body: { workspaceRoot: '/project', teamSelection: 'default' },
      });

      expect(
        await open!(
          { workspaceRoot: '/project', teamSelection: 'default' } as never,
          { paseo } as never,
        ),
      ).toEqual({
        sessionId: 'leader-id',
        workspaceRoot: '/project',
        leaderAgentId: 'leader-id',
      });
      expect(creations).toHaveLength(0);

      const created = (await open!(
        { workspaceRoot: '/project', teamSelection: 'default', newSession: true } as never,
        { paseo } as never,
      )) as { sessionId: string; workspaceRoot: string; leaderAgentId: string };
      expect(created.workspaceRoot).toBe('/project');
      expect(created.sessionId).toBe(created.leaderAgentId);
      expect(creations).toHaveLength(1);
      expect(creations[0]).toMatchObject({
        agentId: created.leaderAgentId,
        idempotencyKey: created.leaderAgentId,
        cwd: '/project',
        config: { provider: 'ltcook/fixture/preferred' },
        title: 'project · Test team',
        metadata: { 'ltcook.team': 'default' },
      });
      expect(requests.at(-1)).toEqual({
        url: 'http://runtime.invalid/v1/team/catalog',
        body: {},
      });
      expect(JSON.stringify(created)).not.toContain('private-runtime-token');
      modelsAvailable = false;
      await expect(
        open!(
          { workspaceRoot: '/project', teamSelection: 'default', newSession: true } as never,
          { paseo } as never,
        ),
      ).rejects.toThrow('Configure an available LTCook model');
      expect(creations).toHaveLength(1);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      restoreEnvironment();
    }
  });

  test('uses Session identity for snapshots and details while preserving API errors', async () => {
    const restoreEnvironment = runtimeEnvironment();
    const originalFetch = globalThis.fetch;
    let mode: 'missing' | 'wrong-session' | 'unauthorized' | 'detail' | 'snapshot' = 'missing';
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      requests.push({ url, body });
      if (mode === 'missing')
        return Response.json(
          { error: 'No session found for workspace', code: 'SESSION_NOT_FOUND' },
          { status: 404 },
        );
      if (mode === 'wrong-session')
        return Response.json(
          { error: 'Session does not belong to the requested workspace' },
          { status: 404 },
        );
      if (mode === 'unauthorized') return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (mode === 'detail')
        return Response.json({
          tasks: [
            {
              id: 'selected',
              title: 'Selected',
              status: 'blocked',
              description: 'visible detail',
              acceptance: 'visible acceptance',
              blocker: 'waiting',
            },
            {
              id: 'other',
              title: 'Other',
              status: 'running',
              description: 'PRIVATE_OTHER',
              acceptance: 'PRIVATE_OTHER',
            },
          ],
          members: [],
          assignments: [],
          reports: [],
          blockers: [],
        });
      return Response.json({
        session: {
          id: 'leader-id',
          teamId: 'team-id',
          teamInstanceId: 'team-instance-id',
          workspaceRoot: '/project',
          createdAt: '2026-02-01T00:00:00Z',
        },
        definition: { name: 'Test team', leaderKey: 'leader' },
        members: [],
        passes: [],
        tasks: [],
        steps: [],
        assignments: [],
        blockers: [],
      });
    }) as typeof fetch;

    const { handlers, dispose } = await registerHandlers();
    try {
      const context = { paseo: {} } as never;
      const snapshot = (input: never) => handlers.get('ltcook.team.snapshot')!(input, context);
      const detail = (input: never) => handlers.get('ltcook.team.detail')!(input, context);
      expect(await snapshot({ sessionId: 'leader-id' } as never)).toBeNull();
      expect(requests.at(-1)).toEqual({
        url: 'http://runtime.invalid/v1/snapshot',
        body: { sessionId: 'leader-id' },
      });
      await expect(
        detail({
          sessionId: 'leader-id',
          target: { kind: 'task', taskId: 'selected' },
        } as never),
      ).resolves.toBeNull();

      mode = 'wrong-session';
      await expect(snapshot({ sessionId: 'leader-id' } as never)).rejects.toThrow(
        'LTCook team snapshot unavailable (404): Session does not belong to the requested workspace',
      );
      mode = 'unauthorized';
      await expect(snapshot({ sessionId: 'leader-id' } as never)).rejects.toThrow(
        'LTCook team snapshot unavailable (401): unauthorized',
      );

      mode = 'snapshot';
      expect(await snapshot({ sessionId: 'leader-id' } as never)).toMatchObject({
        sessionId: 'leader-id',
        leaderKey: 'leader',
        teamId: 'team-id',
        teamName: 'Test team',
        members: [],
      });
      mode = 'detail';
      const selected = await detail({
        sessionId: 'leader-id',
        target: { kind: 'task', taskId: 'selected' },
      } as never);
      expect(selected).toMatchObject({
        kind: 'task',
        taskId: 'selected',
        description: 'visible detail',
        blocker: 'waiting',
      });
      expect(JSON.stringify(selected)).not.toContain('PRIVATE_OTHER');
      expect(JSON.stringify(selected)).not.toContain('private-runtime-token');
      expect(
        requests
          .filter(({ url }) => url.endsWith('/v1/snapshot'))
          .every(({ body }) => JSON.stringify(body) === '{"sessionId":"leader-id"}'),
      ).toBe(true);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      restoreEnvironment();
    }
  });

  test('recovers history panels from a refreshed native Leader without activating its Session', async () => {
    const restoreEnvironment = runtimeEnvironment();
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const identity = {
      sessionId: 'saved-leader',
      leaderAgentId: 'saved-leader',
      workspaceRoot: '/project',
      teamSelection: 'default',
    };
    const nativeAgent = (overrides: Record<string, unknown> = {}) => ({
      agent: {
        id: identity.leaderAgentId,
        provider: 'ltcook',
        cwd: '/project',
        metadata: { 'ltcook.team': 'default' },
        labels: {},
        ...overrides,
      },
    });
    let native: unknown = nativeAgent();
    let refreshes = 0;
    const paseo = {
      agents: {
        ref(id: string) {
          expect(id).toBe(identity.leaderAgentId);
          return {
            async refresh() {
              refreshes++;
              return native;
            },
          };
        },
      },
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(input), body });
      if (!body.leaderAgentId)
        return Response.json({ error: 'Session is not active in this runtime' }, { status: 400 });
      expect(body).toEqual(identity);
      return Response.json({
        session: { id: identity.sessionId, teamId: 'team-id' },
        definition: { name: 'Test team', leaderKey: 'leader' },
        members: [],
        passes: [],
        tasks: [],
        steps: [],
        assignments: [],
        reports: [],
        blockers: [],
      });
    }) as typeof fetch;
    const { handlers, dispose } = await registerHandlers();
    const context = { paseo } as never;
    try {
      const snapshot = handlers.get('ltcook.team.snapshot')!;
      expect(await snapshot({ sessionId: identity.sessionId } as never, context)).toMatchObject({
        sessionId: identity.sessionId,
      });
      expect(
        await handlers.get('ltcook.team.detail')!(
          { sessionId: identity.sessionId, target: { kind: 'issues' } } as never,
          context,
        ),
      ).toEqual({ kind: 'issues', blockers: [], taskIssues: [] });
      expect(refreshes).toBe(2);
      expect(requests).toHaveLength(4);
      expect(requests.every((request) => request.url.endsWith('/v1/snapshot'))).toBe(true);
      for (const invalid of [
        null,
        nativeAgent({ provider: 'pi' }),
        nativeAgent({ id: 'other' }),
        nativeAgent({ cwd: '' }),
        nativeAgent({ metadata: {} }),
      ]) {
        native = invalid;
        const count = requests.length;
        await expect(snapshot({ sessionId: identity.sessionId } as never, context)).rejects.toThrow(
          'Saved LTCook Leader identity is unavailable',
        );
        expect(requests).toHaveLength(count + 1);
      }
      identity.sessionId = 'cli-session';
      identity.leaderAgentId = 'cli-native-leader';
      native = nativeAgent({
        provider: 'pi',
        metadata: {},
        labels: {
          'ltcook.member': 'leader',
          'ltcook.session': identity.sessionId,
          'ltcook.team': identity.teamSelection,
        },
      });
      expect(
        await snapshot(
          { sessionId: identity.sessionId, leaderAgentId: identity.leaderAgentId } as never,
          context,
        ),
      ).toMatchObject({ sessionId: identity.sessionId });
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      restoreEnvironment();
    }
  });

  test('unresolved Leaders preserve blockers while healthy Sessions remain reusable', async () => {
    const restoreEnvironment = runtimeEnvironment();
    const originalFetch = globalThis.fetch;
    let includeHealthy = true;
    const sessions = ['healthy', 'missing', 'unbound', 'archived'].map((id) => ({
      sessionId: id,
      teamId: 'team-id',
      workspaceRoot: '/project',
      leaderAgentId: id === 'unbound' ? null : id,
      createdAt: '2026-02-01T00:00:00Z',
      ...(id === 'unbound'
        ? { blocker: 'Native creation is uncertain; inspect this Session.' }
        : {}),
    }));
    globalThis.fetch = (async (input: string | URL | Request) => {
      expect(String(input).endsWith('/v1/session/list')).toBe(true);
      return Response.json({
        sessions: sessions.filter((session) => includeHealthy || session.sessionId !== 'healthy'),
      });
    }) as typeof fetch;
    const paseo = {
      agents: {
        ref(id: string) {
          expect(id).not.toBe('unbound');
          return {
            async refresh() {
              return id === 'missing'
                ? null
                : {
                    agent: {
                      id,
                      title: 'Saved Leader',
                      status: 'idle',
                      updatedAt: '2026-02-02T00:00:00Z',
                      archivedAt: id === 'archived' ? '2026-02-02T00:00:00Z' : null,
                    },
                  };
            },
          };
        },
        async create() {
          throw new Error('Unresolved Sessions must never create an automatic replacement');
        },
      },
    };
    const { handlers, dispose } = await registerHandlers();
    const context = { paseo } as never;
    const input = { workspaceRoot: '/project', teamSelection: 'default' } as never;
    try {
      const result = (await handlers.get('ltcook.session.list')!(input, context)) as {
        sessions: Array<{ sessionId: string; status: string; blocker?: string }>;
      };
      expect(result.sessions).toHaveLength(3);
      expect(result.sessions.find((session) => session.sessionId === 'missing')).toMatchObject({
        status: 'unavailable',
        blocker: expect.stringContaining('native Leader is missing'),
      });
      expect(result.sessions.find((session) => session.sessionId === 'unbound')).toMatchObject({
        status: 'unavailable',
        blocker: expect.stringContaining('creation is uncertain'),
      });
      expect(await handlers.get('ltcook.session.open')!(input, context)).toMatchObject({
        leaderAgentId: 'healthy',
      });
      includeHealthy = false;
      await expect(handlers.get('ltcook.session.open')!(input, context)).rejects.toThrow(
        'New Session',
      );
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      restoreEnvironment();
    }
  });
});

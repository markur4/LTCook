import { describe, expect, test } from 'bun:test';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import contribute from '../../../runtime/src/paseo-plugin/index.server.js';

type Handler = (input: never) => Promise<unknown>;

async function registerHandlers() {
  const handlers = new Map<string, Handler>();
  await contribute({
    handle(contract: { name: string }, handler: Handler) {
      handlers.set(contract.name, handler);
    },
  } as unknown as PluginServerContext);
  return handlers;
}

describe('Paseo panel RPC', () => {
  test('opens only on request with server credentials and preserves missing-session versus API errors', async () => {
    const oldEndpoint = process.env.LTCOOK_RUNTIME_API_URL;
    const oldToken = process.env.LTCOOK_RUNTIME_USER_TOKEN;
    const oldTeam = process.env.LTCOOK_TEAM;
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init: RequestInit }> = [];
    process.env.LTCOOK_RUNTIME_API_URL = 'http://runtime.invalid';
    process.env.LTCOOK_RUNTIME_USER_TOKEN = 'private-runtime-token';
    process.env.LTCOOK_TEAM = 'server-team';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      if (String(input).endsWith('/v1/session/open')) {
        if (requests.length === 1) {
          return Response.json({ sessionId: 'new-session', workspaceRoot: '/project' });
        }
        return Response.json({ error: 'Runtime session activation is not ready' }, { status: 503 });
      }
      if (requests.length === 3) {
        return Response.json(
          { error: 'No session found for workspace', code: 'SESSION_NOT_FOUND' },
          { status: 404 },
        );
      }
      if (requests.length === 4) {
        return Response.json({ error: 'wrong workspace' }, { status: 404 });
      }
      if (requests.length === 6) {
        return Response.json({
          session: { teamId: 'server-team' },
          members: [],
          passes: [],
          tasks: [],
          steps: [],
          assignments: [],
          blockers: [],
        });
      }
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }) as typeof fetch;

    try {
      const handlers = await registerHandlers();
      const open = handlers.get('ltcook.session.open');
      const snapshot = handlers.get('ltcook.team.snapshot');
      expect(open).toBeDefined();
      expect(snapshot).toBeDefined();

      const opened = await open!({ workspaceRoot: '/project' } as never);
      expect(opened).toEqual({ sessionId: 'new-session', workspaceRoot: '/project' });
      expect(requests[0]?.url).toBe('http://runtime.invalid/v1/session/open');
      expect(requests[0]?.init.headers).toEqual({
        authorization: 'Bearer private-runtime-token',
        'content-type': 'application/json',
      });
      const openBody = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
      expect(openBody).toMatchObject({ workspaceRoot: '/project', teamSelection: 'server-team' });
      expect(openBody.sessionId).toEqual(expect.any(String));
      expect(openBody).not.toHaveProperty('shellEnvironment');
      expect(JSON.stringify(opened)).not.toContain('private-runtime-token');
      await expect(open!({ workspaceRoot: '/project' } as never)).rejects.toThrow(
        'LTCook session could not be started (503): Runtime session activation is not ready',
      );

      expect(await snapshot!({ workspaceRoot: '/project' } as never)).toBeNull();
      await expect(snapshot!({ workspaceRoot: '/project' } as never)).rejects.toThrow(
        'LTCook team snapshot unavailable (404): wrong workspace',
      );
      await expect(snapshot!({ workspaceRoot: '/project' } as never)).rejects.toThrow(
        'LTCook team snapshot unavailable (401): unauthorized',
      );
      expect(requests[2]?.url).toBe('http://runtime.invalid/v1/snapshot');
      expect(JSON.parse(String(requests[2]?.init.body))).toEqual({ workspaceRoot: '/project' });
      expect(await snapshot!({ workspaceRoot: '/project' } as never)).toEqual({
        teamId: 'server-team',
        members: [],
        passes: [],
        tasks: [],
        assignments: [],
        issues: [],
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (oldEndpoint === undefined) delete process.env.LTCOOK_RUNTIME_API_URL;
      else process.env.LTCOOK_RUNTIME_API_URL = oldEndpoint;
      if (oldToken === undefined) delete process.env.LTCOOK_RUNTIME_USER_TOKEN;
      else process.env.LTCOOK_RUNTIME_USER_TOKEN = oldToken;
      if (oldTeam === undefined) delete process.env.LTCOOK_TEAM;
      else process.env.LTCOOK_TEAM = oldTeam;
    }
  });
});

import { afterEach, expect, test } from 'bun:test';
import { connectPaseoMaintenance } from '../../../runtime/src/integrations/paseo-idle-restart.js';

const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function daemon(capability = true) {
  const requests: Array<{
    path: string;
    method: string;
    authorization: string | null;
    contentType: string | null;
    upgrade: string | null;
    body: unknown;
  }> = [];
  const state = {
    capability,
    archiveReply: () =>
      Response.json({
        workspaceId: 'workspace-one',
        archived: true,
        preservedDirectory: true,
      }),
  };
  const server = Bun.serve<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const text = await request.text();
      const body = text ? JSON.parse(text) : null;
      requests.push({
        path,
        method: request.method,
        authorization: request.headers.get('authorization'),
        contentType: request.headers.get('content-type'),
        upgrade: request.headers.get('upgrade'),
        body,
      });
      if (path === '/api/ltcook/idle-restart') {
        return Response.json({
          status: 'ready',
          ...(state.capability ? { workspaceArchive: 'preserve-directory-v1' } : {}),
        });
      }
      if (path === '/api/ltcook/workspace-archive') return state.archiveReply();
      // A hypothetical fallback would look successful. The assertions require
      // that no legacy HTTP or WebSocket request ever reaches this branch.
      return Response.json({ archived: true, workspaceId: 'workspace-one' });
    },
  });
  servers.push(server);
  return { state, requests, listen: `127.0.0.1:${server.port}`, port: server.port };
}

test('A ready daemon without preserving capability exposes no automatic archive function', async () => {
  const f = daemon(false);
  const maintenance = await connectPaseoMaintenance(f.listen, 'user-secret');
  expect(maintenance?.reserveIdleRestart).toBeFunction();
  expect(maintenance?.archiveWorkspacePreservingFiles).toBeUndefined();
  expect(f.requests).toEqual([
    {
      path: '/api/ltcook/idle-restart',
      method: 'POST',
      authorization: 'Bearer user-secret',
      contentType: 'application/json',
      upgrade: null,
      body: { operation: 'status' },
    },
  ]);
});

test('Preserving capability uses only the authenticated dedicated POST with the exact workspace', async () => {
  const f = daemon();
  const maintenance = await connectPaseoMaintenance(f.listen, 'user-secret');
  expect(maintenance?.archiveWorkspacePreservingFiles).toBeFunction();
  expect(await maintenance!.archiveWorkspacePreservingFiles!('workspace-one')).toBe(true);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]).toEqual({
    path: '/api/ltcook/workspace-archive',
    method: 'POST',
    authorization: 'Bearer user-secret',
    contentType: 'application/json',
    upgrade: null,
    body: { workspaceId: 'workspace-one' },
  });
});

test('A busy preserving endpoint returns false without falling back', async () => {
  const f = daemon();
  f.state.archiveReply = () => Response.json({ error: 'Paseo is busy' }, { status: 409 });
  const maintenance = await connectPaseoMaintenance(f.listen, 'user-secret');
  expect(await maintenance!.archiveWorkspacePreservingFiles!('workspace-one')).toBe(false);
  expect(f.requests.map((request) => request.path)).toEqual([
    '/api/ltcook/idle-restart',
    '/api/ltcook/workspace-archive',
  ]);
});

test('A daemon restart that removes preserving capability never downgrades a negotiated archive to legacy HTTP or WebSocket', async () => {
  const f = daemon();
  const maintenance = await connectPaseoMaintenance(f.listen, 'user-secret');
  f.state.capability = false;
  f.state.archiveReply = () => new Response('Not found', { status: 404 });
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(maintenance!.archiveWorkspacePreservingFiles!('workspace-one')).rejects.toThrow(
      'directory-preserving archive is unavailable',
    );
  }
  expect(f.requests.map((request) => request.path)).toEqual([
    '/api/ltcook/idle-restart',
    '/api/ltcook/workspace-archive',
    '/api/ltcook/workspace-archive',
  ]);
  expect(f.requests.every((request) => request.upgrade === null)).toBe(true);
  const reconnected = await connectPaseoMaintenance(f.listen, 'user-secret');
  expect(reconnected?.archiveWorkspacePreservingFiles).toBeUndefined();
});

test.each([
  [
    'mismatched workspace',
    { workspaceId: 'workspace-two', archived: true, preservedDirectory: true },
  ],
  ['missing preservation guarantee', { workspaceId: 'workspace-one', archived: true }],
  [
    'false preservation guarantee',
    { workspaceId: 'workspace-one', archived: true, preservedDirectory: false },
  ],
  [
    'unexpected fields',
    {
      workspaceId: 'workspace-one',
      archived: true,
      preservedDirectory: true,
      removedDirectory: false,
    },
  ],
])('A preserving response with %s is rejected', async (_description, body) => {
  const f = daemon();
  f.state.archiveReply = () => Response.json(body);
  const maintenance = await connectPaseoMaintenance(f.listen, 'user-secret');
  await expect(maintenance!.archiveWorkspacePreservingFiles!('workspace-one')).rejects.toThrow();
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]?.path).toBe('/api/ltcook/workspace-archive');
});

test('An archive redirect cannot send credentials or fall back to another archive route', async () => {
  const f = daemon();
  f.state.archiveReply = () =>
    new Response(null, {
      status: 307,
      headers: { location: '/legacy-archive' },
    });
  const maintenance = await connectPaseoMaintenance(f.listen, 'user-secret');
  await expect(maintenance!.archiveWorkspacePreservingFiles!('workspace-one')).rejects.toThrow();
  expect(f.requests.map((request) => request.path)).toEqual([
    '/api/ltcook/idle-restart',
    '/api/ltcook/workspace-archive',
  ]);
});

test('Only bare loopback authorities are negotiated and wildcard IPv4 binds resolve locally', async () => {
  const f = daemon();
  for (const listen of [
    `192.0.2.1:${f.port}`,
    `user:password@127.0.0.1:${f.port}`,
    `${f.listen}/wrong-path`,
    `${f.listen}?redirect=1`,
    `${f.listen}#fragment`,
  ]) {
    expect(await connectPaseoMaintenance(listen, 'user-secret')).toBeUndefined();
  }
  expect(f.requests).toEqual([]);
  const maintenance = await connectPaseoMaintenance(`0.0.0.0:${f.port}`, 'user-secret');
  expect(maintenance?.archiveWorkspacePreservingFiles).toBeFunction();
  expect(f.requests).toHaveLength(1);
});

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentBackend,
  RuntimeActor,
  RuntimeController,
  SessionSnapshot,
  TeamPackage,
} from '../../../runtime/src/workflow-api/index.js';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import {
  agentEnvironment,
  nativeToolAllowed,
} from '../../../runtime/src/integrations/native-policy.js';
import { panelSnapshot } from '../../../runtime/src/paseo-plugin/shared/panel-snapshot.js';
import { Telemetry } from '../../../runtime/src/diagnostics/telemetry.js';
import { agentBearer, RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import { SessionActivation } from '../../../runtime/src/integrations/session-activation.js';
import { ActivityPreferences } from '../../../runtime/src/integrations/activity-preferences.js';
import type { PaseoWorkspaceServices } from '../../../runtime/src/integrations/paseo-workspace-services.js';
import {
  createWorktreeScopeResolver,
  SessionWorktrees,
} from '../../../runtime/src/integrations/session-worktrees.js';
import { ToolCatalog } from '../../../runtime/src/tools/catalog.js';
import {
  openRepositoryWorkspace,
  type RepositoryWorkspace,
} from '../../../runtime/src/repository/workspace.js';
import type { RiedRequest } from '../../../runtime/src/repository/requests.js';
import { createSessionWorktreeTool } from '../../../runtime/src/tools/session-worktree.js';
import { createColgrepProvider } from '../../../runtime/src/repository/providers/colgrep.js';
import { createRepoSearchTool } from '../../../runtime/src/tools/repo-search.js';
import { createRepoLocateTool } from '../../../runtime/src/tools/repo-locate.js';
import { createWebTools, type WebToolService } from '../../../runtime/src/tools/web.js';
import { captureShellEnvironment } from '../../../runtime/src/integrations/shell-environment.js';
import { ConversationRecords } from '../../../runtime/src/session-memory/conversation.js';
import { BugScanService, type BugScanState } from '../../../runtime/src/services/bugscan.js';
import { bugHunterDetailsSchema } from '../../../runtime/src/paseo-plugin/shared/bughunter.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local test port available');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
function snapshotFor(
  nativeAgentId: string,
  readOnly = true,
  sessionId = 'session-1',
  workspaceRoot = '/workspace',
): SessionSnapshot {
  return {
    documentsDirectory: '/runtime/documents',
    planning: [],
    decisions: [],
    session: {
      id: sessionId,
      teamId: 'team-1',
      teamInstanceId: 'instance-1',
      workspaceRoot,
      createdAt: '2026-01-01T00:00:00Z',
    },
    definition: {
      id: 'team-1',
      name: 'Team',
      leaderKey: 'worker',
      routing: {
        design: 'leader',
        'plan.prefill': 'leader',
        'plan.finalize': 'leader',
        'task.execute': 'leader',
      },
      members: [],
      resources: [],
      reviewPolicy: { mode: 'self', reviewerKeys: [], required: false },
    },
    members: [
      {
        member: {
          key: 'worker',
          name: 'Worker',
          lifetime: 'persistent',
          modelAlias: 'smart',
          readOnly,
          roles: ['member'],
          workTypes: ['design', 'plan.prefill', 'plan.finalize', 'task.execute'],
          rules: [],
          skills: [],
        },
        binding: {
          sessionId,
          teamId: 'team-1',
          memberKey: 'worker',
          nativeAgentId,
          workspaceRoot,
          state: 'bound',
        },
        nativeStatus: 'running',
      },
    ],
    passes: [],
    tasks: [],
    steps: [],
    assignments: [],
    reports: [],
    reviews: [],
    approvals: [],
    blockers: [],
  };
}

describe('native runtime boundary', () => {
  test('applies Activity user authority and route validation before runtime readiness', async () => {
    const secret = 'activity-family-secret';
    const nativeAgentId = 'ordinary-agent';
    const api = new RuntimeApi(
      undefined,
      secret,
      `127.0.0.1:${await freePort()}`,
      new SessionActivation(),
    );
    const endpoint = await api.listen();
    const post = (route: string, token: string, input: object) =>
      fetch(`${endpoint}/v1/activity/${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    try {
      const agent = agentBearer(secret, nativeAgentId);
      for (const route of [
        'toggle',
        'services',
        'bughunter',
        'workspace-touch',
        'workspace-services',
        'repository-query',
      ]) {
        const denied = await post(route, agent, { nativeAgentId });
        expect(denied.status).toBe(403);
        expect(await denied.json()).toEqual({});
      }
      expect((await fetch(`${endpoint}/v1/activity/services`)).status).toBe(404);
      expect((await post('workspace-touch', secret, { workspaceId: 'workspace-1' })).status).toBe(
        503,
      );
      expect((await post('workspace-services', secret, {})).status).toBe(503);
      const services = await post('services', secret, { nativeAgentId });
      expect(services.status).toBe(200);
      expect(await services.json()).toMatchObject({
        rag: { availability: 'unavailable', activity: 'unknown', indexingEnabled: null },
      });
    } finally {
      await api.close();
    }
  });

  test('BugHunter history is available only for its configured workspace', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ltcook-bughunter-panel-')));
    directories.push(root);
    const workspaceRoot = join(root, 'repository');
    mkdirSync(workspaceRoot);
    const secret = 'activity-history-fixture';
    const api = new RuntimeApi(
      undefined,
      secret,
      `127.0.0.1:${await freePort()}`,
      new SessionActivation(),
    );
    const scan = new BugScanService({
      logPath: join(root, 'diagnostics'),
      load: (): BugScanState => ({
        cursor: null,
        pending: [],
        hunts: [
          {
            id: 'hunt',
            scope: workspaceRoot,
            createdAt: 1,
            automatic: true,
            status: 'completed',
            groups: [{ id: 'g', component: 'repository-index', evidence: [] }],
            findings: [],
            checkpoints: {},
            elapsedMs: 15,
          },
        ],
      }),
      save: () => undefined,
      scopeFor: () => workspaceRoot,
      resolveSource: async () => undefined,
      investigate: async () => ({ findings: [] }),
    });
    api.setBugScan(scan, workspaceRoot, true);
    const endpoint = await api.listen();
    const history = async (workspaceRoot: string) => {
      const response = await fetch(`${endpoint}/v1/activity/bughunter`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceRoot }),
      });
      expect(response.status).toBe(200);
      return bugHunterDetailsSchema.parse(await response.json());
    };
    try {
      expect(await history(root)).toEqual({ available: false, hunts: [] });
      expect(await history(workspaceRoot)).toEqual({
        available: true,
        enabled: true,
        hunts: [
          {
            id: 'hunt',
            createdAt: 1,
            automatic: true,
            status: 'completed',
            components: ['repository-index'],
            findings: [],
            conversations: [],
          },
        ],
      });
    } finally {
      await api.close();
      await scan.close();
    }
  });

  test('a Query Repo workspace scope holds an index lease until the Runtime API closes', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ltcook-query-workspace-')));
    directories.push(directory);
    const workspace = await openRepositoryWorkspace(directory);
    const secret = 'query-workspace-secret';
    const colgrep = createColgrepProvider({ deploymentDirectory: '' });
    const api = new RuntimeApi(
      undefined,
      secret,
      `127.0.0.1:${await freePort()}`,
      new SessionActivation(),
      {},
      undefined,
      {
        activity: {
          colgrep,
          preferences: new ActivityPreferences(join(directory, 'activity-settings.json')),
        },
      },
    );
    const endpoint = await api.listen();
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= api.close());
    try {
      expect(colgrep.indexService.status(workspace).activity).toBe('idle');
      const scope = await fetch(`${endpoint}/v1/activity/repository-query-workspace`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'workspace-1', workspaceRoot: directory }),
        signal: AbortSignal.timeout(2_000),
      });
      expect(scope.status).toBe(200);
      expect(colgrep.indexService.status(workspace).activity).not.toBe('idle');
      await close();
      expect(await scope.json()).toMatchObject({ path: directory, identity: expect.any(String) });
      expect(colgrep.indexService.status(workspace).activity).toBe('idle');
    } finally {
      await close();
      await colgrep.indexService.close();
    }
  });

  test('trusted native archive releases the managed Session worktree from indexing', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ltcook-index-archive-')));
    directories.push(directory);
    let activate!: (workspace: RepositoryWorkspace) => void;
    const activated = new Promise<RepositoryWorkspace>((resolve) => (activate = resolve));
    let released = false;
    const activation = new SessionActivation(
      {},
      {
        activate(workspace) {
          activate(workspace);
          return () => {
            released = true;
          };
        },
      },
    );
    const agentId = 'managed-index-session';
    const secret = 'archive-fixture';
    const address = `127.0.0.1:${await freePort()}`;
    const api = new RuntimeApi(undefined, secret, address, activation);
    await api.listen();
    try {
      activation.register(directory, agentId, { authorizeRepositoryIndex: true });
      const workspace = await activated;
      const revoke = (token: string) =>
        fetch(`http://${address}/v1/mcp/revoke`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ nativeAgentId: agentId }),
        });
      expect((await revoke(agentBearer(secret, agentId))).status).toBe(403);
      await workspace.assertUnchanged();
      expect((await revoke(secret)).status).toBe(200);
      expect(released).toBe(true);
      await expect(workspace.assertUnchanged()).rejects.toThrow('no longer authorized');
      expect(activation.registeredWorkspace(agentId)).toBe(directory);
    } finally {
      await api.close();
    }
  });

  test('records workspace use only with user authority and rejects client timestamps', async () => {
    const secret = 'workspace-service-secret';
    const nativeAgentId = 'ordinary-agent';
    const activity: string[] = [];
    const serviceStatus = {
      enabled: true,
      running: false,
      lastRunAt: null,
      lastSuccessAt: null,
      processed: 0,
    };
    const status = {
      organizer: serviceStatus,
      renamer: serviceStatus,
      autoArchive: true,
      renameWorkspaces: false,
      renameTabs: true,
      archiveBlocked: [{ workspaceId: 'protected', reason: 'Checkout has unpreserved files.' }],
    };
    const api = new RuntimeApi(
      undefined,
      secret,
      `127.0.0.1:${await freePort()}`,
      new SessionActivation(),
    );
    api.setWorkspaceServices({
      async recordActivity(workspaceId: string) {
        await Promise.resolve();
        activity.push(workspaceId);
      },
      status: () => status,
    } as unknown as PaseoWorkspaceServices);
    const endpoint = await api.listen();
    const post = (route: string, token: string, input: object) =>
      fetch(`${endpoint}/v1/activity/${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    try {
      expect(
        (await post('workspace-touch', 'invalid', { workspaceId: 'workspace-1' })).status,
      ).toBe(401);
      expect(
        (
          await post('workspace-touch', agentBearer(secret, nativeAgentId), {
            nativeAgentId,
            workspaceId: 'workspace-1',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await post('workspace-touch', secret, {
            workspaceId: 'workspace-1',
            lastActivityAt: Date.now(),
          })
        ).status,
      ).toBe(400);
      expect((await post('workspace-touch', secret, { workspaceId: '' })).status).toBe(400);
      expect(activity).toEqual([]);

      const recorded = await post('workspace-touch', secret, { workspaceId: 'workspace-1' });
      expect(recorded.status).toBe(200);
      expect(await recorded.json()).toEqual({ recorded: true });
      expect(activity).toEqual(['workspace-1']);
      const read = await post('workspace-services', secret, {});
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(status);
      expect(activity).toEqual(['workspace-1']);
      expect((await post('workspace-services', secret, { enabled: false })).status).toBe(400);
    } finally {
      await api.close();
    }
  });

  test('persistently applies Activity switches only on authenticated user requests', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-activity-controls-'));
    directories.push(directory);
    const preferences = join(directory, 'activity-settings.json');
    const secret = 'activity-control-secret';
    const colgrep = createColgrepProvider({ deploymentDirectory: '' });
    const first = new RuntimeApi(
      undefined,
      secret,
      `127.0.0.1:${await freePort()}`,
      new SessionActivation({}),
      {},
      undefined,
      {
        activity: { colgrep, preferences: new ActivityPreferences(preferences) },
      },
    );
    const endpoint = await first.listen();
    const change = (body: object, token = secret) =>
      fetch(`${endpoint}/v1/activity/toggle`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const denied = await change(
        { nativeAgentId: 'worker', feature: 'rag-index', enabled: false },
        agentBearer(secret, 'worker'),
      );
      expect(denied.status).toBe(403);
      expect(colgrep.isIndexingEnabled()).toBe(true);
      const response = await change({ feature: 'rag-index', enabled: false });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ enabled: false });
      expect(colgrep.isIndexingEnabled()).toBe(false);
      const restoredColgrep = createColgrepProvider({ deploymentDirectory: '' });
      const restored = new RuntimeApi(
        undefined,
        secret,
        '127.0.0.1:0',
        new SessionActivation({}),
        {},
        undefined,
        {
          activity: { colgrep: restoredColgrep, preferences: new ActivityPreferences(preferences) },
        },
      );
      expect(restoredColgrep.isIndexingEnabled()).toBe(false);
    } finally {
      await first.close();
    }
  });

  test('shows reported worktrees in the authenticated Session view', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ltcook-native-worktree-')));
    directories.push(directory);
    const workspaceRoot = join(directory, 'repository');
    const checkout = join(directory, 'linked');
    mkdirSync(workspaceRoot);
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'core.hooksPath=',
          ...args,
        ],
        { cwd: workspaceRoot, stdio: 'pipe' },
      );
    git('init', '-qb', 'main');
    git('commit', '--allow-empty', '--no-gpg-sign', '-qm', 'Fixture');
    git('worktree', 'add', '-qb', 'fixture-linked', checkout);

    const secret = 'worktree-user-secret';
    const agentId = 'bound-worktree-agent';
    const sessionId = 'session-1';
    const snapshot = snapshotFor(agentId, false, sessionId, workspaceRoot);
    const store = new SessionWorktrees(process.env.PATH ?? '');
    const resolveScope = createWorktreeScopeResolver((id) =>
      id === sessionId ? snapshot : undefined,
    );
    const report = createSessionWorktreeTool(store, resolveScope);
    const api = new RuntimeApi(
      undefined,
      secret,
      `127.0.0.1:${await freePort()}`,
      new SessionActivation({}),
      {},
      undefined,
      {
        worktrees: { store, resolveScope },
      },
    );
    const endpoint = await api.listen();
    const read = (nativeAgentId: string, token = secret) =>
      fetch(`${endpoint}/v1/session/worktrees`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ nativeAgentId, workspaceRoot: directory, sessionId }),
      });
    try {
      const context = {
        agentId,
        workspaceRoot: directory,
        sessionId,
        workspaceFileAccess: false,
        signal: new AbortController().signal,
      };
      await expect(
        report.invoke({ operation: 'use', path: checkout, passId: 'foreign-pass' }, context),
      ).rejects.toThrow('The Pass does not belong to this session.');
      await report.invoke({ operation: 'use', path: checkout }, context);
      expect((await read(agentId, agentBearer(secret, agentId))).status).toBe(403);
      expect((await read('unbound-agent')).status).toBe(400);
      const response = await read(agentId);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        original: workspaceRoot,
        following: { path: checkout, branch: 'fixture-linked' },
      });
      await report.invoke({ operation: 'release', path: checkout }, context);
      expect(await (await read(agentId)).json()).toMatchObject({ following: null });
    } finally {
      await api.close();
    }
  });

  test('separates authenticated user authority from native-ID-bound agent authority', async () => {
    const master = 'test-master-secret';
    const nativeAgentId = 'paseo-agent-42';
    const actors: RuntimeActor[] = [];
    const controller = {
      openSession: async () => snapshotFor(nativeAgentId, false),
      snapshot: () => snapshotFor(nativeAgentId, false),
      execute: async (_session: string, actor: RuntimeActor) => {
        actors.push(actor);
        return actor;
      },
      close: async () => undefined,
    } as RuntimeController;
    const activation = new SessionActivation();
    const api = new RuntimeApi(controller, master, `127.0.0.1:${await freePort()}`, activation);
    activation.register('/workspace', 'session-1');
    const endpoint = await api.listen();
    try {
      const command = {
        type: 'task.create',
        title: 'Task',
        description: 'Work',
        acceptance: 'Done',
      };
      const userResponse = await fetch(`${endpoint}/v1/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${master}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', nativeAgentId, command }),
      });
      expect(userResponse.status).toBe(200);
      expect(((await userResponse.json()) as { value: RuntimeActor }).value).toEqual({
        kind: 'user',
      });
      const inactiveUserResponse = await fetch(`${endpoint}/v1/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${master}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'inactive-session', command }),
      });
      expect(inactiveUserResponse.status).toBe(403);

      const agentResponse = await fetch(`${endpoint}/v1/command`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${agentBearer(master, nativeAgentId)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionId: 'session-1', nativeAgentId, command }),
      });
      expect(agentResponse.status).toBe(200);
      expect(((await agentResponse.json()) as { value: RuntimeActor }).value).toEqual({
        kind: 'agent',
        nativeAgentId,
      });

      const wrongId = await fetch(`${endpoint}/v1/command`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${agentBearer(master, 'other-agent')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionId: 'session-1', nativeAgentId, command }),
      });
      expect(wrongId.status).toBe(401);

      const snapshotResponse = await fetch(`${endpoint}/v1/snapshot`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${agentBearer(master, nativeAgentId)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionId: 'session-1', nativeAgentId }),
      });
      expect(snapshotResponse.status).toBe(200);
      expect(actors).toHaveLength(2);
    } finally {
      await api.close();
    }
  });
  test('managed workspace tools enforce runtime authorization before invoking the catalog', async () => {
    const master = 'test-master';
    const nativeAgentId = 'bound-web-agent';
    let allowed = false;
    let authorized = 0;
    let invoked = 0;
    const controller = {
      snapshot() {
        throw new Error('Managed tool authorization must not read a Session snapshot');
      },
      authorizeWorkspaceTool(sessionId: string, agentId: string) {
        authorized++;
        if (sessionId !== 'session-1' || agentId !== nativeAgentId)
          return { allowed: false, unbound: true, reason: 'Native identity is not bound' };
        return allowed
          ? { allowed: true, workspaceRoot: process.cwd(), reason: 'Authorized' }
          : { allowed: false, reason: 'Tool budget exhausted' };
      },
    } as unknown as RuntimeController;
    const authority = `127.0.0.1:${await freePort()}`;
    const api = new RuntimeApi(undefined, master, authority, new SessionActivation());
    const searchResult = {
      content: 'Search result',
      responseId: 'search-result',
      queries: [
        {
          query: 'release evidence',
          sources: [{ title: 'Official release', url: 'https://example.org/release', snippet: '' }],
        },
      ],
    };
    const service = {
      async call() {
        invoked++;
        return searchResult;
      },
    } as unknown as WebToolService;
    const repositorySearch = createRepoSearchTool(
      createColgrepProvider({ deploymentDirectory: '' }),
    );
    const tools = new ToolCatalog([
      ...createWebTools(service),
      repositorySearch,
      createRepoLocateTool(repositorySearch),
    ]);
    const endpoint = await api.listen();
    const call = (agentId: string = nativeAgentId, toolName = 'ltcook_web_search') =>
      fetch(`${endpoint}/v1/workspace-tool`, {
        method: 'POST',
        headers: { authorization: `Bearer ${agentBearer(master, agentId)}` },
        body: JSON.stringify({
          sessionId: 'session-1',
          nativeAgentId: agentId,
          toolName,
          toolArgs: { query: 'release evidence' },
        }),
      });
    try {
      const preReady = await call();
      expect(preReady.status).toBe(503);
      expect(await preReady.json()).toEqual({ error: 'LTCook runtime is not ready' });
      api.setRuntime(controller);
      const noCatalog = await call();
      expect(noCatalog.status).toBe(403);
      expect(await noCatalog.text()).toBe('{}');
      expect(authorized).toBe(0);
      api.setWorkspaceTools(tools);

      const denied = await call();
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: 'Tool budget exhausted' });
      expect(authorized).toBe(1);
      expect(invoked).toBe(0);
      allowed = true;
      expect((await call('unbound')).status).toBe(403);
      expect(invoked).toBe(0);
      expect(await (await call()).json()).toEqual(searchResult);
      expect(authorized).toBe(3);
      expect(invoked).toBe(1);
      const search = await call(nativeAgentId, 'ltcook_repo_search');
      expect(search.status).toBe(200);
      expect(await search.json()).toMatchObject({
        status: 'unavailable',
        provider: 'colgrep',
        partial: true,
        diagnostics: [
          {
            source: 'colgrep',
            code: 'unavailable',
            message: expect.stringMatching(/ColGREP.*setup/i),
          },
        ],
      });
      expect(await (await call('unbound', 'ltcook_repo_search')).text()).toBe('{}');
      expect(authorized).toBe(5);
      const locate = await call(nativeAgentId, 'ltcook_repo_locate');
      expect(locate.status).toBe(200);
      expect(await locate.json()).toMatchObject({
        followUp: 'initial-unavailable',
        searches: [{ mode: 'hybrid', status: 'unavailable', provider: 'colgrep' }],
      });
      expect((await call('unbound', 'ltcook_repo_locate')).status).toBe(403);
      expect(authorized).toBe(7);
    } finally {
      await api.close();
    }
  });
  test('Session RIED requires a current agent binding or a registered user Session', async () => {
    const master = 'ried-user-secret';
    const nativeAgentId = 'ried-native-agent';
    const snapshot = snapshotFor(nativeAgentId);
    const calls: Array<{ sessionId: string; request: RiedRequest }> = [];
    const inventory = { provider: 'ried' };
    const controller = {
      snapshot: () => snapshot,
      async ried(sessionId: string, request: RiedRequest) {
        calls.push({ sessionId, request });
        return inventory;
      },
    } as RuntimeController;
    const activation = new SessionActivation();
    const api = new RuntimeApi(controller, master, `127.0.0.1:${await freePort()}`, activation);
    const endpoint = await api.listen();
    const call = (bearer: string, id = nativeAgentId, request: object = { operation: 'summary' }) =>
      fetch(`${endpoint}/v1/ried`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify({
          sessionId: snapshot.session.id,
          nativeAgentId: id,
          ...request,
        }),
      });
    try {
      const inactive = await call(master);
      expect(inactive.status).toBe(403);
      expect(await inactive.json()).toEqual({ error: 'session is not active in this runtime' });
      const unbound = await call(agentBearer(master, 'unbound'), 'unbound');
      expect(unbound.status).toBe(403);
      expect(await unbound.json()).toEqual({ error: 'native agent is not bound to this session' });
      expect(calls).toEqual([]);

      const bearer = agentBearer(master, nativeAgentId);
      expect((await call(bearer, nativeAgentId, { operation: 'invalid' })).status).toBe(400);
      const agentResult = await call(bearer);
      expect(agentResult.status).toBe(200);
      expect(await agentResult.json()).toEqual({ value: inventory });

      activation.register(snapshot.session.workspaceRoot, snapshot.session.id);
      const userResult = await call(master);
      expect(userResult.status).toBe(200);
      expect(await userResult.json()).toEqual({ value: inventory });
      expect(calls).toEqual([
        { sessionId: snapshot.session.id, request: { operation: 'summary' } },
        { sessionId: snapshot.session.id, request: { operation: 'summary' } },
      ]);
    } finally {
      await api.close();
    }
  });
  test('evaluation context confirms only a bound agent and an actual running scope', async () => {
    const master = 'evaluation-scope-secret';
    const nativeAgentId = 'evaluation-native-agent';
    const snapshot = snapshotFor(nativeAgentId);
    snapshot.passes.push({
      id: 'actual-pass',
      sessionId: 'session-1',
      title: 'Scenario',
      status: 'running',
      revision: 1,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const controller = { snapshot: () => snapshot } as RuntimeController;
    const api = new RuntimeApi(
      controller,
      master,
      `127.0.0.1:${await freePort()}`,
      new SessionActivation(),
    );
    const endpoint = await api.listen();
    const request = (bearer = agentBearer(master, nativeAgentId), id = nativeAgentId) =>
      fetch(`${endpoint}/v1/evaluation/observe`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'session-1',
          nativeAgentId: id,
          kind: 'scope.request',
          passId: 'caller-chosen-pass',
        }),
      });
    try {
      expect((await request()).status).toBe(403);
      let callbacks = 0;
      let scope = { sessionId: 'session-1', passId: 'actual-pass' };
      api.setEvaluationObserver((_id, value) => {
        callbacks++;
        if (value.kind === 'scope.request') return scope;
      });
      expect((await request('wrong-token')).status).toBe(401);
      expect((await request(master)).status).toBe(403);
      expect((await request(agentBearer(master, 'unbound'), 'unbound')).status).toBe(403);
      expect(callbacks).toBe(0);
      const valid = await request();
      expect(valid.status).toBe(200);
      expect(await valid.json()).toEqual({ evaluationScope: scope });
      scope = { sessionId: 'another-session', passId: 'actual-pass' };
      expect((await request()).status).toBe(403);
      scope = { sessionId: 'session-1', passId: 'caller-chosen-pass' };
      expect((await request()).status).toBe(403);
      scope = { sessionId: 'session-1', passId: 'actual-pass' };
      snapshot.passes[0]!.status = 'completed';
      expect((await request()).status).toBe(403);
      snapshot.passes[0]!.status = 'running';
      snapshot.members[0]!.binding!.state = 'closed';
      expect((await request()).status).toBe(403);
    } finally {
      await api.close();
    }
  });

  test('persists an assigned readonly report through the authenticated HTTP boundary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-runtime-api-'));
    directories.push(directory);
    const nativeAgents = new Map<string, { id: string; status: string }>();
    const agents: AgentBackend = {
      async list() {
        return [...nativeAgents.values()];
      },
      async create({ member }) {
        const agent = { id: `native-${member.key}`, status: 'running' };
        nativeAgents.set(agent.id, agent);
        return agent;
      },
      async inspect(id) {
        return nativeAgents.get(id) ?? null;
      },
      async send() {},
      async close(id) {
        nativeAgents.delete(id);
      },
    };
    const reviewPolicy = { mode: 'self' as const, reviewerKeys: [] as string[], required: false };
    const team: TeamPackage = {
      apiVersion: 3,
      definition: {
        id: 'native-api-test-team',
        name: 'Native API test team',
        leaderKey: 'leader',
        routing: {
          design: 'leader',
          'plan.prefill': 'leader',
          'plan.finalize': 'leader',
          'task.execute': 'leader',
        },
        members: [
          {
            key: 'leader',
            name: 'Leader',
            lifetime: 'persistent',
            modelAlias: 'smart',
            readOnly: false,
            roles: ['leader'],
            workTypes: ['design', 'plan.prefill', 'plan.finalize', 'task.execute'],
            rules: [],
            skills: [],
          },
          {
            key: 'explorer',
            name: 'Explorer',
            lifetime: 'persistent',
            modelAlias: 'smol',
            readOnly: true,
            roles: ['member'],
            workTypes: ['design', 'plan.prefill', 'plan.finalize', 'task.execute'],
            rules: [],
            skills: [],
          },
        ],
        resources: [],
        reviewPolicy,
      },
    };
    const runtime = createRuntime({
      databasePath: join(directory, 'coordination.sqlite'),
      team,
      agents,
    });
    let api: RuntimeApi | undefined;
    try {
      const opened = await runtime.openSession({
        id: 'report-session',
        workspaceRoot: '/workspace',
      });
      const task = (await runtime.execute(
        opened.session.id,
        { kind: 'user' },
        {
          type: 'task.create',
          title: 'Explore',
          workType: 'task.investigate',
          description: 'Inspect files',
          acceptance: 'Report findings',
        },
      )) as { id: string };
      const assignment = (await runtime.execute(
        opened.session.id,
        { kind: 'user' },
        {
          type: 'assignment.create',
          taskId: task.id,
          memberKey: 'explorer',
          message: 'Inspect the workspace',
        },
      )) as { id: string };
      const nativeAgentId = runtime
        .snapshot(opened.session.id)
        .members.find((member) => member.member.key === 'explorer')?.binding?.nativeAgentId;
      if (!nativeAgentId) throw new Error('Readonly explorer was not bound');
      api = new RuntimeApi(
        runtime,
        'readonly-report-user-secret',
        `127.0.0.1:${await freePort()}`,
        new SessionActivation(),
      );
      const endpoint = await api.listen();
      const denied = await fetch(`${endpoint}/v1/tool/authorize`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${agentBearer('readonly-report-user-secret', nativeAgentId)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: opened.session.id,
          nativeAgentId,
          toolName: 'write',
          input: { path: 'project.ts' },
        }),
      });
      expect(denied.status).toBe(200);
      expect(((await denied.json()) as { allowed: boolean }).allowed).toBe(false);
      const post = (command: unknown) =>
        fetch(`${endpoint}/v1/command`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${agentBearer('readonly-report-user-secret', nativeAgentId)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ sessionId: opened.session.id, nativeAgentId, command }),
        });

      const report = {
        type: 'report.create',
        assignmentId: assignment.id,
        summary: 'Found relevant files',
        evidence: 'Inspected source tree',
      };
      const reportResponse = await post(report);
      expect(reportResponse.status).toBe(200);
      expect(runtime.snapshot(opened.session.id).reports.map((value) => value.summary)).toEqual([
        'Found relevant files',
      ]);
      expect(runtime.snapshot(opened.session.id).assignments[0]?.status).toBe('reported');

      const schedulerResponse = await post({
        type: 'task.create',
        title: 'Unauthorized',
        description: 'Schedule work',
        acceptance: 'Never',
      });
      expect(schedulerResponse.status).toBe(400);
      expect(runtime.snapshot(opened.session.id).tasks).toHaveLength(1);
    } finally {
      await api?.close();
      await runtime.close();
    }
  });

  test('rejects malformed original-shell provenance without exposing its contents', () => {
    expect(() => captureShellEnvironment({ LTCOOK_SHELL_PROVENANCE: '{' })).toThrow(
      'LTCOOK_SHELL_PROVENANCE is not an environment mapping',
    );
    expect(
      captureShellEnvironment({
        LTCOOK_SHELL_PROVENANCE: JSON.stringify({
          A: 'original',
          LTCOOK_SHELL_PROVENANCE: 'nested',
        }),
        A: 'merged',
      }),
    ).toEqual({ A: 'original' });
  });
  test('stops on the authenticated idle route only after Paseo commits', async () => {
    const activation = new SessionActivation();
    const api = new RuntimeApi(undefined, 'owner', `127.0.0.1:${await freePort()}`, activation);
    const endpoint = await api.listen();
    const stopFinished = Promise.withResolvers<void>();
    let attempt = 0;
    let released = 0;
    let stopCalls = 0;
    let observing = 0;
    const observationsAtCommit: number[] = [];
    const records = new ConversationRecords({
      databasePath: ':memory:',
      source: {
        async read() {
          return { epoch: 'idle', latest: -1, through: -1, reset: false, messages: [] };
        },
        watch() {
          observing++;
          return async () => {
            observing--;
          };
        },
      },
    });
    records.turn('agent', { turnId: 'completed-turn', outcome: 'completed' });
    await records.settled();
    api.setConversationRecords(records);
    activation.setWorkspaceActivator(async () => {
      throw new Error('lifecycle does not open a session');
    });
    api.setLifecycle(
      {
        instanceId: 'runtime-1',
        deploymentRoot: '/deployment',
        databasePath: '/deployment/runtime.db',
        paseoListen: '127.0.0.1:4312',
        backendLogPath: null,
        paseoLogPath: '/deployment/paseo.log',
        telemetryLogPath: '/deployment/events.jsonl',
        buildFingerprint: 'installed-build',
      },
      async () => {
        stopCalls += 1;
        stopFinished.resolve();
      },
      async () => {
        attempt += 1;
        if (attempt === 1) return { status: 'busy', activeTurns: 3 };
        return {
          status: 'reserved',
          async release() {
            released += 1;
          },
          async commit() {
            observationsAtCommit.push(observing);
            if (attempt === 2) throw new Error('Could not commit');
            return { status: 'committed' };
          },
        };
      },
    );
    const stop = (token: string, instanceId = 'runtime-1') =>
      fetch(`${endpoint}/v1/runtime/stop`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId, whenIdle: true }),
      });
    try {
      const status = await fetch(`${endpoint}/v1/status`, {
        headers: { authorization: 'Bearer owner' },
      });
      expect(await status.json()).toMatchObject({
        idleRestart: true,
        buildFingerprint: 'installed-build',
      });
      expect((await stop(agentBearer('owner', 'agent'))).status).toBe(401);
      expect((await stop('owner', 'stale-instance')).status).toBe(409);
      expect(attempt).toBe(0);
      const busy = await stop('owner');
      expect(busy.status).toBe(423);
      expect(await busy.json()).toEqual({ status: 'busy', activeTurns: 3 });
      expect(observing).toBe(1);
      expect((await stop('owner')).status).toBe(503);
      expect(released).toBe(1);
      expect(observing).toBe(1);
      expect(stopCalls).toBe(0);
      expect((await stop('owner')).status).toBe(202);
      await stopFinished.promise;
      expect(stopCalls).toBe(1);
      expect(released).toBe(1);
      expect(observationsAtCommit).toEqual([0, 0]);
      expect(observing).toBe(0);
    } finally {
      await records.close();
      await api.close();
    }
  });

  test('requires user authentication and readiness for runtime status', async () => {
    const master = 'test-master-secret';
    const activation = new SessionActivation();
    const api = new RuntimeApi(undefined, master, `127.0.0.1:${await freePort()}`, activation);
    const endpoint = await api.listen();
    try {
      expect(
        (
          await fetch(`${endpoint}/v1/status`, {
            headers: { authorization: `Bearer ${master}` },
          })
        ).status,
      ).toBe(503);
      expect(
        (
          await fetch(`${endpoint}/v1/status`, {
            headers: { authorization: 'Bearer wrong-token' },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${endpoint}/v1/status`, {
            headers: { authorization: `Bearer ${agentBearer(master, 'native-agent')}` },
          })
        ).status,
      ).toBe(401);
      let stopCalls = 0;
      const stopFinished = Promise.withResolvers<void>();
      api.setLifecycle(
        {
          instanceId: 'runtime-1',
          deploymentRoot: '/deployment',
          databasePath: '/deployment/runtime.db',
          paseoListen: '127.0.0.1:4312',
          backendLogPath: null,
          paseoLogPath: '/deployment/paseo.log',
          telemetryLogPath: '/deployment/events.jsonl',
        },
        async () => {
          stopCalls += 1;
          stopFinished.resolve();
        },
      );
      const readyBeforeHandler = await fetch(`${endpoint}/v1/status`, {
        headers: { authorization: `Bearer ${master}` },
      });
      const stopBeforeHandler = await fetch(`${endpoint}/v1/runtime/stop`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${master}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ instanceId: 'runtime-1' }),
      });
      expect(stopBeforeHandler.status).toBe(503);
      expect(readyBeforeHandler.status).toBe(503);
      activation.setWorkspaceActivator(async () => {
        throw new Error('status does not open a session');
      });
      const ready = await fetch(`${endpoint}/v1/status`, {
        headers: { authorization: `Bearer ${master}` },
      });
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({
        instanceId: 'runtime-1',
        deploymentRoot: '/deployment',
        databasePath: '/deployment/runtime.db',
        paseoListen: '127.0.0.1:4312',
        backendLogPath: null,
        paseoLogPath: '/deployment/paseo.log',
        telemetryLogPath: '/deployment/events.jsonl',
      });
      const stop = (token: string, body: string) =>
        fetch(`${endpoint}/v1/runtime/stop`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body,
        });
      const post = (url: string, token: string, body: object) =>
        fetch(`${endpoint}${url}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      const openBeforeCore = await post('/v1/session/open', master, {});
      expect(openBeforeCore.status).toBe(503);
      expect(await openBeforeCore.json()).toEqual({
        error: 'Runtime session activation is not ready',
      });
      expect((await stop(master, '{')).status).toBe(400);
      expect((await stop(agentBearer(master, 'native-agent'), '{}')).status).toBe(401);
      expect((await stop(master, JSON.stringify({ instanceId: 'stale-runtime' }))).status).toBe(
        409,
      );
      expect((await stop(master, JSON.stringify({ instanceId: '' }))).status).toBe(400);
      const accepted = await stop(master, JSON.stringify({ instanceId: 'runtime-1' }));
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toEqual({ stopping: true });
      await stopFinished.promise;
      expect(stopCalls).toBe(1);
      expect(
        (
          await fetch(`${endpoint}/v1/status`, {
            headers: { authorization: `Bearer ${master}` },
          })
        ).status,
      ).toBe(503);
      const sessionOpen = await post('/v1/session/open', master, {
        workspaceRoot: '/workspace',
        sessionId: 'session-during-stop',
        teamSelection: 'default-minimal',
      });
      expect(sessionOpen.status).toBe(503);
      expect(await sessionOpen.json()).toEqual({ error: 'LTCook runtime is stopping' });
      const agentOpen = await post('/v1/session/open', agentBearer(master, 'native-agent'), {
        nativeAgentId: 'native-agent',
      });
      expect(agentOpen.status).toBe(403);
      const command = {
        type: 'task.create',
        title: 'Task',
        description: 'Work',
        acceptance: 'Done',
      };
      expect((await post('/v1/command', master, { sessionId: 'session-1', command })).status).toBe(
        503,
      );
      expect(
        (await post('/v1/command', 'wrong-token', { sessionId: 'session-1', command })).status,
      ).toBe(401);
    } finally {
      await api.close();
    }
  });
  test('coalesces pending Session opens and rejects a conflicting workspace', async () => {
    const activation = new SessionActivation({});
    const nativeOpen = Promise.withResolvers<SessionSnapshot>();
    const request = {
      workspaceRoot: '/workspace',
      sessionId: 'opening-session',
      teamSelection: 'default-minimal',
    };
    const snapshot = snapshotFor('native-agent', true, request.sessionId, request.workspaceRoot);
    const runtime: Pick<RuntimeController, 'snapshot' | 'teamCatalog'> = {
      snapshot: () => snapshot,
      teamCatalog: () => [
        {
          origin: 'bundled',
          selection: request.teamSelection,
          teamId: snapshot.session.teamId,
          name: snapshot.definition.name,
          description: '',
          status: 'installed',
          leader: { key: 'worker', name: 'Worker' },
          persistentMembers: 1,
          temporaryMembers: 0,
        },
      ],
    };
    let nativeOpens = 0;
    activation.setWorkspaceActivator(() => {
      nativeOpens++;
      return nativeOpen.promise;
    });

    const results = Promise.all([
      activation.open(runtime, request),
      activation.open(runtime, request),
      activation.open(runtime, { ...request, workspaceRoot: '/other-workspace' }),
    ]);
    const workspaceBeforeOpen = activation.registeredWorkspace(request.sessionId);
    nativeOpen.resolve(snapshot);

    expect(await results).toEqual([
      { snapshot },
      { snapshot },
      { conflict: 'Session initialization is already requested for a different workspace' },
    ]);
    expect(nativeOpens).toBe(1);
    expect(workspaceBeforeOpen).toBeUndefined();
    expect(activation.registeredWorkspace(request.sessionId)).toBe(request.workspaceRoot);
  });
  test('opens same-team Sessions across projects with single-flight and authority boundaries', async () => {
    const master = 'test-master-secret';
    const shellEnvironment = {
      LTCOOK_API_TOKEN: 'original-shell-token',
      LTCOOK_TEAM: 'default-minimal',
    };
    const opened: Array<{
      workspaceRoot: string;
      sessionId: string;
      teamSelection: string;
      shellEnvironment: Record<string, string>;
    }> = [];
    const snapshots = new Map<string, SessionSnapshot>();
    const controller = {
      teamCatalog() {
        return [{ selection: 'default-minimal', teamId: 'team-1', status: 'installed' }];
      },
      snapshot(sessionId: string) {
        const snapshot = snapshots.get(sessionId);
        if (!snapshot) throw new Error('unknown session');
        return snapshot;
      },
      execute: async () => undefined,
    } as unknown as RuntimeController;
    const startupEnvironment = {
      LTCOOK_SHELL_PROVENANCE: JSON.stringify({
        LTCOOK_API_TOKEN: 'original-shell-token',
        LTCOOK_TEAM: 'default-minimal',
        ORIGINAL_ONLY: 'startup',
      }),
      LTCOOK_TEAM: 'merged-project-team',
    };
    const activation = new SessionActivation(startupEnvironment);
    const api = new RuntimeApi(
      controller,
      master,
      `127.0.0.1:${await freePort()}`,
      activation,
      startupEnvironment,
    );
    activation.setWorkspaceActivator(async (request) => {
      opened.push(request);
      const snapshot = snapshotFor(
        `native-${request.sessionId}`,
        true,
        request.sessionId,
        request.workspaceRoot,
      );
      snapshots.set(request.sessionId, snapshot);
      return snapshot;
    });
    const endpoint = await api.listen();
    const post = (token: string, body: unknown) =>
      fetch(`${endpoint}/v1/session/open`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const first = {
      workspaceRoot: '/new-workspace',
      sessionId: 'workspace-session',
      teamSelection: 'default-minimal',
    };
    const second = {
      ...first,
      workspaceRoot: '/second-workspace',
      sessionId: 'workspace-session-2',
      shellEnvironment: { ...shellEnvironment, ORIGINAL_ONLY: 'cli-session' },
    };
    try {
      const firstResponses = await Promise.all([post(master, first), post(master, first)]);
      expect(firstResponses.map((response) => response.status)).toEqual([200, 200]);
      expect(await Promise.all(firstResponses.map((response) => response.json()))).toEqual([
        {
          sessionId: first.sessionId,
          workspaceRoot: first.workspaceRoot,
          teamId: 'team-1',
          teamInstanceId: 'instance-1',
          leaderAgentId: `native-${first.sessionId}`,
        },
        {
          sessionId: first.sessionId,
          workspaceRoot: first.workspaceRoot,
          teamId: 'team-1',
          teamInstanceId: 'instance-1',
          leaderAgentId: `native-${first.sessionId}`,
        },
      ]);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.shellEnvironment).toEqual({
        LTCOOK_API_TOKEN: 'original-shell-token',
        LTCOOK_TEAM: 'default-minimal',
        ORIGINAL_ONLY: 'startup',
      });
      expect((await post(master, second)).status).toBe(200);
      expect(opened).toHaveLength(2);
      expect(opened[1]?.shellEnvironment).toEqual(second.shellEnvironment);
      expect(snapshots.get(first.sessionId)?.session.teamInstanceId).toBe(
        snapshots.get(second.sessionId)?.session.teamInstanceId,
      );
      expect(snapshots.get(first.sessionId)?.members[0]?.binding?.nativeAgentId).not.toBe(
        snapshots.get(second.sessionId)?.members[0]?.binding?.nativeAgentId,
      );
      expect((await post(master, { ...first, workspaceRoot: '/other-workspace' })).status).toBe(
        409,
      );
      const noSessionResponse = await fetch(`${endpoint}/v1/snapshot`, {
        method: 'POST',
        headers: { authorization: `Bearer ${master}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceRoot: '/not-open' }),
      });
      expect(noSessionResponse.status).toBe(404);
      expect(await noSessionResponse.json()).toEqual({
        error: 'No session found for workspace',
        code: 'SESSION_NOT_FOUND',
      });
      const snapshotResponse = await fetch(`${endpoint}/v1/snapshot`, {
        method: 'POST',
        headers: { authorization: `Bearer ${master}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceRoot: second.workspaceRoot,
          sessionId: second.sessionId,
        }),
      });
      expect(snapshotResponse.status).toBe(200);
      expect(((await snapshotResponse.json()) as SessionSnapshot).session.id).toBe(
        second.sessionId,
      );
      const wrongWorkspaceSnapshot = await fetch(`${endpoint}/v1/snapshot`, {
        method: 'POST',
        headers: { authorization: `Bearer ${master}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceRoot: '/other-workspace', sessionId: second.sessionId }),
      });
      expect(wrongWorkspaceSnapshot.status).toBe(400);
      const crossSessionAgentSnapshot = await fetch(`${endpoint}/v1/snapshot`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${agentBearer(master, `native-${first.sessionId}`)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: second.sessionId,
          nativeAgentId: `native-${first.sessionId}`,
        }),
      });
      expect(crossSessionAgentSnapshot.status).toBe(400);
      expect((await post(master, { ...first, teamSelection: 'different-team' })).status).toBe(400);
      expect(
        (
          await post(agentBearer(master, 'native-agent'), {
            ...first,
            nativeAgentId: 'native-agent',
          })
        ).status,
      ).toBe(403);
      expect(opened).toHaveLength(2);
    } finally {
      await api.close();
    }
  });
  test('retries requested-session initialization after a transient failure', async () => {
    const master = 'test-master-secret';
    let attempts = 0;
    let snapshot: SessionSnapshot | undefined;
    const controller = {
      teamCatalog() {
        return [{ selection: 'default-minimal', teamId: 'team-1', status: 'installed' }];
      },
      snapshot(sessionId: string) {
        if (!snapshot || snapshot.session.id !== sessionId) throw new Error('unknown session');
        return snapshot;
      },
    } as unknown as RuntimeController;
    const activation = new SessionActivation();
    const api = new RuntimeApi(controller, master, `127.0.0.1:${await freePort()}`, activation);
    activation.setWorkspaceActivator(async (request) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary activation failure');
      snapshot = snapshotFor('native-agent', true, request.sessionId, request.workspaceRoot);
      return snapshot;
    });
    const endpoint = await api.listen();
    const request = {
      workspaceRoot: '/retry-workspace',
      sessionId: 'retry-session',
      teamSelection: 'default-minimal',
      shellEnvironment: {},
    };
    const post = () =>
      fetch(`${endpoint}/v1/session/open`, {
        method: 'POST',
        headers: { authorization: `Bearer ${master}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    try {
      expect((await post()).status).toBe(400);
      expect((await post()).status).toBe(200);
      expect(attempts).toBe(2);
    } finally {
      await api.close();
    }
  });
  test('validates and dispatches the native team.close command', async () => {
    const master = 'test-master-secret';
    const nativeAgentId = 'coordinator-agent';
    const sent: unknown[] = [];
    const controller = {
      snapshot: () => snapshotFor(nativeAgentId, false),
      execute: async (_session: string, _actor: RuntimeActor, command: unknown) => {
        sent.push(command);
        return command;
      },
    } as unknown as RuntimeController;
    const api = new RuntimeApi(
      controller,
      master,
      `127.0.0.1:${await freePort()}`,
      new SessionActivation(),
    );
    const endpoint = await api.listen();
    const post = (command: unknown) =>
      fetch(`${endpoint}/v1/command`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${agentBearer(master, nativeAgentId)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionId: 'session-1', nativeAgentId, command }),
      });
    const command = { type: 'team.close', memberKey: 'temporary-reviewer' };
    try {
      const response = await post(command);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { value: unknown }).value).toEqual(command);
      expect(sent).toEqual([command]);
      expect((await post({ type: 'team.close' })).status).toBe(400);
      expect((await post({ type: 'pass.create', title: 'Pass', extra: true })).status).toBe(400);
      expect(
        (
          await post({
            type: 'task.create',
            title: 'Task',
            description: 'Work',
            acceptance: 'Done',
            passTitle: 'legacy',
          })
        ).status,
      ).toBe(400);
      expect(sent).toHaveLength(1);
    } finally {
      await api.close();
    }
  });

  test('projects task titles, Pass and ordered Step progress without private work content', () => {
    const snapshot = snapshotFor('paseo-agent-42');
    snapshot.passes.push({
      id: 'pass-1',
      sessionId: 'session-1',
      title: 'Visible pass',
      status: 'running',
      revision: 3,
      createdAt: '2026-01-01T00:00:00Z',
    });
    snapshot.tasks.push({
      id: 'task-1',
      sessionId: 'session-1',
      passId: 'pass-1',
      title: 'Visible task',
      workType: 'task.execute',
      description: 'private-description',
      acceptance: 'private-acceptance',
      status: 'blocked',
      revision: 1,
      blocker: 'private-token',
    });
    snapshot.tasks.push({
      id: 'task-2',
      sessionId: 'session-1',
      title: 'Pass-less task',
      description: 'another-private-description',
      acceptance: 'another-private-acceptance',
      status: 'running',
      revision: 1,
    });
    snapshot.steps.push(
      {
        id: 'step-2',
        sessionId: 'session-1',
        taskId: 'task-1',
        title: 'Second step',
        position: 2,
        status: 'pending',
      },
      {
        id: 'step-1',
        sessionId: 'session-1',
        taskId: 'task-1',
        title: 'First step',
        position: 1,
        status: 'completed',
      },
    );
    snapshot.assignments.push({
      id: 'assignment-1',
      sessionId: 'session-1',
      taskId: 'task-1',
      memberKey: 'worker',
      nativeAgentId: 'paseo-agent-42',
      status: 'uncertain',
      handoff: 'private-handoff',
    });
    snapshot.blockers.push('private-prompt and private-token');
    const projected = panelSnapshot(snapshot);
    const payload = JSON.stringify(projected);

    expect(projected.teamId).toBe('team-1');
    expect(projected.members[0]).toMatchObject({
      memberKey: 'worker',
      name: 'Worker',
      nativeAgentId: 'paseo-agent-42',
      status: 'running',
    });
    expect(projected.passes).toEqual([
      {
        passId: 'pass-1',
        title: 'Visible pass',
        status: 'running',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(projected.tasks).toEqual([
      {
        taskId: 'task-1',
        title: 'Visible task',
        status: 'blocked',
        passId: 'pass-1',
        passTitle: 'Visible pass',
        steps: [
          { stepId: 'step-1', title: 'First step', status: 'completed', position: 1 },
          { stepId: 'step-2', title: 'Second step', status: 'pending', position: 2 },
        ],
      },
      {
        taskId: 'task-2',
        title: 'Pass-less task',
        status: 'running',
        passId: null,
        passTitle: null,
        steps: [],
      },
    ]);
    expect(projected.assignments).toEqual([
      {
        assignmentId: 'assignment-1',
        taskId: 'task-1',
        taskTitle: 'Visible task',
        memberName: 'Worker',
        memberKey: 'worker',
        status: 'uncertain',
      },
    ]);
    expect(projected.issues).toContain('Blocked tasks: 1');
    expect(projected.issues).toContain('Assignments with uncertain delivery: 1');
    expect(projected.issues).toContain('Coordination blockers: 1');
    expect(payload).not.toContain('private-description');
    expect(payload).not.toContain('private-acceptance');
    expect(payload).not.toContain('private-token');
    expect(payload).not.toContain('private-handoff');
    expect(payload).not.toContain('private-prompt');
  });

  test('keeps public Paseo agent lifecycle statuses, including initialization and error', () => {
    const snapshot = snapshotFor('paseo-agent-42');
    const member = snapshot.members[0]!;
    for (const status of ['initializing', 'idle', 'running', 'error', 'closed']) {
      member.nativeStatus = status;
      expect(panelSnapshot(snapshot).members[0]?.status).toBe(status);
    }
    member.nativeStatus = 'unknown-runtime-status';
    expect(panelSnapshot(snapshot).members[0]?.status).toBe('unknown');
  });
  test('restricts readonly native members to explicit read/search and team tools', () => {
    expect(nativeToolAllowed(true, 'read')).toBe(true);
    expect(nativeToolAllowed(true, 'web_search')).toBe(true);
    expect(nativeToolAllowed(true, 'web_enable')).toBe(true);
    expect(nativeToolAllowed(true, 'ltcook_team')).toBe(true);
    expect(nativeToolAllowed(true, 'ltcook_ried')).toBe(true);
    expect(nativeToolAllowed(true, 'ltcook_repo_search')).toBe(true);
    expect(nativeToolAllowed(true, 'ltcook_repo_locate')).toBe(true);
    expect(nativeToolAllowed(true, 'bash')).toBe(false);
    expect(nativeToolAllowed(true, 'edit')).toBe(false);
    expect(nativeToolAllowed(true, 'web_disable')).toBe(false);
    expect(nativeToolAllowed(false, 'bash')).toBe(true);
    expect(nativeToolAllowed(true, 'unknown-mutating-plugin')).toBe(false);
  });
  test('clears inherited parent credentials while retaining the scoped agent bearer', () => {
    const environment = agentEnvironment({
      LTCOOK_API_TOKEN: 'master-secret',
      LTCOOK_RUNTIME_USER_TOKEN: 'user-secret',
      LTCOOK_PASEO_PASSWORD: 'paseo-password',
      LTCOOK_SHELL_PROVENANCE: 'serialized-shell-secrets',
      LTCOOK_AGENT_API_TOKEN: 'scoped-agent-token',
      LTCOOK_NATIVE_AGENT_ID: 'native-agent',
      CRAWL4AI_API_TOKEN: 'web-service-token',
    });
    expect(environment).toEqual({
      LTCOOK_API_TOKEN: '',
      LTCOOK_RUNTIME_USER_TOKEN: '',
      LTCOOK_PASEO_PASSWORD: '',
      LTCOOK_SHELL_PROVENANCE: '',
      LTCOOK_AGENT_API_TOKEN: 'scoped-agent-token',
      LTCOOK_NATIVE_AGENT_ID: 'native-agent',
      CRAWL4AI_API_TOKEN: 'web-service-token',
    });
  });

  test('exports exactly one end event when a span is ended repeatedly', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-balanced-span-'));
    directories.push(directory);
    const trace = join(directory, 'runtime.json');
    const telemetry = new Telemetry(join(directory, 'runtime.jsonl'), trace);
    const span = telemetry.begin('runtime.operation', 'span-1');
    span.end();
    span.end();
    await telemetry.exportTrace();
    const exported = JSON.parse(readFileSync(trace, 'utf8')) as {
      traceEvents: Array<{ ph: string; args: { correlationId: string } }>;
    };
    expect(exported.traceEvents.map((event) => event.ph)).toEqual(['B', 'E']);
    expect(exported.traceEvents.map((event) => event.args.correlationId)).toEqual([
      'span-1',
      'span-1',
    ]);
  });

  test('reports an unavailable worktree before indexing can start', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-telemetry-'));
    directories.push(directory);
    const records: unknown[] = [];
    const activation = new SessionActivation(
      {},
      {
        activate: () => {
          throw new Error('No worktree was authorized');
        },
      },
      {
        record: async (record) => {
          records.push(record);
        },
      },
    );
    activation.register(join(directory, 'absent'), 'session-diagnostics', {
      authorizeRepositoryIndex: true,
    });
    expect(records).toMatchObject([
      {
        code: 'repository-index.activation-blocked',
        component: 'repository-index',
        outcome: 'blocked',
        context: { sessionId: 'session-diagnostics' },
      },
    ]);
  });

  test('redacts credentials and prompt content from structured logs and trace export', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-telemetry-'));
    directories.push(directory);
    const logs = join(directory, 'runtime.jsonl');
    const trace = join(directory, 'runtime.json');
    const telemetry = new Telemetry(logs, trace, 'deployment:fixture');
    const span = telemetry.begin('runtime.operation');
    await telemetry.log('info', 'runtime.event', {
      apiToken: 'private-token',
      userPrompt: 'private-prompt',
      sessionId: 'session-1',
    });
    await telemetry.record({
      code: 'repository-index.failed',
      component: 'repository-index',
      severity: 'error',
      outcome: 'failure',
      operationId: 'index-1',
      correlationId: 'index-1',
      message: 'Request failed with Authorization: Bearer private-embedded-token',
      cause: new Error('Index unavailable', {
        cause: new Error('password="private spaced value"'),
      }),
    });
    telemetry.instant('index.trace', {
      message: [
        'failed at https://user:private-url@localhost/',
        'Cookie: theme=dark; session=private-session-cookie',
        'Set-Cookie: session=private-replacement-cookie; Secure',
        'Proxy-Authorization: Digest username="private-proxy-username", response="private-proxy-proof"',
      ].join('\n'),
    });
    span.end();
    await telemetry.exportTrace();
    const logText = readFileSync(logs, 'utf8');
    const traceText = readFileSync(trace, 'utf8');
    expect(logText).not.toContain('private-token');
    expect(logText).not.toContain('private-prompt');
    expect(logText).toContain('session-1');
    expect(traceText).not.toContain('private-prompt');
    expect(traceText).not.toContain('private-token');
    expect(logText).not.toContain('private-embedded-token');
    expect(logText).not.toContain('private spaced value');
    expect(traceText).not.toContain('private-url');
    expect(traceText).not.toContain('private-session-cookie');
    expect(traceText).not.toContain('private-replacement-cookie');
    expect(traceText).not.toContain('private-proxy-username');
    expect(traceText).not.toContain('private-proxy-proof');
    const [summary, diagnostic] = logText
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(summary.eventId).not.toEqual(diagnostic.eventId);
    expect(diagnostic).toMatchObject({
      buildIdentity: 'deployment:fixture',
      code: 'repository-index.failed',
      component: 'repository-index',
      outcome: 'failure',
      operationId: 'index-1',
      correlationId: 'index-1',
      cause: { message: 'Index unavailable', cause: { message: 'password=<redacted>' } },
    });
  });
});

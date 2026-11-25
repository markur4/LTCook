import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { WorkspaceMcp } from '../../../runtime/src/integrations/mcp.js';
import { createColgrepProvider } from '../../../runtime/src/repository/providers/colgrep.js';
import { createRepoSearchTool } from '../../../runtime/src/tools/repo-search.js';
import { createRepoLocateTool } from '../../../runtime/src/tools/repo-locate.js';
import { createWebTools, type WebToolService } from '../../../runtime/src/tools/web.js';
import { captureShellEnvironment } from '../../../runtime/src/integrations/shell-environment.js';
import { storedSummariesRpc } from '../../../runtime/src/paseo-plugin/shared/activity.js';
import { SessionMemory } from '../../../runtime/src/session-memory/service.js';
import { MemoryStore } from '../../../runtime/src/session-memory/store.js';

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
  test('persistently applies Activity switches only on authenticated user requests', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-activity-controls-'));
    directories.push(directory);
    const preferences = join(directory, 'activity-settings.json');
    const secret = 'activity-control-secret';
    const memory = new SessionMemory({
      databasePath: ':memory:',
      source: {
        async read() {
          throw new Error('Toggle must not load history.');
        },
      },
      async summarize() {
        throw new Error('Toggle must not run inference.');
      },
    });
    const first = new RuntimeApi(undefined, secret, `127.0.0.1:${await freePort()}`);
    first.setActivityPreferences(preferences);
    first.setSessionMemory(memory);
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
      expect(first.activityColgrep.isIndexingEnabled()).toBe(true);
      for (const feature of ['rag-index', 'summarizer']) {
        const response = await change({ feature, enabled: false });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ enabled: false });
      }
      expect(first.activityColgrep.isIndexingEnabled()).toBe(false);
      expect(memory.status(undefined, 'leader').summarization).toBe('paused');
      const restored = new RuntimeApi(undefined, secret, '127.0.0.1:0');
      restored.setActivityPreferences(preferences);
      restored.setSessionMemory(memory);
      expect(restored.activityColgrep.isIndexingEnabled()).toBe(false);
      expect(memory.status(undefined, 'leader').summarization).toBe('paused');
    } finally {
      await first.close();
      await memory.close();
    }
  });

  test('only the user can switch and persist the Session Memory backend', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-inference-mode-'));
    directories.push(directory);
    const preferences = join(directory, 'activity-settings.json');
    const secret = 'activity-inference-secret';
    const createMemory = () =>
      new SessionMemory({
        databasePath: ':memory:',
        source: {
          async read() {
            throw new Error('Selection must not read history');
          },
        },
        async summarize() {
          throw new Error('Selection must not run inference');
        },
        inference: {
          hosted: { model: 'gpt-6-luna', reasoning: 'off' },
          local: { model: 'lfm3:1.7b-qad-q4_0', reasoning: 'off' },
        },
      });
    const memory = createMemory();
    const restoredMemory = createMemory();
    const api = new RuntimeApi(undefined, secret, `127.0.0.1:${await freePort()}`);
    api.setActivityPreferences(preferences);
    api.setSessionMemory(memory);
    const endpoint = await api.listen();
    const select = (token: string, body: object) =>
      fetch(`${endpoint}/v1/activity/memory-inference`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      expect(
        (await select(agentBearer(secret, 'worker'), { nativeAgentId: 'worker', mode: 'hosted' }))
          .status,
      ).toBe(403);
      expect(memory.inferenceSelection()?.mode).toBe('local');
      expect((await select(secret, { mode: 'automatic' })).status).toBe(400);
      const result = await select(secret, { mode: 'hosted' });
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({
        mode: 'hosted',
        model: 'gpt-6-luna',
        reasoning: 'off',
      });
      const restored = new RuntimeApi(undefined, secret, '127.0.0.1:0');
      restored.setActivityPreferences(preferences);
      restored.setSessionMemory(restoredMemory);
      expect(restoredMemory.inferenceSelection()?.mode).toBe('hosted');
    } finally {
      await api.close();
      await Promise.all([memory.close(), restoredMemory.close()]);
    }
  });

  test('only the user can change the host Session Memory device', async () => {
    let probes = 0;
    const gpu = { id: 'CUDA:device-1', label: 'Fixture CUDA GPU', mainGpu: 0 };
    const ambiguous = {
      id: 'ROCm:device-2',
      label: 'Fixture AMD GPU',
      unavailable: 'Ollama cannot select this device uniquely.',
    };
    const memory = new SessionMemory({
      databasePath: ':memory:',
      async deviceCatalog() {
        probes++;
        return { devices: [gpu, ambiguous] };
      },
      source: {
        async read() {
          throw new Error('Changing the inference device must not read conversation history.');
        },
      },
      async summarize() {
        throw new Error('Changing the inference device must not start inference.');
      },
    });
    const master = 'test-master-secret';
    const api = new RuntimeApi(undefined, master, `127.0.0.1:${await freePort()}`);
    const endpoint = await api.listen();
    const post = (path: string, input: object, token = master) =>
      fetch(`${endpoint}/v1/activity/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    try {
      expect((await post('memory-device', { deviceId: 'cpu' })).status).toBe(503);
      api.setSessionMemory(memory);
      const nativeAgentId = 'selected';
      for (const input of [{ nativeAgentId }, { nativeAgentId, deviceId: gpu.id }]) {
        const rejected = await post('memory-device', input, agentBearer(master, nativeAgentId));
        expect(rejected.status).toBe(403);
      }
      expect(probes).toBe(0);
      expect((await post('memory-device', { deviceId: 0 })).status).toBe(400);
      const inventory = await post('memory-device', {});
      expect(inventory.status).toBe(200);
      expect(await inventory.json()).toMatchObject({
        device: { id: 'auto', label: 'Auto' },
        devices: [
          { id: 'auto', label: 'Auto' },
          { id: 'cpu', label: 'CPU' },
          { id: gpu.id, label: gpu.label },
          ambiguous,
        ],
      });
      const rejected = await post('memory-device', { deviceId: ambiguous.id });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: ambiguous.unavailable });
      const updated = await post('memory-device', { deviceId: gpu.id });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ device: { id: gpu.id, label: gpu.label } });
      const snapshot = await post('services', { nativeAgentId: 'another-agent' });
      expect(await snapshot.json()).toMatchObject({ memory: { device: { id: gpu.id } } });
    } finally {
      await api.close();
      await memory.close();
    }
  });

  test('only the user can page completed summaries for the requested agent and current history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-summary-reader-'));
    directories.push(directory);
    const databasePath = join(directory, 'memory.sqlite');
    const store = new MemoryStore(databasePath);
    try {
      for (let position = 1; position <= 12; position++) {
        store.saveSummary({
          id: `summary-${position}`,
          agentId: 'selected',
          sessionId: 'session-1',
          epoch: 'original',
          type: position % 2 ? 'UAMP' : 'AAB',
          position,
          sources: [{ seq: position, author: 'agent', messageId: `native-${position}` }],
          state: position === 10 ? 'recorded' : undefined,
          createdAt: '2026-01-01T00:00:00Z',
          historyHash: 'fixture',
          parts: [
            { content: { findings: [{ detail: `Stored body ${position}` }] }, sources: [position] },
          ],
          expectedParts: 1,
          complete: position !== 11,
        });
      }
      store.saveSummary({
        ...store.summaries('selected', 'original')[0]!,
        agentId: 'other-agent',
        parts: [{ content: { findings: ['Other agent summary'] }, sources: [1] }],
      });
    } finally {
      store.close();
    }
    let epoch = 'original';
    const memory = new SessionMemory({
      databasePath,
      source: {
        async read() {
          return { epoch, latest: 11, through: 11, reset: false, messages: [] };
        },
      },
      async summarize() {
        throw new Error('Reading stored summaries must never invoke inference.');
      },
    });
    const master = 'test-master-secret';
    const api = new RuntimeApi(undefined, master, `127.0.0.1:${await freePort()}`);
    api.setSessionMemory(memory);
    const endpoint = await api.listen();
    const readPage = (body: object, token = master) =>
      fetch(`${endpoint}/v1/activity/stored-summaries`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'selected', ...body }),
      });
    const readEvidence = (body: object, token = master) =>
      fetch(`${endpoint}/v1/activity/memory-evidence`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'selected', ...body }),
      });
    try {
      const record = { epoch, id: 'summary-10', position: 10 };
      expect((await readEvidence(record, agentBearer(master, 'selected'))).status).toBe(401);
      expect(await (await readEvidence(record)).json()).toEqual({
        sources: [{ seq: 10, messageId: 'native-10', author: 'agent' }],
        next: null,
      });
      for (const forged of [
        { ...record, position: 9 },
        { ...record, agentId: 'other-agent' },
      ]) {
        expect(await (await readEvidence(forged)).json()).toEqual({ sources: [], next: null });
      }
      const agent = await readPage({ nativeAgentId: 'selected' }, agentBearer(master, 'selected'));
      expect(agent.status).toBe(403);
      const firstResponse = await readPage({});
      expect(firstResponse.status).toBe(200);
      const first = storedSummariesRpc.output.parse(await firstResponse.json());
      expect(first.summaries.map(({ id }) => id)).toEqual(
        Array.from({ length: 8 }, (_, index) => `summary-${10 - index}`),
      );
      expect(first.summaries[0]).toMatchObject({
        type: 'AAB',
        parts: [{ content: { findings: [{ detail: 'Stored body 10' }] }, sources: [10] }],
      });
      expect(first.storagePath).toBe(databasePath);
      const passage = storedSummariesRpc.output.parse(
        await (await readPage({ passage: { epoch, start: 5, position: 5 } })).json(),
      );
      expect(passage.summaries.map(({ id }) => id)).toEqual(['summary-5']);
      const oldPassage = await readPage({ passage: { epoch: 'prior', start: 5, position: 5 } });
      expect(oldPassage.status).toBe(400);

      expect(first.summaries[0]).toMatchObject({
        position: 10,
        originalTokens: null,
        durationMs: null,
      });
      const metadataOnly = storedSummariesRpc.output.parse(
        await (await readPage({ includeContent: false })).json(),
      );
      expect(metadataOnly.summaries.map(({ id }) => id)).toEqual(
        first.summaries.map(({ id }) => id),
      );
      expect(metadataOnly.summaries.flatMap(({ parts }) => parts)).toEqual([]);
      expect(metadataOnly.next).toEqual(first.next);
      expect(first.next).not.toBeNull();
      const second = storedSummariesRpc.output.parse(
        await (await readPage({ before: first.next })).json(),
      );
      expect(second.summaries.map(({ id }) => id)).toEqual(['summary-2', 'summary-1']);
      expect(second.next).toBeNull();
      epoch = 'replacement';
      expect(await (await readEvidence(record)).json()).toEqual({ sources: [], next: null });
      expect((await readPage({ before: first.next })).status).toBe(400);
      expect(storedSummariesRpc.output.parse(await (await readPage({})).json()).summaries).toEqual(
        [],
      );
    } finally {
      await api.close();
      await memory.close();
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
    const api = new RuntimeApi(controller, master, `127.0.0.1:${await freePort()}`);
    api.setSession('/workspace', 'session-1');
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
      snapshot: () => snapshotFor(nativeAgentId, true, 'session-1', process.cwd()),
      authorizeTool() {
        authorized++;
        return { allowed, reason: 'Tool budget exhausted' };
      },
    } as unknown as RuntimeController;
    const authority = `127.0.0.1:${await freePort()}`;
    const api = new RuntimeApi(controller, master, authority);
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
    api.setWorkspaceMcp(
      new WorkspaceMcp(
        [...createWebTools(service), repositorySearch, createRepoLocateTool(repositorySearch)],
        authority,
      ),
    );
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
      const denied = await call();
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: 'Tool budget exhausted' });
      expect(authorized).toBe(1);
      expect(invoked).toBe(0);
      allowed = true;
      expect((await call('unbound')).status).toBe(403);
      expect(await (await call()).json()).toEqual(searchResult);
      expect(authorized).toBe(2);
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
      expect(authorized).toBe(3);
      const locate = await call(nativeAgentId, 'ltcook_repo_locate');
      expect(locate.status).toBe(200);
      expect(await locate.json()).toMatchObject({
        followUp: 'initial-unavailable',
        searches: [{ mode: 'hybrid', status: 'unavailable', provider: 'colgrep' }],
      });
      expect((await call('unbound', 'ltcook_repo_locate')).status).toBe(403);
      expect(authorized).toBe(4);
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
    const api = new RuntimeApi(controller, master, `127.0.0.1:${await freePort()}`);
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
      api = new RuntimeApi(runtime, 'readonly-report-user-secret', `127.0.0.1:${await freePort()}`);
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
    const api = new RuntimeApi(undefined, 'owner', `127.0.0.1:${await freePort()}`);
    const endpoint = await api.listen();
    const stopFinished = Promise.withResolvers<void>();
    let attempt = 0;
    let released = 0;
    let stopCalls = 0;
    api.setOpenWorkspaceHandler(async () => {
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
      expect((await stop('owner')).status).toBe(503);
      expect(released).toBe(1);
      expect(stopCalls).toBe(0);
      expect((await stop('owner')).status).toBe(202);
      await stopFinished.promise;
      expect(stopCalls).toBe(1);
      expect(released).toBe(1);
    } finally {
      await api.close();
    }
  });

  test('requires user authentication and readiness for runtime status', async () => {
    const master = 'test-master-secret';
    const api = new RuntimeApi(undefined, master, `127.0.0.1:${await freePort()}`);
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
      api.setOpenWorkspaceHandler(async () => {
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
    const api = new RuntimeApi(controller, master, `127.0.0.1:${await freePort()}`, {
      LTCOOK_SHELL_PROVENANCE: JSON.stringify({
        LTCOOK_API_TOKEN: 'original-shell-token',
        LTCOOK_TEAM: 'default-minimal',
        ORIGINAL_ONLY: 'startup',
      }),
      LTCOOK_TEAM: 'merged-project-team',
    });
    api.setOpenWorkspaceHandler(async (request) => {
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
    const api = new RuntimeApi(controller, master, `127.0.0.1:${await freePort()}`);
    api.setOpenWorkspaceHandler(async (request) => {
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
    const api = new RuntimeApi(controller, master, `127.0.0.1:${await freePort()}`);
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

  test('redacts credentials and prompt content from structured logs and trace export', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-telemetry-'));
    directories.push(directory);
    const logs = join(directory, 'runtime.jsonl');
    const trace = join(directory, 'runtime.json');
    const telemetry = new Telemetry(logs, trace);
    const span = telemetry.begin('runtime.operation');
    await telemetry.log('info', 'runtime.event', {
      apiToken: 'private-token',
      userPrompt: 'private-prompt',
      sessionId: 'session-1',
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
  });
});

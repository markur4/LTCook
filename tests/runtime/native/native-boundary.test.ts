import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend, RuntimeActor, RuntimeController, SessionSnapshot, TeamPackage } from '../../../runtime/src/api/team.js';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import { agentEnvironment, nativeToolAllowed } from '../../../runtime/src/integrations/native-policy.js';
import { panelSnapshot } from '../../../runtime/src/paseo-plugin/shared/panel-snapshot.js';
import { Telemetry } from '../../../runtime/src/diagnostics/telemetry.js';
import { agentBearer, RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import { startPaseoHost } from '../../../runtime/src/integrations/paseo.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local test port available');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function snapshotFor(nativeAgentId: string, readOnly = true): SessionSnapshot {
  return {
    session: { id: 'session-1', teamId: 'team-1', workspaceRoot: '/workspace', createdAt: '2026-01-01T00:00:00Z' },
    definition: { id: 'team-1', name: 'Team', coordinatorKey: 'lead', members: [], resources: [], reviewPolicy: { mode: 'self', reviewerKeys: [], required: false } },
    members: [{
      member: { key: 'worker', name: 'Worker', lifetime: 'persistent', modelAlias: 'smart', thinking: '', readOnly, instructionPaths: [] },
      binding: { sessionId: 'session-1', teamId: 'team-1', memberKey: 'worker', nativeAgentId, workspaceRoot: '/workspace', state: 'bound' }, nativeStatus: 'running',
    }],
    passes: [], tasks: [], assignments: [], reports: [], reviews: [], approvals: [], blockers: [],
  };
}

describe('native runtime boundary', () => {

  test('rejects Paseo homes outside the deployment and under immutable app', async () => {
    const deploymentRoot = mkdtempSync(join(tmpdir(), 'ltcook-deployment-'));
    const outsideHome = mkdtempSync(join(tmpdir(), 'ltcook-paseo-outside-'));
    directories.push(deploymentRoot, outsideHome);
    const hostInput = {
      node: '',
      deploymentRoot,
      listen: '127.0.0.1:6767',
      password: '',
      runtimeApiUrl: '',
      userToken: '',
      pluginDirectory: '',
    };

    for (const home of [outsideHome, join(deploymentRoot, 'app', 'paseo')]) {
      await expect(startPaseoHost({ ...hostInput, home })).rejects.toThrow(
        'PASEO_HOME must resolve inside the LTCook deployment and outside its immutable app directory.',
      );
    }

    expect(() => readFileSync(join(outsideHome, 'config.json'))).toThrow();
    expect(() =>
      readFileSync(join(deploymentRoot, 'app', 'paseo', 'config.json')),
    ).toThrow();
  });

  test('separates authenticated user authority from native-ID-bound agent authority', async () => {
    const master = 'test-master-secret';
    const nativeAgentId = 'paseo-agent-42';
    const actors: RuntimeActor[] = [];
    const controller = {
      openSession: async () => snapshotFor(nativeAgentId, false),
      snapshot: () => snapshotFor(nativeAgentId, false),
      execute: async (_session: string, actor: RuntimeActor) => { actors.push(actor); return actor; },
      close: async () => undefined,
    } as RuntimeController;
    const api = new RuntimeApi(controller, master, `127.0.0.1:${await freePort()}`);
    api.setSession('/workspace', 'session-1');
    const endpoint = await api.listen();
    try {
      const command = { type: 'task.create', title: 'Task', description: 'Work', acceptance: 'Done' };
      const userResponse = await fetch(`${endpoint}/v1/command`, {
        method: 'POST', headers: { authorization: `Bearer ${master}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', nativeAgentId, command }),
      });
      expect(userResponse.status).toBe(200);
      expect((await userResponse.json() as { value: RuntimeActor }).value).toEqual({ kind: 'user' });

      const agentResponse = await fetch(`${endpoint}/v1/command`, {
        method: 'POST', headers: { authorization: `Bearer ${agentBearer(master, nativeAgentId)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', nativeAgentId, command }),
      });
      expect(agentResponse.status).toBe(200);
      expect((await agentResponse.json() as { value: RuntimeActor }).value).toEqual({ kind: 'agent', nativeAgentId });

      const wrongId = await fetch(`${endpoint}/v1/command`, {
        method: 'POST', headers: { authorization: `Bearer ${agentBearer(master, 'other-agent')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', nativeAgentId, command }),
      });
      expect(wrongId.status).toBe(401);

      const snapshotResponse = await fetch(`${endpoint}/v1/snapshot`, {
        method: 'POST', headers: { authorization: `Bearer ${agentBearer(master, nativeAgentId)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', nativeAgentId }),
      });
      expect(snapshotResponse.status).toBe(200);
      expect(actors).toHaveLength(2);
    } finally { await api.close(); }
  });
  test('persists an assigned readonly report through the authenticated HTTP boundary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-runtime-api-'));
    directories.push(directory);
    const nativeAgents = new Map<string, { id: string; status: string }>();
    const agents: AgentBackend = {
      async list() { return [...nativeAgents.values()]; },
      async create({ member }) {
        const agent = { id: `native-${member.key}`, status: 'running' };
        nativeAgents.set(agent.id, agent);
        return agent;
      },
      async inspect(id) { return nativeAgents.get(id) ?? null; },
      async send() {},
      async close(id) { nativeAgents.delete(id); },
    };
    const reviewPolicy = { mode: 'self' as const, reviewerKeys: [] as string[], required: false };
    const team: TeamPackage = {
      apiVersion: 1,
      definition: {
        id: 'native-api-test-team', name: 'Native API test team', coordinatorKey: 'lead',
        members: [
          { key: 'lead', name: 'Lead', lifetime: 'persistent', modelAlias: 'smart', thinking: '', readOnly: false, instructionPaths: [] },
          { key: 'explorer', name: 'Explorer', lifetime: 'persistent', modelAlias: 'smol', thinking: '', readOnly: true, instructionPaths: [] },
        ],
        resources: [], reviewPolicy,
      },
      activateService({ workflows }) {
        workflows.register({ coordinatorKey: 'lead', delegateKeys: ['explorer'], review: reviewPolicy });
      },
      async activateAgent() {},
    };
    const runtime = createRuntime({ databasePath: join(directory, 'coordination.sqlite'), team, agents });
    let api: RuntimeApi | undefined;
    try {
      const opened = await runtime.openSession({ id: 'report-session', workspaceRoot: '/workspace' });
      const task = await runtime.execute(opened.session.id, { kind: 'user' }, {
        type: 'task.create', title: 'Explore', description: 'Inspect files', acceptance: 'Report findings',
      }) as { id: string };
      const assignment = await runtime.execute(opened.session.id, { kind: 'user' }, {
        type: 'assignment.create', taskId: task.id, memberKey: 'explorer', message: 'Inspect the workspace',
      }) as { id: string };
      const nativeAgentId = runtime.snapshot(opened.session.id).members
        .find(member => member.member.key === 'explorer')?.binding?.nativeAgentId;
      if (!nativeAgentId) throw new Error('Readonly explorer was not bound');
      api = new RuntimeApi(runtime, 'readonly-report-user-secret', `127.0.0.1:${await freePort()}`);
      const endpoint = await api.listen();
      const post = (command: unknown) => fetch(`${endpoint}/v1/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${agentBearer('readonly-report-user-secret', nativeAgentId)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: opened.session.id, nativeAgentId, command }),
      });

      const report = { type: 'report.create', assignmentId: assignment.id, summary: 'Found relevant files', evidence: 'Inspected source tree' };
      const reportResponse = await post(report);
      expect(reportResponse.status).toBe(200);
      expect(runtime.snapshot(opened.session.id).reports.map(value => value.summary)).toEqual(['Found relevant files']);
      expect(runtime.snapshot(opened.session.id).assignments[0]?.status).toBe('reported');

      const schedulerResponse = await post({ type: 'task.create', title: 'Unauthorized', description: 'Schedule work', acceptance: 'Never' });
      expect(schedulerResponse.status).toBe(400);
      expect(runtime.snapshot(opened.session.id).tasks).toHaveLength(1);
    } finally {
      await api?.close();
      await runtime.close();
    }
  });


  test('opens same-team workspace sessions once and keeps shell provenance scoped to memory', async () => {
    const master = 'test-master-secret';
    const shellEnvironment = { LTCOOK_API_TOKEN: 'original-shell-token', LTCOOK_TEAM: 'default-minimal' };
    const snapshot = snapshotFor('native-agent');
    snapshot.session.id = 'workspace-session';
    snapshot.session.workspaceRoot = '/new-workspace';
    const opened: Array<{ workspaceRoot: string; sessionId: string; teamSelection: string; shellEnvironment: Record<string, string> }> = [];
    const controller = { snapshot() { return snapshot; }, execute: async () => undefined } as unknown as RuntimeController;
    const api = new RuntimeApi(controller, master, `127.0.0.1:${await freePort()}`);
    api.setOpenWorkspaceHandler('default-minimal', async request => { opened.push(request); return snapshot; });
    const endpoint = await api.listen();
    const post = (token: string, body: unknown) => fetch(`${endpoint}/v1/session/open`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const request = { workspaceRoot: '/new-workspace', sessionId: 'workspace-session', teamSelection: 'default-minimal', shellEnvironment };
    try {
      const responses = await Promise.all([post(master, request), post(master, request)]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.shellEnvironment).toEqual(shellEnvironment);
      expect((await post(master, { ...request, teamSelection: 'different-team' })).status).toBe(409);
      expect((await post(agentBearer(master, 'native-agent'), { ...request, nativeAgentId: 'native-agent' })).status).toBe(403);
      expect(opened).toHaveLength(1);
    } finally { await api.close(); }
  });
  test('validates and dispatches the native team.close command', async () => {
    const master = 'test-master-secret';
    const nativeAgentId = 'coordinator-agent';
    const sent: unknown[] = [];
    const controller = {
      snapshot: () => snapshotFor(nativeAgentId, false),
      execute: async (_session: string, _actor: RuntimeActor, command: unknown) => { sent.push(command); return command; },
    } as unknown as RuntimeController;
    const api = new RuntimeApi(controller, master, `127.0.0.1:${await freePort()}`);
    const endpoint = await api.listen();
    const post = (command: unknown) => fetch(`${endpoint}/v1/command`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentBearer(master, nativeAgentId)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', nativeAgentId, command }),
    });
    const command = { type: 'team.close', memberKey: 'temporary-reviewer' };
    try {
      const response = await post(command);
      expect(response.status).toBe(200);
      expect((await response.json() as { value: unknown }).value).toEqual(command);
      expect(sent).toEqual([command]);
      expect((await post({ type: 'team.close' })).status).toBe(400);
      expect(sent).toHaveLength(1);
    } finally { await api.close(); }
  });


  test('projects safe task and assignment details without prompt or secret content', () => {
    const snapshot = snapshotFor('paseo-agent-42');
    snapshot.tasks.push({
      id: 'task-1', sessionId: 'session-1', passId: 'pass-1',
      title: 'private-prompt', description: 'private-description',
      acceptance: 'private-acceptance', status: 'blocked', revision: 1,
      blocker: 'private-token',
    });
    snapshot.assignments.push({
      id: 'assignment-1', sessionId: 'session-1', taskId: 'task-1',
      memberKey: 'worker', nativeAgentId: 'paseo-agent-42',
      status: 'uncertain', handoff: 'private-handoff',
    });
    snapshot.blockers.push('private-prompt and private-token');
    const projected = panelSnapshot(snapshot);
    const payload = JSON.stringify(projected);

    expect(projected.teamId).toBe('team-1');
    expect(projected.members[0]).toMatchObject({
      memberKey: 'worker', nativeAgentId: 'paseo-agent-42', status: 'running',
    });
    expect(projected.tasks).toEqual([{ taskId: 'task-1', status: 'blocked' }]);
    expect(projected.assignments).toEqual([{
      assignmentId: 'assignment-1', taskId: 'task-1',
      memberKey: 'worker', status: 'uncertain',
    }]);
    expect(projected.issues).toContain('Blocked tasks: 1');
    expect(projected.issues).toContain('Assignments with uncertain delivery: 1');
    expect(projected.issues).toContain('Coordination blockers: 1');
    expect(payload).not.toContain('private-prompt');
    expect(payload).not.toContain('private-description');
    expect(payload).not.toContain('private-token');
    expect(payload).not.toContain('private-handoff');
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
    const exported = JSON.parse(readFileSync(trace, 'utf8')) as { traceEvents: Array<{ ph: string; args: { correlationId: string } }> };
    expect(exported.traceEvents.map(event => event.ph)).toEqual(['B', 'E']);
    expect(exported.traceEvents.map(event => event.args.correlationId)).toEqual(['span-1', 'span-1']);
  });

  test('redacts credentials and prompt content from structured logs and trace export', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ltcook-telemetry-'));
    directories.push(directory);
    const logs = join(directory, 'runtime.jsonl');
    const trace = join(directory, 'runtime.json');
    const telemetry = new Telemetry(logs, trace);
    const span = telemetry.begin('runtime.operation');
    await telemetry.log('info', 'runtime.event', { apiToken: 'private-token', userPrompt: 'private-prompt', sessionId: 'session-1' });
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

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agentBearer } from '../../../runtime/src/integrations/runtime-api.js';
import { startPaseoHost } from '../../../runtime/src/integrations/paseo.js';
import team from '../../../teams/default/src/index.js';
import type {
  AgentBackend,
  PlanningRecord,
  RuntimeActor,
  RuntimeCommand,
  SessionSnapshot,
} from '../../../runtime/src/workflow-api/index.js';

const root = path.resolve(import.meta.dir, '../../..');
const directory = process.argv[2];
if (!directory || process.platform !== 'linux')
  throw new Error('Linux and an isolated test directory are required');
const workspace = path.join(directory, 'workspace');
const deployment = path.join(directory, 'deployment');
const agentHome = path.join(directory, 'pi');
const authHome = path.join(directory, 'auth');
const sessionId = 'clockwork-system';
const secret = 'offline-system-fixture-token';
const requestCounts = new Map<string, number>();
const toolCalls: string[] = [];
const nativeIds = new Map<string, string>();
let owner: ChildProcess | undefined;
let cachedSnapshot: SessionSnapshot;
let sequence = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();
const runtime = {
  snapshot(_sessionId: string): SessionSnapshot {
    return cachedSnapshot;
  },
  async execute(
    _sessionId: string,
    actor: RuntimeActor,
    command: RuntimeCommand,
  ): Promise<unknown> {
    return ownerRequest('execute', { actor, command });
  },
  async close(): Promise<void> {
    if (!owner || owner.exitCode !== null || owner.signalCode !== null) return;
    const child = owner;
    child.send({ kind: 'stop' });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    try {
      await once(child, 'exit');
    } finally {
      clearTimeout(timeout);
    }
  },
};
function ownerRequest(kind: string, data: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    owner!.send({ kind, id, ...data });
  });
}
let providerError: unknown;
let requests = 0;

async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (true) {
    await ownerRequest('snapshot');
    if (predicate()) return;
    if (providerError) throw providerError;
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out: ${label}; snapshot=${JSON.stringify(runtime.snapshot(sessionId))}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
function command(command: Record<string, unknown>) {
  return { name: 'ltcook_team', arguments: { command } };
}
function script(
  model: string,
  messages: unknown[],
): { name: string; arguments: unknown } | undefined {
  const snapshot = runtime.snapshot(sessionId);
  const pass = snapshot.passes.find((entry) => entry.status === 'running');
  const memberKey = model;
  const latestUser = [...messages]
    .reverse()
    .find((entry) => (entry as { role?: string }).role === 'user');
  const text = JSON.stringify(latestUser);
  const assignment = [...snapshot.assignments]
    .reverse()
    .find(
      (entry) =>
        entry.memberKey === memberKey &&
        (['sent', 'sending'].includes(entry.status) ||
          (entry.status === 'reported' &&
            snapshot.tasks.some(
              (task) =>
                task.id === entry.taskId &&
                task.requestId?.endsWith(':execution-handoff') &&
                task.status !== 'completed',
            ))),
    );
  const task = snapshot.tasks.find((entry) => entry.id === assignment?.taskId);
  if (!pass) return;
  const original = snapshot.tasks.find((entry) => entry.requestId === 'system-original');
  const correction = snapshot.tasks.find((entry) => entry.requestId === 'system-correction');
  if (memberKey === 'main' && text.includes('FIXTURE_CORRECTION') && original && !correction) {
    return command({
      type: 'task.create',
      passId: pass.id,
      requestId: 'system-correction',
      title: 'Repair local fixture',
      description: 'Write repaired.txt',
      acceptance: 'Local verification succeeds',
      assigneeKey: 'senior',
      correctionOfTaskId: original.id,
      verificationRequirements: ['local-check'],
    });
  }
  if (
    memberKey === 'main' &&
    text.includes('FIXTURE_RETRY') &&
    original?.status === 'failed' &&
    correction?.status === 'completed'
  ) {
    return command({
      type: 'task.retry',
      taskId: original.id,
      requestId: 'system-retry',
      correctionTaskId: correction.id,
    });
  }
  if (!assignment || !task || task.workType !== 'task.execute') return;
  const index = requestCounts.get(assignment.id) ?? 0;
  requestCounts.set(assignment.id, index + 1);
  if (task.requestId?.endsWith(':execution-handoff')) {
    if (index === 0)
      return command({
        type: 'task.create',
        passId: pass.id,
        requestId: 'system-original',
        title: 'Verify local fixture',
        description: 'Run test -f repaired.txt',
        acceptance: 'A real shell check passes',
        assigneeKey: 'senior',
        verificationRequirements: ['local-check'],
      });
    if (index === 1) {
      assert(original);
      return command({
        type: 'task.create',
        passId: pass.id,
        requestId: 'system-dependent',
        title: 'Verify prerequisite result',
        description: 'Check repaired.txt after prerequisite succeeds',
        acceptance: 'Dependency succeeded',
        assigneeKey: 'junior',
        dependencyIds: [original.id],
        verificationRequirements: ['local-check'],
      });
    }
    if (index === 2)
      return command({
        type: 'report.create',
        assignmentId: assignment.id,
        summary: 'Registered execution graph',
        evidence: 'Two scheduled tasks',
      });
    if (index === 3) return command({ type: 'task.update', taskId: task.id, status: 'completed' });
    return;
  }
  if (task.phase === 'review') {
    if (index === 0)
      return { name: 'bash', arguments: { command: 'test -f repaired.txt && cat repaired.txt' } };
    if (index === 1)
      return command({
        type: 'review.create',
        passId: pass.id,
        assignmentId: assignment.id,
        revision: pass.revision,
        outcome: 'accepted',
        summary: 'Independent reviewer ran the local check and inspected the complete Pass.',
      });
    return;
  }
  const attempt = snapshot.assignments.filter((entry) => entry.taskId === task.id).length;
  const failed = task.requestId === 'system-original' && attempt === 1;
  if (index === 0)
    return {
      name: 'bash',
      arguments: {
        command:
          task.requestId === 'system-correction'
            ? "printf 'repaired\\n' > repaired.txt && test -s repaired.txt && cat repaired.txt"
            : 'test -f repaired.txt && cat repaired.txt',
      },
    };
  if (index === 1) {
    const toolResult = JSON.stringify(
      [...messages].reverse().find((entry) => (entry as { role?: string }).role === 'tool'),
    );
    assert(
      toolResult.includes(failed ? 'code 1' : 'repaired'),
      `Unexpected native verification output: ${toolResult}`,
    );
    return command({
      type: 'report.create',
      assignmentId: assignment.id,
      summary: failed ? 'Missing local file' : 'Local verification passed',
      evidence: 'Native Pi bash tool executed the fixture command',
      outcome: failed ? 'failure' : 'success',
      verification: [
        {
          requirement: 'local-check',
          result: failed ? 'failed' : 'passed',
          evidence: failed ? 'test -f repaired.txt exited 1' : 'test -f repaired.txt exited 0',
        },
      ],
    });
  }
}

await mkdir(workspace, { recursive: true });
await mkdir(path.join(deployment, 'app/node_modules/.bin'), { recursive: true });
await mkdir(agentHome, { recursive: true });
await mkdir(authHome, { recursive: true });
const launcher = path.join(deployment, 'app/node_modules/.bin/ltcook-pi');
await writeFile(
  launcher,
  `#!/bin/sh\nexec ${JSON.stringify(process.env.LTCOOK_TEST_NODE ?? 'node')} ${JSON.stringify(path.join(root, 'runtime/dist/integrations/pi-rpc.js'))} "$@"\n`,
);
await chmod(launcher, 0o755);
const provider = createServer(async (request, response) => {
  try {
    assert(
      request.url?.endsWith('/chat/completions'),
      `Unexpected provider request: ${request.url}`,
    );
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as { model: string; messages: unknown[] };
    requests += 1;
    await ownerRequest('snapshot');
    const action = script(input.model, input.messages);
    if (action) toolCalls.push(action.name);
    const id = `fixture-${requests}`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    send({ role: 'assistant' });
    if (action)
      send({
        tool_calls: [
          {
            index: 0,
            id,
            type: 'function',
            function: { name: action.name, arguments: JSON.stringify(action.arguments) },
          },
        ],
      });
    else send({ content: 'Fixture turn complete.' });
    send({}, action ? 'tool_calls' : 'stop');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    providerError = error;
    response.writeHead(500).end('Scripted fixture failed');
  }
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
assert(address && typeof address !== 'string');
await writeFile(
  path.join(agentHome, 'models.json'),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: 'openai-completions',
        apiKey: 'fake-local-key',
        models: team.definition.members.map((member) => ({
          id: member.key,
          name: member.name,
          contextWindow: 32768,
          maxTokens: 4096,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    },
  }),
);
async function freePort(): Promise<number> {
  const server = createSocketServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
process.env.LTCOOK_PI_AUTH_DIR = authHome;
process.env.PI_CODING_AGENT_DIR = agentHome;
process.env.PI_OFFLINE = '1';
const apiListen = `127.0.0.1:${await freePort()}`;
const endpoint = `http://${apiListen}`;
let host: Awaited<ReturnType<typeof startPaseoHost>> | undefined;
let shutdown: Promise<void> | undefined;
function cleanup(): Promise<void> {
  shutdown ??= (async () => {
    const failures: unknown[] = [];
    for (const operation of [
      () => runtime.close(),
      () => host?.close(),
      () =>
        new Promise<void>((resolve, reject) =>
          provider.close((error) => (error ? reject(error) : resolve())),
        ),
    ]) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Native fixture cleanup failed');
  })();
  return shutdown;
}
process.once('SIGTERM', () => {
  void cleanup().finally(() => process.exit(143));
});
try {
  host = await startPaseoHost({
    node: process.env.LTCOOK_TEST_NODE ?? 'node',
    home: path.join(deployment, 'paseo'),
    deploymentRoot: deployment,
    listen: `127.0.0.1:${await freePort()}`,
    runtimeApiUrl: endpoint,
    userToken: 'fake-user-token',
    pluginDirectory: path.join(root, 'runtime/src/paseo-plugin'),
  });
  const native = host.api;
  const backend: AgentBackend = {
    async list() {
      return (await native.agents.list()).entries.map(({ agent }) => ({
        id: agent.id,
        status: agent.status ?? 'unknown',
      }));
    },
    async create(options) {
      const id = randomUUID();
      nativeIds.set(options.member.key, id);
      const agent = await native.agents.create({
        agentId: id,
        idempotencyKey: id,
        cwd: workspace,
        title: options.member.name,
        config: { provider: `pi/fixture/${options.member.key}`, thinkingOptionId: 'off' },
        env: {
          ...process.env,
          HOME: directory,
          PI_CODING_AGENT_DIR: agentHome,
          PI_OFFLINE: '1',
          LTCOOK_PI_AUTH_DIR: authHome,
          LTCOOK_TEAM: 'default',
          LTCOOK_MEMBER_KEY: options.member.key,
          LTCOOK_NATIVE_AGENT_ID: id,
          LTCOOK_SESSION: sessionId,
          LTCOOK_SESSION_ID: sessionId,
          LTCOOK_TEAM_ID: team.definition.id,
          LTCOOK_TEAM_INSTANCE_ID: options.teamInstanceId,
          LTCOOK_GUIDANCE_DIR: path.join(directory, 'guidance'),
          LTCOOK_RUNTIME_API_URL: endpoint,
          LTCOOK_AGENT_API_TOKEN: agentBearer(secret, id),
          LTCOOK_API_TOKEN: '',
          LTCOOK_READONLY: options.member.readOnly ? '1' : '0',
          LTCOOK_BROWSER_ENABLED: 'false',
        },
      });
      return { id: agent.id, status: agent.status ?? 'unknown' };
    },
    async inspect(id) {
      const result = await native.agents.ref(id).refresh();
      return result ? { id, status: result.agent.status ?? 'unknown' } : null;
    },
    async send(id, message) {
      await native.agents.ref(id).send(message);
    },
    async close(id) {
      await native.agents.ref(id).archive();
    },
  };
  async function startOwner(): Promise<void> {
    const child = fork(
      path.join(root, 'tests/runtime/system/clockwork-owner.ts'),
      [directory, apiListen],
      { execPath: process.execPath, cwd: root, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] },
    );
    owner = child;
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        for (const request of pending.values())
          request.reject(new Error(`Runtime owner exited (${code}, ${signal})`));
        pending.clear();
        if (code !== 0) reject(new Error(`Runtime owner startup failed (${code}, ${signal})`));
      });
      child.on(
        'message',
        (message: {
          kind: string;
          id: number;
          method?: keyof AgentBackend;
          args?: unknown[];
          value?: unknown;
          error?: string;
          snapshot?: SessionSnapshot;
        }) => {
          if (message.snapshot) cachedSnapshot = message.snapshot;
          if (message.kind === 'ready') resolve();
          else if (message.kind === 'owner-result') {
            const request = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) request?.reject(new Error(message.error));
            else request?.resolve(message.value);
          } else if (message.kind === 'backend') {
            const method = backend[message.method!] as (...args: unknown[]) => Promise<unknown>;
            void method(...message.args!).then(
              (value) => child.send({ kind: 'backend-result', id: message.id, value }),
              (error: unknown) =>
                child.send({ kind: 'backend-result', id: message.id, error: String(error) }),
            );
          }
        },
      );
    });
  }
  await startOwner();
  const designPath = path.join(
    runtime.snapshot(sessionId).documentsDirectory,
    'designs',
    'Design-2026_11_14-00_00-system.md',
  );
  await mkdir(path.dirname(designPath), { recursive: true });
  await writeFile(designPath, '# Design\nVerify the local fixture through scheduled agents.\n');
  const plan = (await runtime.execute(
    sessionId,
    { kind: 'user' },
    { type: 'planning.start', designPath, title: 'Offline system acceptance' },
  )) as PlanningRecord;
  await writeFile(
    plan.plan.path,
    '# Plan\nRun the scheduled verification, correction, retry and independent review.\n',
  );
  // > Setup uses the public planning contract; execution results below come only from real Pi tools.
  for (let stage = 0; stage < 2; stage++) {
    const record = runtime.snapshot(sessionId).planning[0]!;
    const assignment = runtime
      .snapshot(sessionId)
      .assignments.find((entry) => entry.id === record.assignmentId)!;
    await waitFor('planning agent idle', () => requests > stage);
    await runtime.execute(
      sessionId,
      { kind: 'agent', nativeAgentId: assignment.nativeAgentId },
      {
        type: 'planning.submit',
        planId: plan.id,
        assignmentId: assignment.id,
        summary: 'Fixture Plan prepared',
        evidence: plan.plan.path,
        ...(stage
          ? {
              coverage: (
                ['intent', 'design', 'scope', 'implementation', 'verification', 'delivery'] as const
              ).map((topic) => ({
                topic,
                disposition: 'Resolved' as const,
                detail: 'Explicit fixture scope',
              })) as NonNullable<Extract<RuntimeCommand, { type: 'planning.submit' }>['coverage']>,
            }
          : {}),
      },
    );
  }
  for (const decision of runtime.snapshot(sessionId).decisions)
    await runtime.execute(
      sessionId,
      { kind: 'user' },
      {
        type: 'decision.answer',
        planId: plan.id,
        decisionId: decision.id,
        answer: 'Explicit offline fixture authorization',
      },
    );
  await runtime.execute(sessionId, { kind: 'user' }, { type: 'planning.approve', planId: plan.id });
  await waitFor('failed prerequisite', () =>
    runtime
      .snapshot(sessionId)
      .tasks.some((entry) => entry.requestId === 'system-original' && entry.status === 'failed'),
  );
  assert(
    !runtime
      .snapshot(sessionId)
      .assignments.some(
        (entry) =>
          entry.taskId ===
          runtime.snapshot(sessionId).tasks.find((task) => task.requestId === 'system-dependent')
            ?.id,
      ),
  );
  await backend.send(nativeIds.get('main')!, 'FIXTURE_CORRECTION');
  await waitFor('completed correction', () =>
    runtime
      .snapshot(sessionId)
      .tasks.some(
        (entry) => entry.requestId === 'system-correction' && entry.status === 'completed',
      ),
  );
  const before = runtime.snapshot(sessionId);
  await runtime.close();
  const previousOwnerPid = owner!.pid;
  await startOwner();
  assert.notEqual(owner!.pid, previousOwnerPid);
  assert.equal(runtime.snapshot(sessionId).session.id, before.session.id);
  assert.equal(runtime.snapshot(sessionId).assignments.length, before.assignments.length);
  await backend.send(nativeIds.get('main')!, 'FIXTURE_RETRY');
  await waitFor('Pass completion after independent review', () =>
    runtime.snapshot(sessionId).passes.some((entry) => entry.status === 'completed'),
  );
  const result = runtime.snapshot(sessionId);
  assert.equal(await readFile(path.join(workspace, 'repaired.txt'), 'utf8'), 'repaired\n');
  assert(
    result.reviews.some((review) => review.kind === 'independent' && review.outcome === 'accepted'),
  );
  assert.equal(
    result.assignments.filter(
      (entry) =>
        entry.taskId === result.tasks.find((task) => task.requestId === 'system-original')?.id,
    ).length,
    2,
  );
  assert(toolCalls.filter((name) => name === 'bash').length >= 5);
  assert(toolCalls.includes('ltcook_team'));
  console.log(
    JSON.stringify({
      result: 'passed',
      providerRequests: requests,
      toolCalls: toolCalls.length,
      nativeAgents: nativeIds.size,
      restart: 'Runtime owner process restarted with native agents retained',
    }),
  );
} finally {
  await cleanup();
}

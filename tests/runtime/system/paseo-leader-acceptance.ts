import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import { agentBearer, RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import {
  createPaseoAgentBackend,
  startPaseoHost,
} from '../../../runtime/src/integrations/paseo.js';
import { TeamRegistry } from '../../../runtime/src/integrations/team-loader.js';

const root = path.resolve(import.meta.dir, '../../..');
const directory = process.argv[2];
if (!directory || process.platform !== 'linux')
  throw new Error('Isolated Linux fixture directory required');
const workspace = path.join(directory, 'workspace');
const deployment = path.join(directory, 'deployment');
const piHome = path.join(directory, 'pi');
const authHome = path.join(directory, 'auth');
for (const entry of [workspace, deployment, piHome, authHome])
  await mkdir(entry, { recursive: true });
async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}
const listen = `127.0.0.1:${await freePort()}`;
const endpoint = `http://${listen}`;
const secret = 'offline-leader-system-token';
const node = process.env.LTCOOK_TEST_NODE ?? 'node';
const teams = await TeamRegistry.load(root);
const team = teams.resolve('default-minimal');
const leaderId = randomUUID();
let modelCalls = 0;
let providerError: unknown;
const provider = createHttpServer(async (request, response) => {
  try {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    modelCalls++;
    assert(
      runtime!.snapshot(leaderId).members.every(({ binding }) => binding?.state === 'bound'),
      'First inference began before persistent member reconciliation',
    );
    const toolResult = input.messages.findLast((message) => message.role === 'tool');
    if (toolResult) {
      const value = JSON.parse(toolResult.content) as { value: Array<{ id: string }> };
      assert(Array.isArray(value.value));
      assert(
        value.value.some((entry) => entry.id === leaderId),
        'First-turn coordination did not return the adopted Leader',
      );
    }
    const id = `first-turn-${modelCalls}`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    send({ role: 'assistant' });
    if (!toolResult)
      send({
        tool_calls: [
          {
            index: 0,
            id,
            type: 'function',
            function: {
              name: 'ltcook_team',
              arguments: JSON.stringify({ command: { type: 'guidance.inspect' } }),
            },
          },
        ],
      });
    else send({ content: 'First-turn coordination succeeded.' });
    send({}, toolResult ? 'stop' : 'tool_calls');
    response.end('data: [DONE]\n\n');
  } catch (error) {
    providerError = error;
    response.writeHead(500).end('Scripted first-turn fixture failed');
  }
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const providerAddress = provider.address();
assert(providerAddress && typeof providerAddress !== 'string');
await writeFile(
  path.join(piHome, 'models.json'),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
        api: 'openai-completions',
        apiKey: 'fake-local-key',
        models: [
          {
            id: 'test',
            name: 'Offline startup fixture',
            contextWindow: 32768,
            maxTokens: 1024,
            input: ['text'],
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
);
const environment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  ),
  PI_CODING_AGENT_DIR: piHome,
  LTCOOK_PI_AUTH_DIR: authHome,
  PI_OFFLINE: '1',
  LTCOOK_MODEL_SMART: 'fixture/test',
  LTCOOK_MODEL_SMOL: 'fixture/test',
  LTCOOK_MODEL_PLAN: 'fixture/test',
  LTCOOK_GUIDANCE_DIR: path.join(directory, 'guidance'),
  LTCOOK_BROWSER_ENABLED: 'false',
  LTCOOK_CODESEARCH_ENABLED: 'false',
  LTCOOK_CONTEXT7_ENABLED: 'false',
};
const api = new RuntimeApi(undefined, secret, listen, environment);
await api.listen();
let host: Awaited<ReturnType<typeof startPaseoHost>> | undefined;
let runtime: ReturnType<typeof createRuntime> | undefined;
let nativeUnavailable = false;
try {
  host = await startPaseoHost({
    node,
    home: path.join(deployment, 'paseo'),
    deploymentRoot: deployment,
    listen: '127.0.0.1:0',
    runtimeApiUrl: endpoint,
    userToken: secret,
    pluginDirectory: path.join(root, 'runtime/src/paseo-plugin'),
    environment,
    piCommand: path.join(root, 'runtime/dist/integrations/pi-rpc.js'),
  });
  const backend = await createPaseoAgentBackend({
    api: host.api,
    python: 'unused-prepared-environment',
    runtimeApiUrl: endpoint,
    piHome,
    extensionPath: path.join(root, 'runtime/dist/integrations/pi-extension.js'),
    appNodeModules: path.join(root, 'node_modules'),
    deploymentNode: node,
    browserAvailable: false,
    preparedEnvironment: environment,
    identity(id) {
      return { agentId: id, token: agentBearer(secret, id) };
    },
    thinking: 'off',
  });
  const createController = () =>
    createRuntime({
      databasePath: path.join(directory, 'coordination.sqlite'),
      stateDirectory: path.join(directory, 'state'),
      team,
      teams,
      agents: {
        ...backend,
        async list() {
          if (nativeUnavailable) throw new Error('Native directory temporarily unavailable');
          return backend.list();
        },
        async create(options) {
          // > Keep the first child unresolved long enough to expose a Leader turn racing startup.
          await new Promise((resolve) => setTimeout(resolve, 3500));
          return backend.create(options);
        },
      },
    });
  runtime = createController();
  api.setRuntime(runtime);
  api.setOpenWorkspaceHandler(async (request) =>
    runtime!.openSession({
      id: request.sessionId,
      workspaceRoot: request.workspaceRoot,
      teamSelection: request.teamSelection,
      ...(request.leaderAgentId ? { leaderAgentId: request.leaderAgentId } : {}),
    }),
  );
  api.setPrepareSessionHandler(async (request) => {
    const snapshot = runtime!.snapshot(request.sessionId);
    const member = snapshot.definition.members.find((member) => member.key === 'leader');
    assert(member);
    const prepared = await backend.prepare(
      {
        member,
        sessionId: request.sessionId,
        teamInstanceId: snapshot.session.teamInstanceId,
        teamId: snapshot.session.teamId,
        workspaceRoot: request.workspaceRoot,
      },
      request.leaderAgentId,
    );
    return {
      env: prepared.env,
      ...(prepared.mcpServers ? { mcpServers: prepared.mcpServers } : {}),
    };
  });
  const leader = await host.api.agents.create({
    agentId: leaderId,
    idempotencyKey: leaderId,
    cwd: workspace,
    config: { provider: 'ltcook/fixture/test', thinkingOptionId: 'off' },
    metadata: { 'ltcook.team': 'default-minimal' },
  });
  assert.equal(leader.id, leaderId);
  assert(
    runtime.snapshot(leaderId).members.some(({ binding }) => binding?.state !== 'bound'),
    'Fixture failed to preserve the startup race',
  );
  await leader.run('Inspect this Team immediately.', { timeoutMs: 30_000 });
  if (providerError) throw providerError;
  assert.equal(modelCalls, 2);
  const deadline = Date.now() + 30_000;
  while (runtime.snapshot(leaderId).members.some(({ binding }) => binding?.state !== 'bound')) {
    if (Date.now() > deadline)
      throw new Error('Leader startup did not reconcile persistent members');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const snapshot = runtime.snapshot(leaderId);
  assert.equal(
    snapshot.members.find(({ member }) => member.key === 'leader')?.binding?.nativeAgentId,
    leaderId,
  );
  const ids = snapshot.members.map(({ binding }) => binding!.nativeAgentId).sort();
  assert.equal(new Set(ids).size, 2);
  const childId = snapshot.members.find(({ member }) => member.key === 'adjutant')?.binding
    ?.nativeAgentId;
  assert(childId);
  assert.equal(
    (await host.api.agents.ref(childId).refresh())?.agent.labels['paseo.parent-agent-id'],
    leaderId,
  );
  assert.equal(
    (await host.api.agents.list()).entries.filter(({ agent }) => ids.includes(agent.id)).length,
    2,
  );
  await runtime.close();
  runtime = createController();
  api.setRuntime(runtime);
  await runtime.openSession({
    id: leaderId,
    workspaceRoot: workspace,
    teamSelection: 'default-minimal',
    leaderAgentId: leaderId,
  });
  nativeUnavailable = true;
  await leader.reload();
  const callsBeforeUnavailablePrompt = modelCalls;
  await leader.run('Inspect while native initialization is unavailable.', { timeoutMs: 30_000 });
  assert.equal(
    modelCalls,
    callsBeforeUnavailablePrompt,
    'Unavailable runtime must stop the user prompt before inference',
  );
  nativeUnavailable = false;
  await leader.run('Inspect this Team after runtime restart.', { timeoutMs: 30_000 });
  if (providerError) throw providerError;
  assert.deepEqual(
    runtime
      .snapshot(leaderId)
      .members.map(({ binding }) => binding!.nativeAgentId)
      .sort(),
    ids,
  );
  assert.equal(
    (await host.api.agents.list()).entries.filter(({ agent }) => ids.includes(agent.id)).length,
    2,
  );
  console.log(
    JSON.stringify({
      result: 'passed',
      leaderId,
      agents: ids.length,
      restart: 'coordination owner reopened; native identities retained',
      modelCalls,
      firstTurn: 'native coordination succeeded during delayed child startup',
      unavailableRuntime: 'prompt handled without inference; explicit retry succeeded',
    }),
  );
} finally {
  await host?.close();
  await runtime?.close();
  await api.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
}

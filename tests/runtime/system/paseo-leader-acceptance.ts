import assert from 'node:assert/strict';
import { PluginAttachmentItemSchema } from '@getpaseo/plugin';
import { createHostClient } from '@getpaseo/client/node';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import { WorkspaceMcp } from '../../../runtime/src/integrations/mcp.js';
import { ToolCatalog } from '../../../runtime/src/tools/catalog.js';
import { createPaseoMemorySource } from '../../../runtime/src/integrations/paseo-memory.js';
import { agentBearer, RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import { SessionActivation } from '../../../runtime/src/integrations/session-activation.js';
import {
  createPaseoAgentBackend,
  startPaseoHost,
} from '../../../runtime/src/integrations/paseo.js';
import { catalogModelAliases } from '../../../runtime/src/models/aliases.js';
import { TeamRegistry } from '../../../runtime/src/integrations/team-loader.js';
import { ConversationRecords } from '../../../runtime/src/session-memory/conversation.js';
import type { MemoryMessage } from '../../../runtime/src/paseo-plugin/server/memory-text.js';
import { PastedDocuments } from '../../../runtime/src/session-memory/pasted-documents.js';
import type { MemorySourceMessage } from '../../../runtime/src/session-memory/units.js';
import { createSessionMemoryTool } from '../../../runtime/src/tools/session-memory.js';

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
const requirementMessageId = randomUUID();
const userRequirement = 'Keep the cobalt fixture unchanged.';
const pastedText = 'Fixture reference material. '.repeat(100) + 'PASTE_REFERENCE_SENTINEL';
const pastedDocuments = new PastedDocuments(path.join(directory, 'pasted-documents'), secret);
const runtimeHandoff = 'Inspect the cobalt fixture for the acceptance case.';
const memoryPrompt = 'Read the shared cobalt fixture requirement.';
let peerMemoryRead = false;
let attachmentReachedPi = false;
let modelCalls = 0;
let expectedModel = 'test';
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
    assert.equal(input.model, expectedModel, 'Inference must use the saved physical model');
    assert(
      runtime!.snapshot(leaderId).members.every(({ binding }) => binding?.state === 'bound'),
      'First inference began before persistent member reconciliation',
    );
    const userIndex = input.messages.findLastIndex((message) => message.role === 'user');
    attachmentReachedPi ||= JSON.stringify(input.messages[userIndex]?.content ?? '').includes(
      'PASTE_REFERENCE_SENTINEL',
    );
    const readsMemory = JSON.stringify(input.messages[userIndex]?.content ?? '').includes(
      memoryPrompt,
    );
    const toolResult = input.messages.slice(userIndex + 1).findLast(({ role }) => role === 'tool');
    if (readsMemory && toolResult) {
      assert.match(toolResult.content, /Keep the cobalt fixture unchanged/);
      assert.match(toolResult.content, /First-turn coordination succeeded/);
      assert.match(toolResult.content, /original-message/);
      peerMemoryRead = true;
    } else if (toolResult) {
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
              name: readsMemory ? 'session-memory' : 'ltcook_team',
              arguments: JSON.stringify(
                readsMemory
                  ? { agentId: leaderId, query: 'cobalt fixture coordination succeeded' }
                  : { command: { type: 'guidance.inspect' } },
              ),
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
          {
            id: 'changed-by-user',
            name: 'Explicit native override',
            contextWindow: 32768,
            maxTokens: 1024,
            input: ['text'],
            reasoning: true,
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
  LTCOOK_MODEL_EXPENSIVE: 'fixture/test',
  LTCOOK_MODEL_TINY_LOCAL: 'fixture-model',
  LTCOOK_MODEL_LOCAL_CPU: 'fixture-cpu',
  LTCOOK_MODEL_LOCAL_EVALS: 'fixture-evals',
  LTCOOK_GUIDANCE_DIR: path.join(directory, 'guidance'),
  LTCOOK_BROWSER_ENABLED: 'false',
  LTCOOK_CODESEARCH_ENABLED: 'false',
  LTCOOK_CONTEXT7_ENABLED: 'false',
};
const activation = new SessionActivation(environment);
const api = new RuntimeApi(undefined, secret, listen, activation, environment);
await api.listen();
let host: Awaited<ReturnType<typeof startPaseoHost>> | undefined;
let runtime: ReturnType<typeof createRuntime> | undefined;
let memory: ConversationRecords | undefined;
let nativeUnavailable = false;
const observedSources = new Map<string, MemoryMessage>();
async function waitFor<T>(label: string, read: () => T | undefined | Promise<T | undefined>) {
  const deadline = Date.now() + 10_000;
  do {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}
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
    memoryProvenanceSecret: secret,
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
      memory,
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
  const startMemory = () => {
    const source = createPaseoMemorySource(host!.api, secret, pastedDocuments);
    const instance = new ConversationRecords({
      databasePath: path.join(directory, 'conversation.sqlite'),
      source: {
        ...source,
        async read(...args) {
          const page = await source.read(...args);
          for (const message of page.messages) {
            if (message.text.includes(runtimeHandoff)) observedSources.set(runtimeHandoff, message);
            if (message.text === userRequirement) observedSources.set(userRequirement, message);
          }
          return page;
        },
      },
      threshold: 1,
      peers: (agentId, workspaceRoot) => runtime?.memoryPeers(agentId, workspaceRoot) ?? [],
    });
    api.setConversationRecords(instance);
    return instance;
  };
  memory = startMemory();
  runtime = createController();
  api.setRuntime(runtime);
  const memoryTool = createSessionMemoryTool(memory);
  const tools = new ToolCatalog([memoryTool]);
  api.setWorkspaceTools(tools);
  api.setWorkspaceMcp(new WorkspaceMcp(tools, listen));
  api.setPastedDocuments(pastedDocuments);
  activation.setWorkspaceActivator(async (request) =>
    runtime!.openSession({
      id: request.sessionId,
      workspaceRoot: request.workspaceRoot,
      teamSelection: request.teamSelection,
      ...(request.leaderAgentId ? { leaderAgentId: request.leaderAgentId } : {}),
    }),
  );
  const leaderFor = (selection: string) => {
    const { definition } = teams.resolve(selection);
    const leader = definition.members.find((member) => member.key === definition.leaderKey);
    assert(leader);
    return leader;
  };
  api.setModelSelectionHandlers({
    catalog: ({ teamSelection }) => catalogModelAliases(leaderFor(teamSelection), environment),
    resolve: ({ teamSelection, workspaceRoot, alias, reasoning }) =>
      backend.resolveSelection(workspaceRoot, leaderFor(teamSelection), alias, reasoning),
  });
  api.setPrepareSessionHandler(async (options, leaderAgentId, savedModel) => {
    const prepared = await backend.prepare(options, leaderAgentId, savedModel);
    return {
      env: prepared.env,
      ...(prepared.mcpServers ? { mcpServers: prepared.mcpServers } : {}),
    };
  });
  const leader = await host.api.agents.create({
    agentId: leaderId,
    idempotencyKey: leaderId,
    cwd: workspace,
    config: { provider: 'ltcook/fixture/draft-placeholder' },
    metadata: { 'ltcook.team': 'default-minimal', 'ltcook.reasoning': 'none' },
  });
  assert.equal(leader.id, leaderId);
  assert(
    runtime.snapshot(leaderId).members.some(({ binding }) => binding?.state !== 'bound'),
    'Fixture failed to preserve the startup race',
  );
  const requestAttachment = (bearer: string) =>
    fetch(endpoint + '/v1/session-memory/paste', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nativeAgentId: leaderId, text: pastedText }),
    });
  assert.equal((await requestAttachment(agentBearer(secret, leaderId))).status, 403);
  const attached = await requestAttachment(secret);
  assert.equal(attached.status, 200);
  const attachment = PluginAttachmentItemSchema.parse(await attached.json());
  await leader.run(userRequirement + '\n\n' + attachment.identifier, {
    timeoutMs: 30_000,
    messageId: requirementMessageId,
    attachments: [{ type: 'text', mimeType: 'text/plain', text: attachment.text }],
  });
  if (providerError) throw providerError;
  assert.equal(modelCalls, 2);
  assert(attachmentReachedPi);
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
  const source = await waitFor('the native user message to reach Session Memory', () =>
    observedSources.get(userRequirement),
  );
  assert.equal(source.author, 'user');
  assert.equal((source as MemorySourceMessage).attachments?.[0]?.text, pastedText);
  const toolContext = {
    agentId: childId,
    workspaceRoot: workspace,
    sessionId: leaderId,
    workspaceFileAccess: false,
    signal: AbortSignal.timeout(30_000),
  };
  const memoryReference = await waitFor('the saved cobalt fixture requirement', async () => {
    const result = await memoryTool.invoke(
      { agentId: leaderId, query: 'cobalt fixture' },
      toolContext,
    );
    const matches = result.matches as Array<{ epoch: string; entries: Array<{ text: string }> }>;
    const match = matches.find(({ entries }) =>
      entries.some(({ text }) => text === userRequirement),
    );
    return match ? { agentId: leaderId, epoch: match.epoch, seq: source.seq } : undefined;
  });
  const task = (await runtime.execute(
    leaderId,
    { kind: 'user' },
    {
      type: 'task.create',
      title: 'Inspect cobalt fixture',
      workType: 'task.investigate',
      description: runtimeHandoff,
      acceptance: 'Report the observed fixture state.',
    },
  )) as { id: string };
  await runtime.execute(
    leaderId,
    { kind: 'user' },
    {
      type: 'assignment.create',
      taskId: task.id,
      memberKey: 'adjutant',
      message: runtimeHandoff,
    },
  );
  await host.api.agents.ref(childId).waitForFinish(30_000);
  if (providerError) throw providerError;
  const assignmentSource = await waitFor('the runtime assignment to reach Session Memory', () =>
    observedSources.get(runtimeHandoff),
  );
  assert.equal(assignmentSource.author, 'runtime');
  // > The previous physical model remains registered, as it does in an AppRC workspace.
  environment.LTCOOK_MODEL_SMART = 'fixture/replacement';
  await memory.close();
  await runtime.close();
  memory = startMemory();
  runtime = createController();
  api.setRuntime(runtime);
  const reopenedTool = createSessionMemoryTool(memory);
  const reopenedTools = new ToolCatalog([reopenedTool]);
  api.setWorkspaceTools(reopenedTools);
  api.setWorkspaceMcp(new WorkspaceMcp(reopenedTools, listen));
  await runtime.openSession({
    id: leaderId,
    workspaceRoot: workspace,
    teamSelection: 'default-minimal',
    leaderAgentId: leaderId,
  });
  const savedSource = await reopenedTool.invoke(
    { source: memoryReference },
    {
      ...toolContext,
      signal: AbortSignal.timeout(10_000),
    },
  );
  assert.partialDeepStrictEqual(savedSource.source, {
    ...memoryReference,
    author: 'user',
    text: userRequirement,
    attachments: [{ text: pastedText }],
  });
  nativeUnavailable = true;
  await leader.reload();
  assert.deepEqual(
    (await host.api.agents.ref(leaderId).refresh())?.agent.metadata?.['ltcook.resolved-model'],
    {
      alias: 'smart',
      provider: 'fixture',
      model: 'test',
      reasoning: 'none',
      reasoningSource: 'session',
    },
  );
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
  await waitFor('the Pi prompt recovered without confirmed authorship', async () => {
    const result = await reopenedTool.invoke(
      { agentId: leaderId, query: 'cobalt fixture' },
      { ...toolContext, signal: AbortSignal.timeout(5000) },
    );
    const matches = result.matches as Array<{
      epoch: string;
      entries: Array<{ kind: string; author: string; seq: number; text: string }>;
    }>;
    const match = matches[0];
    const entry = match?.entries.find(({ text }) => text === userRequirement);
    if (!entry || !match || match.epoch === memoryReference.epoch) return undefined;
    assert.equal(entry.author, 'unknown');
    assert.equal(entry.kind, 'unattributed-prompt');
    const citation = { agentId: leaderId, epoch: match.epoch, seq: entry.seq };
    const source = await reopenedTool.invoke(
      { source: citation },
      { ...toolContext, signal: AbortSignal.timeout(5000) },
    );
    assert.partialDeepStrictEqual(source.source, {
      ...citation,
      author: 'unknown',
      text: userRequirement,
      attachments: [{ id: attachment.id, name: 'Pasted text', text: pastedText }],
    });
    return true;
  });
  const peerTurn = await host.api.agents.ref(childId).run(memoryPrompt, { timeoutMs: 30_000 });
  if (providerError) throw providerError;
  assert.equal(peerTurn.status, 'idle', peerTurn.error);
  assert(peerMemoryRead, 'The adjutant did not read the leader memory through its native Pi tool');
  const peerUpdate = 'Inspect the fixture with the authorized native peer report.';
  const peerDelivery = await leader.run(peerUpdate, { sourceAgentId: childId, timeoutMs: 30_000 });
  if (providerError) throw providerError;
  assert.equal(peerDelivery.status, 'idle', peerDelivery.error);
  const deliveryMemory = await createPaseoMemorySource(host.api, secret).read(
    leaderId,
    undefined,
    'tail',
  );
  assert.equal(deliveryMemory.messages.find(({ text }) => text === peerUpdate)?.author, 'runtime');
  const nativeControls = createHostClient(host.listen, { clientId: 'ltcook-override-acceptance' });
  try {
    await nativeControls.connect();
    const notice = await nativeControls.applyAgentConfig(leaderId, {
      modelId: 'fixture/changed-by-user',
      thinkingOptionId: 'low',
    });
    assert.equal(notice, null);
    expectedModel = 'changed-by-user';
    const reopened = await leader.reload();
    assert.equal(reopened?.agent.runtimeInfo?.model, 'fixture/changed-by-user');
    assert.equal(reopened?.agent.runtimeInfo?.thinkingOptionId, 'low');
    await leader.run('Inspect using the model I selected in the native controls.', {
      timeoutMs: 30_000,
    });
    if (providerError) throw providerError;
    const activeReference = await waitFor('the citation rebuilt after Pi reload', async () => {
      const result = await reopenedTool.invoke(
        { agentId: leaderId, query: 'cobalt fixture' },
        { ...toolContext, signal: AbortSignal.timeout(5000) },
      );
      const matches = result.matches as Array<{
        epoch: string;
        entries: Array<{ text: string; seq: number }>;
      }>;
      const match = matches[0];
      const citation = match?.entries.find(({ text }) => text === userRequirement)?.seq;
      return match && citation !== undefined
        ? { agentId: leaderId, epoch: match.epoch, seq: citation }
        : undefined;
    });
    const history = await leader.timeline.refetch({ projection: 'canonical', limit: 0 });
    const cited = history.entries.find(({ seqEnd }) => seqEnd === activeReference.seq)?.item;
    assert(cited?.type === 'user_message' && cited.messageId, 'Paseo must expose Pi’s rewind ID');
    const rewound = await nativeControls.rewindAgent(leaderId, cited.messageId, 'conversation');
    assert.equal(rewound.ok, true, rewound.error ?? 'Pi rewind failed');
    assert.notEqual(
      (await leader.timeline.refetch({ projection: 'canonical', limit: 1 })).epoch,
      activeReference.epoch,
    );
    const staleSource = await reopenedTool.invoke(
      { source: activeReference },
      {
        ...toolContext,
        signal: AbortSignal.timeout(10_000),
      },
    );
    assert.equal(staleSource.source, undefined, 'Pi rewind must invalidate the old citation');
  } finally {
    await nativeControls.close();
  }
  console.log(
    JSON.stringify({
      result: 'passed',
      leaderId,
      agents: ids.length,
      restart: 'coordination owner reopened; native identities retained',
      modelCalls,
      firstTurn: 'native coordination succeeded during delayed child startup',
      unavailableRuntime: 'prompt handled without inference; explicit retry succeeded',
      sessionMemory:
        'native provenance, restart, shared Pi read, and citation invalidation on rewind',
    }),
  );
} finally {
  await host?.close();
  await memory?.close();
  await runtime?.close();
  await api.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
}

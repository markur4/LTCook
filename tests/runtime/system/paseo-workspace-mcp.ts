import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { startPaseoHost } from '../../../runtime/src/integrations/paseo.js';
import { RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import { WorkspaceMcp } from '../../../runtime/src/integrations/mcp.js';
import { createTools } from '../../../runtime/src/tools/catalog.js';
import { RiedService } from '../../../runtime/src/repository/discovery.js';

const root = path.resolve(import.meta.dir, '../../..');
const fixture = process.argv[2];
assert(fixture, 'An isolated fixture directory is required.');
const workspace = path.join(fixture, 'workspace');
const deployment = path.join(fixture, 'deployment');
const pi = path.join(fixture, 'pi');
await Promise.all([workspace, deployment, pi].map((dir) => mkdir(dir, { recursive: true })));
const hostDir = path.join(deployment, 'paseo');
const model = 'gpt-5.4';
const material = 'Release R-17 passed 42 checks but did not deploy. The cause is uncertain.';
const summary = 'R-17 passed 42 checks and did not deploy. The cause is uncertain.';
const summaryModel = 'fixture-summary';
const verifyColgrep = Boolean(process.env.LTCOOK_COLGREP_DEPLOYMENT);
if (verifyColgrep) {
  process.env.LTCOOK_COLGREP_CACHE_DIR = path.join(fixture, 'colgrep-cache');
}
await writeFile(
  path.join(workspace, 'checksum.ts'),
  'export function computeReleaseChecksum(value: number) { return value % 65521; }\n',
);
await writeFile(path.join(workspace, 'notes.txt'), material);
let tool = 'ltcook_ried';
let argumentsJson = '{"operation":"summary"}';
type FixtureTool = {
  type?: string;
  name?: string;
  function?: { name: string };
  tools?: Array<{ name: string }>;
};
function toolNames(tools: FixtureTool[]) {
  return tools.flatMap((tool) =>
    tool.tools
      ? tool.tools.map((item) => `${tool.name}__${item.name}`)
      : [tool.name ?? tool.function?.name],
  );
}
let marker = '';
let calls = 0;
let providerError: unknown;
const provider = createServer(async (request, response) => {
  try {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
      return;
    }
    let text = '';
    for await (const data of request) text += data;
    const input = JSON.parse(text);
    if (request.url === '/api/chat') {
      assert.equal(input.model, summaryModel);
      assert.equal(input.messages[1]?.content, material);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          model: summaryModel,
          message: { content: summary },
          done: true,
          done_reason: 'stop',
        }),
      );
      return;
    }
    const servedTool = `mcp__ltcook_workspace__${tool}`;
    const codex = request.url?.endsWith('/responses');
    const messages = codex ? input.input : input.messages;
    const result = messages?.findLast((item: Record<string, unknown>) =>
      codex
        ? item.type === 'function_call_output' && item.call_id === marker
        : item.role === 'tool' && item.tool_call_id === marker,
    );
    const searched =
      codex &&
      messages?.findLast(
        (item: Record<string, unknown>) =>
          item.type === 'tool_search_output' && item.call_id === `search_${marker}`,
      );
    let useSearch = false;
    let namespace: string | undefined;
    if (result) {
      const returned = JSON.stringify(result);
      assert(
        tool === 'ltcook_ried'
          ? returned.includes(workspace) && returned.includes('workspaceRoot')
          : tool === 'ltcook_repo_search' || tool === 'ltcook_repo_locate'
            ? returned.includes('checksum.ts') &&
              returned.includes('computeReleaseChecksum') &&
              returned.includes(marker.endsWith('_ripgrep') ? 'ripgrep' : 'colgrep') &&
              (tool !== 'ltcook_repo_locate' || returned.includes('searches'))
            : returned.includes(summary) && returned.includes(summaryModel),
        `Tool result was not returned in ${marker}: ${returned.slice(0, 500)}`,
      );
      calls++;
    } else {
      const tools = input.tools as FixtureTool[];
      const available: FixtureTool[] = searched?.tools ?? tools;
      const names = toolNames(available);
      namespace = available.find(
        (candidate) =>
          candidate.name === 'mcp__ltcook_workspace' &&
          candidate.tools?.some(({ name }) => name === tool),
      )?.name;
      useSearch =
        codex &&
        !searched &&
        !names.includes(servedTool) &&
        tools.some((tool) => tool.type === 'tool_search');
      if (!useSearch) {
        assert.deepEqual(
          names.filter((name) => name?.endsWith(tool)),
          [servedTool],
          marker,
        );
      }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (codex) {
      const item = result
        ? {
            type: 'message',
            id: 'msg_' + marker,
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: 'The MCP tool returned a result.', annotations: [] },
            ],
          }
        : useSearch
          ? {
              type: 'tool_search_call',
              execution: 'client',
              id: 'search_' + marker,
              call_id: 'search_' + marker,
              arguments: {
                query:
                  tool === 'ltcook_ried'
                    ? 'repository environment inventory ried'
                    : 'summarize text using local Ollama',
              },
              status: 'completed',
            }
          : {
              type: 'function_call',
              id: 'fc_' + marker,
              call_id: marker,
              ...(namespace ? { namespace, name: tool } : { name: servedTool }),
              arguments: argumentsJson,
              status: 'completed',
            };
      const send = (type: string, fields: object) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      const id = `response_${marker}_${result ? 'final' : useSearch ? 'search' : 'call'}`;
      send('response.created', { response: { id, output: [], status: 'in_progress' } });
      send('response.output_item.added', { output_index: 0, item });
      send('response.output_item.done', { output_index: 0, item });
      send('response.completed', {
        response: {
          id,
          output: [item],
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      response.end();
    } else {
      const send = (delta: unknown, finish_reason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({
            id: marker,
            object: 'chat.completion.chunk',
            created: 1,
            model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      send({ role: 'assistant' });
      if (result) send({ content: 'The MCP tool returned a result.' });
      else
        send({
          tool_calls: [
            {
              index: 0,
              id: marker,
              type: 'function',
              function: { name: servedTool, arguments: argumentsJson },
            },
          ],
        });
      send({}, result ? 'stop' : 'tool_calls');
      response.end('data: [DONE]\n\n');
    }
  } catch (error) {
    providerError = error;
    response.statusCode = 500;
    response.end('Offline MCP fixture failed');
  }
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address();
assert(address && typeof address !== 'string');
const endpoint = `http://127.0.0.1:${address.port}/v1`;
await writeFile(
  path.join(pi, 'models.json'),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: endpoint,
        api: 'openai-completions',
        apiKey: 'offline-fixture',
        models: [
          {
            id: model,
            name: 'Offline MCP fixture',
            reasoning: false,
            input: ['text'],
            contextWindow: 32000,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
);
const codex = path.join(fixture, '.codex');
await mkdir(codex, { recursive: true });
await writeFile(
  path.join(codex, 'config.toml'),
  [
    'model_provider = "ltcook_fixture"',
    '[model_providers.ltcook_fixture]',
    'name = "Offline MCP fixture"',
    `base_url = "${endpoint}"`,
    'env_key = "LTCOOK_TEST_MODEL_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
  ].join('\n'),
);
const listenProbe = createServer();
await new Promise<void>((resolve) => listenProbe.listen(0, '127.0.0.1', resolve));
const apiAddress = listenProbe.address();
assert(apiAddress && typeof apiAddress !== 'string');
await new Promise<void>((resolve) => listenProbe.close(() => resolve()));
const authority = `127.0.0.1:${apiAddress.port}`;
const secret = 'offline-mcp-runtime';
let api: RuntimeApi | undefined;
let host: Awaited<ReturnType<typeof startPaseoHost>> | undefined;
async function start() {
  api = new RuntimeApi(undefined, secret, authority);
  api.setWorkspaceMcp(
    new WorkspaceMcp(
      createTools(new RiedService(path.join(fixture, 'cache'), undefined, () => ({ PATH: '' })), {
        endpoint: new URL(endpoint).origin,
        model: summaryModel,
        keepAlive: -1,
      }),
      authority,
    ),
  );
  await api.listen();
  host = await startPaseoHost({
    node: process.env.LTCOOK_TEST_NODE ?? 'node',
    home: hostDir,
    deploymentRoot: deployment,
    listen: '127.0.0.1:0',
    runtimeApiUrl: `http://${authority}`,
    userToken: secret,
    pluginDirectory: path.join(root, 'runtime/src/paseo-plugin'),
    piCommand: path.join(root, 'runtime/dist/integrations/pi-rpc.js'),
    environment: {
      ...process.env,
      LTCOOK_PI_AUTH_DIR: pi,
      PI_CODING_AGENT_DIR: pi,
      LTCOOK_RIED_CACHE_DIR: path.join(fixture, 'cache'),
      LTCOOK_BRIEF_EXECUTABLE: path.join(fixture, 'unused-brief'),
      LTCOOK_TEST_MODEL_KEY: 'offline-fixture',
    },
  });
  return host;
}
async function stop() {
  await host?.close();
  host = undefined;
  await api?.close();
  api = undefined;
}
async function exercise(
  agent: Awaited<ReturnType<NonNullable<typeof host>['api']['agents']['create']>>,
  phase: string,
  toolInput?:
    | { path: string }
    | { text: string }
    | { symbol: string }
    | { query: string; mode?: 'exact'; pattern?: string },
) {
  tool =
    toolInput && 'symbol' in toolInput
      ? 'ltcook_repo_locate'
      : toolInput && 'query' in toolInput
        ? 'ltcook_repo_search'
        : toolInput
          ? 'ltcook_summarize'
          : 'ltcook_ried';
  argumentsJson = JSON.stringify(toolInput ?? { operation: 'summary' });
  marker = `call_${phase}`;
  const before = calls;
  let outcome = await agent.run(`Call ${tool}. Fixture phase ${phase}.`, {
    timeoutMs: 30_000,
  });
  if (outcome.status === 'permission') {
    const pending = outcome.final?.pendingPermissions ?? [];
    assert.equal(pending.length, 1);
    assert(
      JSON.stringify(pending[0]).includes(tool),
      'Unexpected permission in the offline fixture.',
    );
    await agent.respondToPermission({ requestId: pending[0]!.id, response: { behavior: 'allow' } });
    outcome = await agent.waitForFinish(30_000);
  }
  if (providerError) throw providerError;
  assert.equal(outcome.status, 'idle', outcome.error ?? phase);
  assert.equal(calls, before + 1, `${tool} did not run through ${phase}.`);
}
try {
  let active = await start();
  const ordinaryPi = await active.api.agents.create({
    cwd: workspace,
    config: { provider: `pi/fixture/${model}` },
  });
  await exercise(ordinaryPi, 'pi_fresh');
  if (Bun.which('rg'))
    await exercise(ordinaryPi, 'pi_locate_ripgrep', { symbol: 'computeReleaseChecksum' });
  if (verifyColgrep)
    await exercise(ordinaryPi, 'pi_searches_repository', {
      query: 'calculate the release checksum',
      pattern: 'computeReleaseChecksum',
    });
  const ordinaryCodex = await active.api.agents.create({
    cwd: workspace,
    config: { provider: `codex/${model}` },
  });
  await exercise(ordinaryCodex, 'codex_fresh');
  if (Bun.which('rg'))
    await exercise(ordinaryCodex, 'codex_locate_ripgrep', { symbol: 'computeReleaseChecksum' });
  if (Bun.which('rg'))
    await exercise(ordinaryCodex, 'codex_searches_ripgrep', {
      query: 'computeReleaseChecksum',
      mode: 'exact',
    });
  if (verifyColgrep)
    await exercise(ordinaryCodex, 'codex_searches_colgrep', {
      query: 'calculate the release checksum',
      pattern: 'computeReleaseChecksum',
    });
  await ordinaryCodex.reload();
  await exercise(ordinaryCodex, 'codex_warm_resume');
  await stop();
  active = await start();
  await exercise(active.api.agents.ref(ordinaryPi.id), 'pi_restart_resume');
  await exercise(active.api.agents.ref(ordinaryCodex.id), 'codex_restart_resume');
  await exercise(active.api.agents.ref(ordinaryPi.id), 'pi_summarizes_file', { path: 'notes.txt' });
  await exercise(active.api.agents.ref(ordinaryCodex.id), 'codex_summarizes_text', {
    text: material,
  });
  console.log(JSON.stringify({ result: 'passed', verifiedToolCalls: calls }));
} finally {
  await stop();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
}

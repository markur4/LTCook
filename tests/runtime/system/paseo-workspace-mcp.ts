import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { Value } from 'typebox/value';
import {
  gradeRepositoryBehavior,
  RepositoryBehaviorAnswer,
} from '../../../evals/repository-behavior-grade.js';
import { EVAL_CONTEXT_WINDOW, EVAL_MODEL_COMPAT } from '../../../runtime/src/evals/setup.js';
import { startPaseoHost } from '../../../runtime/src/integrations/paseo.js';
import { RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import { SessionActivation } from '../../../runtime/src/integrations/session-activation.js';
import { WorkspaceMcp } from '../../../runtime/src/integrations/mcp.js';
import { ollamaEndpoint } from '../../../runtime/src/integrations/ollama.js';
import { createTools, ToolCatalog } from '../../../runtime/src/tools/catalog.js';
import { RiedService } from '../../../runtime/src/repository/discovery.js';
import { RepositoryLocateOutputSchema } from '../../../runtime/src/tools/repo-locate.js';
import { RepositorySearchOutputSchema } from '../../../runtime/src/tools/repo-search.js';

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
const agentPrompt = 'Preserve the fixture workspace instructions.';
const liveModel = process.env.LTCOOK_NATIVE_PI_MODEL;
const verifyColgrep = Boolean(process.env.LTCOOK_COLGREP_DEPLOYMENT);
if (verifyColgrep) {
  process.env.LTCOOK_COLGREP_CACHE_DIR = path.join(fixture, 'colgrep-cache');
}
const retryPath = 'channel-retries.ts';
const retrySource = [
  "export const releaseRetryLimit = (channel: 'stable' | 'preview') => {",
  "  if (channel === 'stable') return 12;",
  "  if (channel === 'preview') return 48;",
  '  return 0;',
  '};',
  '',
].join('\n');
const checksumSource =
  'export function computeReleaseChecksum(value: number) { return value % 65521; }\n';
await writeFile(path.join(workspace, 'checksum.ts'), checksumSource);
await writeFile(path.join(workspace, retryPath), retrySource);
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
let verifyRepositoryResult: ((content: string) => void) | undefined;
const verifiedRepositoryCases: string[] = [];

function verifyRetryEvidence(content: string) {
  assert.match(content, /"provider"\s*:\s*"ripgrep"/);
  assert.match(content, /"status"\s*:\s*"ready"/);
  assert.match(content, /channel-retries\.ts/);
  assert.match(content, /^2 \|   if \(channel === 'stable'\) return 12;$/m);
  assert.match(content, /^3 \|   if \(channel === 'preview'\) return 48;$/m);
  assert.doesNotMatch(content, /^2 \| .*return 48;|^3 \| .*return 12;/m);
}

function verifyLocateDefinition(content: string) {
  assert.match(content, /"role"\s*:\s*"definition"/);
  assert.match(content, /channel-retries\.ts/);
  assert.match(content, /export const releaseRetryLimit/);
  assert.match(content, /if \(channel === 'stable'\) return 12;/);
  assert.match(content, /if \(channel === 'preview'\) return 48;/);
}

function verifyCodexRetryEvidence(content: string) {
  const result: unknown = JSON.parse(content.replace(/^Wall time:[^\n]*\nOutput:\n/, ''));
  const search = Value.Check(RepositoryLocateOutputSchema, result) ? result.searches[0] : result;
  assert(Value.Check(RepositorySearchOutputSchema, search));
  assert.equal(search.provider, 'ripgrep');
  assert.equal(search.status, 'ready');
  for (const line of [2, 3]) {
    assert(
      search.results.some(
        (hit) =>
          hit.path === retryPath &&
          hit.startLine === line &&
          hit.endLine === line &&
          hit.excerpt === retrySource.split('\n')[line - 1],
      ),
      `Missing verified evidence for ${retryPath}:${line}.`,
    );
  }
}

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
      if (liveCalls.size) {
        response
          .writeHead(422)
          .end('Summarization is unavailable during the live repository check.');
        return;
      }
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
    const codex = request.url?.endsWith('/responses') ?? false;
    const messages = codex ? input.input : input.messages;
    const instructions = JSON.stringify([
      input.instructions,
      ...messages.filter(
        ({ role }: { role?: string }) => role === 'system' || role === 'developer',
      ),
    ]);
    assert(
      instructions.includes(agentPrompt),
      `${marker} needs the agent's existing instructions.`,
    );
    assert.match(instructions, /ltcook_repo_locate[^.]*known symbol/);
    assert.match(instructions, /ltcook_repo_search[^.]*hybrid/);
    assert.match(instructions, /Locate location/);
    assert.match(instructions, /prefer ltcook_web_search for web searches/);
    assert.match(instructions, /ltcook_web_fetch to read sources/);
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
      if (verifyRepositoryResult) {
        const output = codex ? result.output : result.content;
        const content = Array.isArray(output)
          ? output.map((item: { text?: string }) => item.text ?? '').join('\n')
          : output;
        assert.equal(typeof content, 'string', `${marker} needs tool text.`);
        verifyRepositoryResult(content);
        verifiedRepositoryCases.push(marker.slice('call_'.length));
      } else {
        const returned = JSON.stringify(result);
        assert(
          tool === 'ltcook_ried'
            ? returned.includes(workspace) && returned.includes('workspaceRoot')
            : returned.includes(summary) && returned.includes(summaryModel),
          `Tool result was not returned in ${marker}: ${returned.slice(0, 500)}`,
        );
      }
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
              arguments: { query: tool },
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
      ...(liveModel
        ? {
            ollama: {
              baseUrl: new URL(
                '/v1',
                ollamaEndpoint(process.env.LTCOOK_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434'),
              ).toString(),
              api: 'openai-completions',
              apiKey: 'ollama',
              models: [
                {
                  id: liveModel,
                  name: 'Local Pi evaluation model',
                  contextWindow: EVAL_CONTEXT_WINDOW,
                  maxTokens: 512,
                  compat: EVAL_MODEL_COMPAT,
                  samplingParams: { max_tokens: 512, temperature: 0 },
                  reasoning: true,
                  thinkingLevelMap: { off: 'none' },
                },
              ],
            },
          }
        : {}),
    },
  }),
);
if (liveModel) {
  await writeFile(
    path.join(pi, 'settings.json'),
    JSON.stringify({ defaultTools: [], retry: { enabled: false } }),
  );
}
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
type LiveSearch = Parameters<typeof gradeRepositoryBehavior>[0]['searches'][number];
type LiveCall = { tool: string; searches: LiveSearch[] };
const liveCalls = new Map<string, LiveCall[]>();
const absentSymbol = 'releaseBackoffWindow';
async function start() {
  api = new RuntimeApi(undefined, secret, authority, new SessionActivation());
  let tools = createTools(
    new RiedService(path.join(fixture, 'cache'), undefined, () => ({ PATH: '' })),
    {
      endpoint: new URL(endpoint).origin,
      model: summaryModel,
      keepAlive: -1,
    },
  );
  if (liveModel) {
    tools = new ToolCatalog(
      tools.definitions.map((tool) => ({
        ...tool,
        async invoke(input, context) {
          const recorded = liveCalls.get(context.agentId);
          if (!recorded) return tool.invoke(input, context);
          const call: LiveCall = { tool: tool.name, searches: [] };
          recorded.push(call);
          const output = await tool.invoke(input, context);
          const request = input as { paths?: string[]; query?: string };
          const observe = (result: LiveSearch, query: string | undefined) => ({
            ...result,
            relevantToNegative:
              result.kind === 'exhaustive' &&
              query === absentSymbol &&
              (request.paths ?? []).every((value) => value === '.'),
          });
          if (Value.Check(RepositorySearchOutputSchema, output)) {
            call.searches.push(observe(output, request.query));
          } else if (Value.Check(RepositoryLocateOutputSchema, output)) {
            call.searches.push(...output.searches.map((result) => observe(result, result.query)));
          }
          return output;
        },
      })),
    );
  }
  api.setWorkspaceMcp(new WorkspaceMcp(tools, authority));
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

async function exerciseLive(
  active: NonNullable<typeof host>,
  scenario: 'adjacent-lines' | 'empty' | 'unavailable',
) {
  if (!liveModel) return;
  const agent = await active.api.agents.create({
    cwd: workspace,
    config: { provider: `pi/ollama/${liveModel}` },
  });
  const calls: LiveCall[] = [];
  liveCalls.set(agent.id, calls);
  const question =
    scenario === 'empty'
      ? `Does the exact identifier ${absentSymbol} occur anywhere in this repository? If present, give its source path as id implementationFile.`
      : scenario === 'adjacent-lines'
        ? 'In channel-retries.ts, what number is returned for each of the stable and preview conditions on channel? Use fact ids stable and preview, with a separate citation for each.'
        : 'What numeric retry limits does the implementation give to the regular and early-access release channels? Use fact ids stable and preview, with a separate citation for each.';
  const started = performance.now();
  try {
    const outcome = await agent.run(
      `${question}\nRespond with a JSON object with outcome and facts. For a supported answer use outcome "answered" and facts with id, value, and citations. Each citation has path, startLine and endLine. Use outcome "not-found" and facts [] if a completed search found no relevant evidence. Use outcome "insufficient-evidence" and facts [] if evidence is unavailable or insufficient.`,
      { timeoutMs: 45_000 },
    );
    const searches = calls.flatMap((call) => call.searches);
    let answer: unknown;
    try {
      answer = JSON.parse(
        outcome.lastMessage?.trim().replace(/^```(?:json)?\s+|\s+```$/gi, '') ?? '',
      );
    } catch {
      // > A malformed response is recorded without printing the model transcript.
    }
    const parsed = Value.Check(RepositoryBehaviorAnswer, answer) ? answer : undefined;
    const grade = gradeRepositoryBehavior({
      answer: parsed,
      expected:
        scenario === 'empty'
          ? []
          : [
              { id: 'stable', value: 12, evidence: { path: retryPath, startLine: 2, endLine: 2 } },
              { id: 'preview', value: 48, evidence: { path: retryPath, startLine: 3, endLine: 3 } },
            ],
      searches,
      files: new Map([
        [retryPath, retrySource],
        ['checksum.ts', checksumSource],
        ['notes.txt', material],
      ]),
    });
    console.log(
      JSON.stringify({
        livePi: scenario,
        model: liveModel,
        status: outcome.status,
        elapsedMs: performance.now() - started,
        outcome: parsed?.outcome ?? null,
        calls: calls.map(({ tool, searches }) => ({
          tool,
          statuses: searches.map(({ status }) => status),
        })),
        grade,
      }),
    );
  } finally {
    try {
      await agent.archive();
    } finally {
      liveCalls.delete(agent.id);
    }
  }
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
    | { symbol: string; paths?: string[] }
    | { location: { path: string; line: number } }
    | { query: string; mode?: 'exact' | 'semantic'; pattern?: string; paths?: string[] },
  verifyResult?: (content: string) => void,
) {
  tool =
    toolInput && ('symbol' in toolInput || 'location' in toolInput)
      ? 'ltcook_repo_locate'
      : toolInput && 'query' in toolInput
        ? 'ltcook_repo_search'
        : toolInput
          ? 'ltcook_summarize'
          : 'ltcook_ried';
  argumentsJson = JSON.stringify(toolInput ?? { operation: 'summary' });
  marker = `call_${phase}`;
  verifyRepositoryResult = verifyResult;
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
    config: { provider: `pi/fixture/${model}`, systemPrompt: agentPrompt },
  });
  await exercise(ordinaryPi, 'pi_fresh');
  await exercise(
    ordinaryPi,
    'pi_locate_block',
    { location: { path: retryPath, line: 3 } },
    (content) => {
      assert.match(content, /"anchorLine"\s*:\s*3\b/);
      assert.match(content, /"complete"\s*:\s*true/);
      assert.match(content, /^3 \|   if \(channel === 'preview'\) return 48;$/m);
      assert.match(content, /^5 \| \};$/m);
    },
  );
  if (Bun.which('rg')) {
    await exercise(
      ordinaryPi,
      'pi_locate_ripgrep',
      { symbol: 'releaseRetryLimit', paths: [retryPath] },
      verifyLocateDefinition,
    );
    await exercise(
      ordinaryPi,
      'pi_searches_ripgrep',
      { query: 'channel', mode: 'exact', paths: ['channel-retries.ts'] },
      verifyRetryEvidence,
    );
    await exercise(
      ordinaryPi,
      'pi_searches_empty',
      { query: absentSymbol, mode: 'exact' },
      (content) => {
        assert.match(content, /"status"\s*:\s*"ready"/);
        assert.match(content, /"hitCount"\s*:\s*0\b/);
        assert.doesNotMatch(content, /^\d+ \|/m);
      },
    );
  }
  if (verifyColgrep)
    await exercise(
      ordinaryPi,
      'pi_searches_repository',
      { query: 'calculate the release checksum', pattern: 'computeReleaseChecksum' },
      (content) => {
        assert.match(content, /"provider"\s*:\s*"colgrep"/);
        assert.match(content, /checksum\.ts/);
        assert.match(content, /^1 \| export function computeReleaseChecksum.*% 65521;.*$/m);
      },
    );
  await exerciseLive(active, 'adjacent-lines');
  await exerciseLive(active, 'empty');
  const ordinaryCodex = await active.api.agents.create({
    cwd: workspace,
    config: { provider: `codex/${model}`, systemPrompt: agentPrompt },
  });
  await exercise(ordinaryCodex, 'codex_fresh');
  await ordinaryCodex.reload();
  await exercise(ordinaryCodex, 'codex_warm_resume');
  if (Bun.which('rg')) {
    await exercise(
      ordinaryCodex,
      'codex_locate_ripgrep',
      { symbol: 'releaseRetryLimit', paths: [retryPath] },
      verifyLocateDefinition,
    );
    await exercise(
      ordinaryCodex,
      'codex_searches_ripgrep',
      { query: 'channel', mode: 'exact', paths: [retryPath] },
      verifyCodexRetryEvidence,
    );
  }
  await stop();
  process.env.LTCOOK_COLGREP_DEPLOYMENT = path.join(fixture, 'missing-colgrep-assets');
  active = await start();
  const resumedPi = active.api.agents.ref(ordinaryPi.id);
  await exercise(resumedPi, 'pi_restart_resume');
  await exercise(
    resumedPi,
    'pi_searches_unavailable',
    { query: 'retry allowance for each release channel', mode: 'semantic' },
    (content) => {
      assert.match(content, /"status"\s*:\s*"unavailable"/);
      assert.match(content, /ColGREP assets are missing or invalid/);
      assert.doesNotMatch(content, /^\d+ \|/m);
    },
  );
  await exerciseLive(active, 'unavailable');
  await exercise(active.api.agents.ref(ordinaryCodex.id), 'codex_restart_resume');
  await exercise(resumedPi, 'pi_summarizes_file', { path: 'notes.txt' });
  await exercise(active.api.agents.ref(ordinaryCodex.id), 'codex_summarizes_file', {
    path: 'notes.txt',
  });
  console.log(
    JSON.stringify({ result: 'passed', verifiedToolCalls: calls, verifiedRepositoryCases }),
  );
} finally {
  await stop();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
}

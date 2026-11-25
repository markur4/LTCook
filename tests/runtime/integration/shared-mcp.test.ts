import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import { WorkspaceMcp } from '../../../runtime/src/integrations/mcp.js';
import {
  LFM3_SUMMARIZER_MODEL,
  ollamaChat,
  releaseOllamaModel,
  type OllamaUsage,
} from '../../../runtime/src/integrations/ollama.js';
import { createTools } from '../../../runtime/src/tools/catalog.js';
import {
  summarizeMemory,
  type MemorySummaryProgress,
} from '../../../runtime/src/session-memory/summarization.js';
import { RiedService } from '../../../runtime/src/repository/discovery.js';
import { createSummarizeTool } from '../../../runtime/src/tools/summarize.js';

async function localAuthority(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('No fixture port.');
  return `127.0.0.1:${address.port}`;
}

test('requests a named GPU and streams Session Memory rates before parsing final JSON', async () => {
  const model = 'fixture:latest';
  const content = { findings: [{ detail: 'Stored summary' }] };
  const text = JSON.stringify(content);
  const encoder = new TextEncoder();
  const parts = [text.slice(0, 14), text.slice(14)];
  const progress: Array<MemorySummaryProgress | undefined> = [];
  let finish: (() => void) | undefined;
  const ollama = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(await request.json()).toMatchObject({
        stream: true,
        format: 'json',
        model,
        options: { main_gpu: 0 },
      });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (record: object) =>
            controller.enqueue(encoder.encode(JSON.stringify(record) + '\n'));
          for (const content of parts) send({ model, message: { content }, done: false });
          finish = () => {
            send({
              model,
              message: { content: '' },
              done: true,
              done_reason: 'stop',
              eval_count: 12,
              eval_duration: 1_200_000_000,
              prompt_eval_count: 20,
            });
            controller.close();
          };
        },
      });
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
    },
  });
  const abort = new AbortController();
  const summary = summarizeMemory(
    { endpoint: `http://127.0.0.1:${ollama.port}`, model, mainGpu: 0, keepAlive: 0 },
    [{ role: 'user', content: 'Summarize this fixture.' }],
    AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]),
    'UAMP',
    false,
    (rate) => progress.push(rate),
  );
  void summary.catch(() => {});
  try {
    for (let attempt = 0; attempt < 100 && !progress.length; attempt++) await Bun.sleep(25);
    expect(progress[0]).toMatchObject({ estimated: true });
    expect(progress[0]!.tokensPerSecond).toBeGreaterThan(0);
    finish?.();
    expect(await summary).toMatchObject({
      content,
      complete: true,
      usage: { inputTokens: 20, outputTokens: 12 },
    });
    expect(progress.at(-1)).toBeUndefined();
  } finally {
    abort.abort();
    await summary.catch(() => {});
    await ollama.stop(true);
  }
});

test('keeps a completed Ollama transport response pending when its summary is invalid JSON', async () => {
  const model = 'fixture:latest';
  const ollama = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(await request.json()).toMatchObject({ model, format: 'json' });
      return Response.json({
        model,
        message: { content: '{"findings": ["missing closing delimiters"' },
        done: true,
        done_reason: 'stop',
      });
    },
  });
  try {
    const summary = await summarizeMemory(
      { endpoint: `http://127.0.0.1:${ollama.port}`, model, keepAlive: 0 },
      [{ role: 'user', content: 'Summarize this fixture.' }],
      AbortSignal.timeout(3000),
      'AAB',
    );
    expect(summary.complete).toBe(false);
    expect(summary).not.toHaveProperty('content');
  } finally {
    await ollama.stop(true);
  }
});

test('waits for the unloaded Ollama runner to disappear before reusing the model', async () => {
  const model = LFM3_SUMMARIZER_MODEL;
  const other = { name: 'other:latest' };
  let unloading = false;
  let observed = 0;
  const ollama = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const route = new URL(request.url).pathname;
      if (route === '/api/generate') {
        const payload = await request.json();
        if (request.method !== 'POST' || payload.model !== model || payload.keep_alive !== 0)
          return new Response(null, { status: 400 });
        unloading = true;
        return Response.json({ done: true, done_reason: 'unload' });
      }
      if (route === '/api/ps' && unloading) {
        return Response.json({ models: ++observed === 1 ? [{ name: model }, other] : [other] });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    await releaseOllamaModel(
      { endpoint: ollama.url.origin, model, keepAlive: -1 },
      AbortSignal.timeout(2_000),
    );
    expect(observed).toBe(2);
  } finally {
    await ollama.stop(true);
  }
});

test('ordinary Pi and Codex share workspace tool access across reconnect and enforce workspace boundaries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ltcook-mcp-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await Promise.all([mkdir(first), mkdir(second)]);
  await writeFile(path.join(first, 'source.ts'), 'export const firstWorkspace = true;\n');
  await writeFile(path.join(second, 'other.ts'), 'export const otherWorkspace = true;\n');
  await writeFile(path.join(second, '.env'), 'otherWorkspace=fixture\n');
  await writeFile(path.join(second, 'private.pem'), 'otherWorkspace fixture\n');
  await symlink(path.join(first, 'source.ts'), path.join(second, 'escape.ts'), 'file');
  const clients: Client[] = [];
  const authority = await localAuthority();
  const base = `http://${authority}`;
  const secret = 'fixture-runtime-authority';
  const createApi = async () => {
    const api = new RuntimeApi(undefined, secret, authority);
    const ried = new RiedService(path.join(root, 'cache'), undefined, () => ({ PATH: '' }));
    api.setWorkspaceMcp(new WorkspaceMcp(createTools(ried), authority));
    await api.listen();
    return api;
  };
  let api = await createApi();
  const admin = (action: 'grant' | 'revoke', body: Record<string, unknown>, token = secret) =>
    fetch(`${base}/v1/mcp/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  async function grant(agentId: string, workspaceRoot: string, provider?: 'pi' | 'codex') {
    const response = await admin('grant', { nativeAgentId: agentId, workspaceRoot, provider });
    expect(response.status).toBe(200);
    return ((await response.json()) as { token: string }).token;
  }
  async function client(token: string) {
    const sdk = new Client({ name: 'ordinary-fixture', version: '1.0.0' });
    clients.push(sdk);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await sdk.connect(transport);
    return { sdk, transport };
  }
  try {
    expect((await fetch(`${base}/mcp`)).status).toBe(401);
    expect(
      (await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${secret}` } })).status,
    ).toBe(401);
    const firstToken = await grant('pi-one', first, 'pi');
    expect(await grant('pi-one', first, 'pi')).toBe(firstToken);
    const secondToken = await grant('codex-two', second, 'codex');
    const one = await client(firstToken);
    const two = await client(secondToken);
    const unscoped = await client(await grant('unscoped', second));
    const piTools = (await one.sdk.listTools()).tools;
    const codexTools = (await two.sdk.listTools()).tools;
    expect(codexTools).toEqual(piTools);
    expect(codexTools.map(({ name }) => name)).toContain('ltcook_ried');
    expect(codexTools.find(({ name }) => name === 'ltcook_repo_search')?.annotations).toMatchObject(
      {
        readOnlyHint: true,
        openWorldHint: false,
      },
    );
    expect((await unscoped.sdk.listTools()).tools.map(({ name }) => name)).not.toContain(
      'ltcook_repo_search',
    );
    const deniedSearch = await unscoped.sdk.callTool({
      name: 'ltcook_repo_search',
      arguments: { query: 'otherWorkspace', mode: 'exact', paths: ['other.ts'] },
    });
    expect(deniedSearch.isError).toBe(true);
    expect(deniedSearch.content).toEqual([{ type: 'text', text: 'Unknown LTCook tool.' }]);
    expect(
      codexTools.find(({ name }) => name === 'ltcook_repo_locate')?.annotations?.readOnlyHint,
    ).toBe(true);
    expect((await unscoped.sdk.listTools()).tools.map(({ name }) => name)).not.toContain(
      'ltcook_repo_locate',
    );
    const locate = (client: Client, args: Record<string, unknown> = {}) =>
      client.callTool({
        name: 'ltcook_repo_locate',
        arguments: { symbol: 'otherWorkspace', ...args },
      });
    expect((await locate(unscoped.sdk)).isError).toBe(true);
    expect((await locate(two.sdk, { paths: ['../first/source.ts'] })).isError).toBe(true);
    expect((await locate(two.sdk, { paths: ['escape.ts'] })).isError).toBe(true);
    expect((await locate(two.sdk, { paths: ['private.pem'] })).isError).toBe(true);
    const search = (args: Record<string, unknown>) =>
      two.sdk.callTool({
        name: 'ltcook_repo_search',
        arguments: { query: 'otherWorkspace', mode: 'exact', ...args },
      });
    const lexical = await search({});
    expect(lexical.isError).not.toBe(true);
    expect(lexical.structuredContent).toMatchObject({
      provider: 'ripgrep',
      kind: 'exhaustive',
      ...(Bun.which('rg')
        ? {
            status: 'ready',
            partial: true,
            results: [{ path: 'other.ts', startLine: 1, endLine: 1 }],
            diagnostics: [{ code: 'excluded-path' }],
          }
        : { status: 'unavailable', diagnostics: [{ code: 'missing-executable' }] }),
    });
    const located = await locate(two.sdk, { paths: ['other.ts'] });
    expect(located.isError).not.toBe(true);
    expect(located.structuredContent).toMatchObject({
      followUp: 'not-needed',
      searches: [
        { mode: 'exact', provider: 'ripgrep', status: Bun.which('rg') ? 'ready' : 'unavailable' },
      ],
    });
    const trace = (sdk: Client) =>
      sdk.callTool({
        name: 'ltcook_repo_locate',
        arguments: {
          trace: {
            question: 'Find the workspace marker.',
            leads: [{ mode: 'exact', query: 'otherWorkspace' }],
          },
          paths: ['other.ts'],
        },
      });
    expect((await trace(unscoped.sdk)).isError).toBe(true);
    if (Bun.which('rg')) {
      const traced = await trace(two.sdk);
      expect(traced.structuredContent).toMatchObject({
        trace: {
          leads: [{ evidenceIds: [1], gaps: [] }],
          evidence: [{ id: 1, path: 'other.ts', startLine: 1 }],
        },
      });
      expect(traced.content).toEqual([
        { type: 'text', text: expect.stringContaining('1 | export const otherWorkspace = true;') },
      ]);
    }
    for (const args of [
      { paths: ['../first/source.ts'] },
      { paths: [path.join(first, 'source.ts')] },
      { paths: ['escape.ts'] },
      { paths: ['.env'] },
      { paths: ['private.pem'] },
      { workspaceRoot: first },
      { pattern: 'otherWorkspace' },
    ])
      expect((await search(args)).isError).toBe(true);
    const previousSession = one.transport.sessionId;
    const reconnected = await client(firstToken);
    expect(reconnected.transport.sessionId).not.toBe(previousSession);
    expect(
      (
        await fetch(`${base}/mcp`, {
          headers: {
            authorization: `Bearer ${firstToken}`,
            'mcp-session-id': previousSession!,
            accept: 'text/event-stream',
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await reconnected.sdk.callTool({
          name: 'ltcook_ried',
          arguments: { operation: 'summary' },
        })
      ).structuredContent,
    ).toMatchObject({ value: { workspaceRoot: first } });
    expect(
      (
        await two.sdk.callTool({
          name: 'ltcook_ried',
          arguments: { operation: 'section', section: 'host' },
        })
      ).structuredContent,
    ).toMatchObject({ value: { workspaceRoot: second, section: 'host' } });
    expect(
      (await reconnected.sdk.callTool({ name: 'ltcook_ried', arguments: { operation: 'map' } }))
        .structuredContent,
    ).toMatchObject({
      value: { value: { entries: [{ path: 'source.ts', kind: 'file' }] } },
    });
    expect(
      (
        await reconnected.sdk.callTool({
          name: 'ltcook_ried',
          arguments: { operation: 'outline', target: 'source.ts' },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (
        await two.sdk.callTool({
          name: 'ltcook_ried',
          arguments: { operation: 'outline', target: 'other.ts' },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (
        await unscoped.sdk.callTool({
          name: 'ltcook_ried',
          arguments: { operation: 'outline', target: 'other.ts' },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await reconnected.sdk.callTool({
          name: 'ltcook_ried',
          arguments: { operation: 'map', target: '../second' },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await reconnected.sdk.callTool({
          name: 'ltcook_ried',
          arguments: { operation: 'summary', workspaceRoot: second },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await fetch(`${base}/mcp`, {
          headers: {
            authorization: `Bearer ${secondToken}`,
            'mcp-session-id': reconnected.transport.sessionId!,
            accept: 'text/event-stream',
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (await admin('grant', { nativeAgentId: 'other', workspaceRoot: second }, firstToken)).status,
    ).toBe(401);
    expect((await admin('revoke', { nativeAgentId: 'pi-one' })).status).toBe(200);
    expect(
      (await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${firstToken}` } })).status,
    ).toBe(401);
    await Promise.all(clients.splice(0).map((sdk) => sdk.close()));
    await api.close();
    api = await createApi();
    expect(
      (await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${secondToken}` } })).status,
    ).toBe(401);
    const resumedToken = await grant('codex-two', second, 'codex');
    const resumed = await client(resumedToken);
    expect(
      (await resumed.sdk.callTool({ name: 'ltcook_ried', arguments: { operation: 'refresh' } }))
        .structuredContent,
    ).toMatchObject({ value: { workspaceRoot: second } });
    expect((await locate(resumed.sdk, { paths: ['other.ts'] })).isError).not.toBe(true);
    const authorizedToken = await grant('pi-two', second, 'pi');
    expect(await grant('pi-two', second, 'codex')).toBe(authorizedToken);
    const unscopedToken = await grant('pi-two', second);
    expect(unscopedToken).not.toBe(authorizedToken);
    expect(
      (await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${authorizedToken}` } }))
        .status,
    ).toBe(401);
    const reduced = await client(unscopedToken);
    expect((await reduced.sdk.listTools()).tools.map(({ name }) => name)).not.toContain(
      'ltcook_repo_search',
    );
  } finally {
    await Promise.all(clients.map((sdk) => sdk.close()));
    await api.close();
    await rm(root, { force: true, recursive: true });
  }
});

test('MCP summarization enforces workspace grants and cancels local Ollama requests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ltcook-summary-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const material = 'Release R-17 passed 42 checks. It did not deploy. The cause remains uncertain.';
  await writeFile(path.join(workspace, 'notes.txt'), material);
  await writeFile(path.join(workspace, 'large.txt'), 'x'.repeat(25 * 1024));
  await writeFile(path.join(root, 'outside.txt'), 'outside');
  await symlink(path.join(root, 'outside.txt'), path.join(workspace, 'escape.txt'));
  await writeFile(path.join(workspace, 'binary'), Buffer.from([0x78, 0, 0xff]));
  let started = Promise.withResolvers<void>();
  let canceled = Promise.withResolvers<void>();
  const requests: Array<{
    model: string;
    messages: Array<{ role: string; content: string }>;
    keep_alive: number;
    think?: boolean;
    options: { num_predict: number };
  }> = [];
  let mode = 'length';
  const ollama = createHttpServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as (typeof requests)[number];
    requests.push(input);
    if (mode === 'abort' || (mode === 'retry-abort' && input.think === false)) {
      response.once('close', () => canceled.resolve());
      started.resolve();
      return;
    }
    const cutoff =
      mode === 'empty-length' || mode === 'retry-abort' || (mode === 'recover' && input.think);
    response.writeHead(mode === 'missing' ? 404 : 200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        mode === 'missing'
          ? { error: 'model not found' }
          : {
              model: LFM3_SUMMARIZER_MODEL,
              message: {
                content: cutoff ? '' : 'R-17 passed 42 checks and did not deploy.',
              },
              done: true,
              done_reason: cutoff ? 'length' : mode === 'recover' ? 'stop' : mode,
              prompt_eval_count: 35,
              eval_count: cutoff ? input.options.num_predict : 16,
            },
      ),
    );
  });
  await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  const address = ollama.address();
  if (!address || typeof address === 'string') throw new Error('No fixture Ollama port.');
  const authority = await localAuthority();
  const secret = 'fixture-unshared-secret';
  const api = new RuntimeApi(undefined, secret, authority);
  const mcp = new WorkspaceMcp(
    createTools(new RiedService(path.join(root, 'cache'), undefined, () => ({ PATH: '' })), {
      endpoint: `http://127.0.0.1:${address.port}`,
      model: LFM3_SUMMARIZER_MODEL,
      keepAlive: 60,
    }),
    authority,
  );
  const clients: Client[] = [];
  api.setWorkspaceMcp(mcp);
  async function session(agentId: string, provider?: 'pi' | 'codex') {
    const response = await fetch(`http://${authority}/v1/mcp/grant`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ nativeAgentId: agentId, workspaceRoot: workspace, provider }),
    });
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    const client = new Client({ name: agentId, version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://${authority}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    clients.push(client);
    await client.connect(transport);
    return { client, transport, token };
  }
  try {
    await api.listen();
    const { client: pi } = await session('pi', 'pi');
    const {
      client: codex,
      transport: codexTransport,
      token: codexToken,
    } = await session('codex', 'codex');
    const { client: unscoped } = await session('unscoped');
    const summarize = (client: Client, args: Record<string, unknown>, signal?: AbortSignal) =>
      client.callTool({ name: 'ltcook_summarize', arguments: args }, undefined, { signal });
    for (const args of [
      {},
      { text: 'a', path: 'notes.txt' },
      { text: 'x'.repeat(25 * 1024) },
      { path: 'large.txt' },
      { path: 'escape.txt' },
      { path: '../outside.txt' },
      { path: 'binary' },
      { path: workspace },
    ]) {
      expect((await summarize(codex, args)).isError).toBe(true);
    }
    expect((await summarize(unscoped, { path: 'notes.txt' })).isError).toBe(true);
    expect(requests).toHaveLength(0);
    expect(
      (await summarize(pi, { path: 'notes.txt', focus: 'Deployment decision' })).structuredContent,
    ).toEqual({
      model: LFM3_SUMMARIZER_MODEL,
      summary: 'R-17 passed 42 checks and did not deploy.',
      incomplete: true,
    });
    expect(requests[0]).toMatchObject({
      model: LFM3_SUMMARIZER_MODEL,
      keep_alive: 60,
      think: true,
      stream: false,
      options: { num_ctx: 32768, num_predict: 4096, temperature: 0.1 },
    });
    expect(requests[0]?.messages[1]?.content).toContain(material);
    expect(requests[0]?.messages[1]?.content).toContain('Deployment decision');
    expect(requests.map(({ think }) => think)).toEqual([true, false]);
    mode = 'recover';
    let before = requests.length;
    expect((await summarize(codex, { path: 'notes.txt' })).structuredContent).toMatchObject({
      incomplete: false,
      summary: 'R-17 passed 42 checks and did not deploy.',
    });
    expect(requests.slice(before).map(({ think }) => think)).toEqual([true, false]);
    expect(requests[before]?.messages[1]?.content).toContain(material);
    const settings = {
      endpoint: `http://127.0.0.1:${address.port}`,
      model: LFM3_SUMMARIZER_MODEL,
      keepAlive: 0,
    };
    const prompt = [{ role: 'user', content: material }] as const;
    const usages: OllamaUsage[] = [];
    await ollamaChat(settings, [...prompt], AbortSignal.timeout(1000), (usage) =>
      usages.push(usage),
    );
    expect(usages).toEqual([
      {
        inputTokens: 70,
        outputTokens: 4112,
        initialReasoningAttempt: { inputTokens: 35, outputTokens: 4096 },
      },
    ]);
    before = requests.length;
    const override = {
      ...settings,
      generation: JSON.stringify({
        think: true,
        options: { num_ctx: 4096, num_predict: 128, temperature: 0.1 },
      }),
    };
    expect(await ollamaChat(override, [...prompt], AbortSignal.timeout(1000))).toMatchObject({
      incomplete: true,
    });
    expect(requests.slice(before).map(({ think }) => think)).toEqual([true]);
    mode = 'stop';
    expect((await summarize(codex, { text: material })).structuredContent).toMatchObject({
      incomplete: false,
    });
    expect((await summarize(codex, { text: 'x'.repeat(24 * 1024) })).isError).toBeFalsy();
    mode = 'empty-length';
    expect((await summarize(codex, { text: material })).structuredContent).toMatchObject({
      summary: '',
      incomplete: true,
    });
    mode = 'missing';
    const missing = await summarize(codex, { text: material });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain(`ollama pull ${LFM3_SUMMARIZER_MODEL}`);
    expect(
      (await codex.callTool({ name: 'ltcook_ried', arguments: { operation: 'summary' } }))
        .structuredContent,
    ).toMatchObject({ value: { workspaceRoot: workspace } });
    mode = 'retry-abort';
    before = requests.length;
    const controller = new AbortController();
    const result = summarize(codex, { text: material }, controller.signal);
    const rejected = result.then(
      () => false,
      () => true,
    );
    expect(
      await Promise.race([started.promise.then(() => true), Bun.sleep(1000).then(() => false)]),
    ).toBe(true);
    controller.abort();
    expect(await rejected).toBe(true);
    expect(
      await Promise.race([canceled.promise.then(() => true), Bun.sleep(1000).then(() => false)]),
    ).toBe(true);
    expect(requests.slice(before).map(({ think }) => think)).toEqual([true, false]);

    mode = 'abort';
    started = Promise.withResolvers<void>();
    canceled = Promise.withResolvers<void>();
    const pendingResponse = fetch(`http://${authority}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${codexToken}`,
        'mcp-session-id': codexTransport.sessionId!,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'in-flight-revocation',
        method: 'tools/call',
        params: { name: 'ltcook_summarize', arguments: { text: material } },
      }),
      signal: AbortSignal.timeout(5000),
    })
      .then((response) => response.text())
      .then(
        () => true,
        () => true,
      );
    expect(
      await Promise.race([started.promise.then(() => true), Bun.sleep(1000).then(() => false)]),
    ).toBe(true);
    await mcp.revoke('codex');
    expect(
      await Promise.race([canceled.promise.then(() => true), Bun.sleep(1000).then(() => false)]),
    ).toBe(true);
    expect(await Promise.race([pendingResponse, Bun.sleep(1000).then(() => false)])).toBe(true);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    ollama.closeAllConnections();
    await api.close();
    await new Promise<void>((resolve) => ollama.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

const liveEndpoint = process.env.LTCOOK_TEST_LIVE_OLLAMA;

test.skipIf(!liveEndpoint)(
  'live summarizer inference can coexist with Bonsai',
  async () => {
    if (!liveEndpoint) throw new Error('Set an explicit local Ollama endpoint.');
    const model = LFM3_SUMMARIZER_MODEL;
    const bonsai = 'ltcook-bonsai-2-27b-ctx65536:latest';
    const post = async (endpoint: string, input: object) => {
      const response = await fetch(new URL(endpoint, liveEndpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify(input),
      });
      if (!response.ok)
        throw new Error(`Live fixture ${endpoint} returned HTTP ${response.status}.`);
      return response.json();
    };
    const loaded = async (): Promise<string[]> => {
      const response = await fetch(new URL('/api/ps', liveEndpoint));
      if (!response.ok) throw new Error('Cannot check live Ollama residency.');
      return ((await response.json()) as { models: Array<{ name: string }> }).models.map(
        ({ name }) => name,
      );
    };
    const initial = await loaded();
    if (initial.includes(model) || initial.includes(bonsai)) {
      throw new Error('Supply an Ollama instance with neither fixture model running.');
    }
    const tool = createSummarizeTool({ endpoint: liveEndpoint, model, keepAlive: -1 });
    try {
      await post('/api/chat', {
        model: bonsai,
        messages: [{ role: 'user', content: 'Reply OK.' }],
        stream: false,
        keep_alive: 180,
        options: { num_ctx: 65536, num_predict: 1 },
      });
      expect(await loaded()).toContain(bonsai);
      const answer = await tool.execute(
        { text: 'Release R-17 passed its checks. Deployment was skipped.' },
        {
          agentId: 'live-fixture',
          workspaceRoot: process.cwd(),
          workspaceFileAccess: false,
          signal: AbortSignal.timeout(120_000),
        },
      );
      expect(answer.summary.trim().length).toBeGreaterThan(0);
      expect(answer.incomplete).toBe(false);
      expect(await loaded()).toEqual(expect.arrayContaining([model, bonsai]));
    } finally {
      for (const name of [model, bonsai])
        await post('/api/generate', { model: name, keep_alive: 0, stream: false });
    }
  },
  240_000,
);

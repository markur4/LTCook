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
import { LFM3_SUMMARIZER_MODEL } from '../../../runtime/src/integrations/ollama.js';
import { createTools } from '../../../runtime/src/tools/catalog.js';
import { RiedService } from '../../../runtime/src/tools/ried.js';
import { createSummarizeTool } from '../../../runtime/src/tools/summarize.js';

async function localAuthority(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('No fixture port.');
  return `127.0.0.1:${address.port}`;
}

test('ordinary MCP RIED uses launch grants across reconnect and rejects unauthorized access', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ltcook-mcp-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await Promise.all([mkdir(first), mkdir(second)]);
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
  async function grant(agentId: string, workspaceRoot: string) {
    const response = await admin('grant', { nativeAgentId: agentId, workspaceRoot });
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
    const firstToken = await grant('pi-one', first);
    expect(await grant('pi-one', first)).toBe(firstToken);
    const secondToken = await grant('codex-two', second);
    const one = await client(firstToken);
    const two = await client(secondToken);
    expect((await one.sdk.listTools()).tools.map(({ name }) => name)).toContain('ltcook_ried');
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
    const resumed = await client(await grant('codex-two', second));
    expect(
      (await resumed.sdk.callTool({ name: 'ltcook_ried', arguments: { operation: 'refresh' } }))
        .structuredContent,
    ).toMatchObject({ value: { workspaceRoot: second } });
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
    options: { num_predict: number };
  }> = [];
  let mode = 'length';
  const ollama = createHttpServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    if (mode === 'abort') {
      response.once('close', () => canceled.resolve());
      started.resolve();
      return;
    }
    response.writeHead(mode === 'missing' ? 404 : 200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        mode === 'missing'
          ? { error: 'model not found' }
          : {
              model: LFM3_SUMMARIZER_MODEL,
              message: {
                content: mode === 'empty-length' ? '' : 'R-17 passed 42 checks and did not deploy.',
              },
              done: true,
              done_reason: mode === 'empty-length' ? 'length' : mode,
            },
      ),
    );
  });
  await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  const address = ollama.address();
  if (!address || typeof address === 'string') throw new Error('No fixture Ollama port.');
  const authority = await localAuthority();
  const api = new RuntimeApi(undefined, 'fixture-unshared-secret', authority);
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
  async function session(agentId: string, workspaceFileAccess: boolean) {
    const token = await mcp.grant(agentId, workspace, workspaceFileAccess);
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
    const { client: pi } = await session('pi', true);
    const {
      client: codex,
      transport: codexTransport,
      token: codexToken,
    } = await session('codex', false);
    expect((await pi.listTools()).tools.map(({ name }) => name)).toEqual([
      'ltcook_ried',
      'ltcook_summarize',
    ]);
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
      expect((await summarize(pi, args)).isError).toBe(true);
    }
    expect((await summarize(codex, { path: 'notes.txt' })).isError).toBe(true);
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
    expect(JSON.stringify(missing.content)).toContain(LFM3_SUMMARIZER_MODEL);
    expect(
      (await codex.callTool({ name: 'ltcook_ried', arguments: { operation: 'summary' } }))
        .structuredContent,
    ).toMatchObject({ value: { workspaceRoot: workspace } });
    mode = 'abort';
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

import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import { WorkspaceMcp } from '../../../runtime/src/integrations/mcp.js';
import { createTools } from '../../../runtime/src/tools/catalog.js';
import { RiedService } from '../../../runtime/src/tools/ried.js';

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
    expect(
      (await one.sdk.callTool({ name: 'ltcook_ried', arguments: { operation: 'summary' } }))
        .structuredContent,
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
        await one.sdk.callTool({
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
            'mcp-session-id': one.transport.sessionId!,
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

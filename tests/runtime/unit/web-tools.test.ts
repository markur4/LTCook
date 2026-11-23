import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { createTools } from '../../../runtime/src/tools/catalog.js';
import {
  createWebTools,
  webDefinitions,
  type WebToolService,
} from '../../../runtime/src/tools/web.js';
import { RiedService } from '../../../runtime/src/tools/ried.js';

test('web tools are LTCook-owned and expose a bounded schema', () => {
  expect(webDefinitions.map((tool) => tool.name)).toEqual([
    'ltcook_web_search',
    'ltcook_web_fetch',
    'ltcook_web_content',
  ]);
  for (const definition of webDefinitions) {
    expect(Value.Check(definition.inputSchema, { provider: 'openai' })).toBe(false);
    expect(Value.Check(definition.inputSchema, { proxy: 'http://untrusted' })).toBe(false);
  }
  expect(Value.Check(webDefinitions[0]!.inputSchema, { query: 'test' })).toBe(true);
  expect(Value.Check(webDefinitions[1]!.inputSchema, { url: 'https://example.org' })).toBe(true);
  expect(Value.Check(webDefinitions[2]!.inputSchema, { responseId: 'abc' })).toBe(true);
});

test('shared catalog delegates to one service with authorized agent and workspace', async () => {
  const seen: unknown[] = [];
  const service = {
    async call(...args: unknown[]) {
      seen.push(args);
      return 'Source: https://example.org';
    },
  } as unknown as WebToolService;
  const tools = createWebTools(service);
  const controller = new AbortController();
  const ctx = {
    agentId: 'agent-a',
    workspaceRoot: '/workspace-a',
    workspaceFileAccess: false,
    signal: controller.signal,
  };
  const response = await tools[0]!.invoke({ query: 'subject' }, ctx);
  expect(response).toEqual({ content: 'Source: https://example.org' });
  expect(seen).toEqual([
    ['agent-a', '/workspace-a', 'web_search', { query: 'subject' }, controller.signal],
  ]);
  await expect(tools[0]!.invoke({ query: 'x', provider: 'openai' }, ctx)).rejects.toThrow(
    'Invalid tool arguments',
  );
  const catalog = createTools(
    new RiedService('/tmp/ltcook-inventory-test', undefined, () => ({ PATH: '' })),
    undefined,
    service,
  );
  expect(catalog.map((tool) => tool.name)).toEqual([
    'ltcook_ried',
    'ltcook_web_search',
    'ltcook_web_fetch',
    'ltcook_web_content',
  ]);
});

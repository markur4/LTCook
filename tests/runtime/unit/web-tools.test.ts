import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTools } from '../../../runtime/src/tools/catalog.js';
import {
  createWebTools,
  webDefinitions,
  webProcessEnvironment,
  WebToolService,
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
  expect(Value.Check(webDefinitions[0]!.inputSchema, { queries: ['first', 'second'] })).toBe(true);
  expect(Value.Check(webDefinitions[0]!.inputSchema, { query: 'first', queries: ['second'] })).toBe(
    false,
  );
  expect(Value.Check(webDefinitions[1]!.inputSchema, { url: 'https://example.org' })).toBe(true);
  expect(
    Value.Check(webDefinitions[1]!.inputSchema, {
      urls: ['https://example.org/a', 'https://example.org/b'],
    }),
  ).toBe(true);
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
  expect(seen).toEqual([[ctx, 'web_search', { query: 'subject' }]]);
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
    'ltcook_repo_search',
    'ltcook_web_search',
    'ltcook_web_fetch',
    'ltcook_web_content',
  ]);
});

test('web subprocess does not inherit runtime authentication or model credentials', () => {
  expect(
    webProcessEnvironment(
      { PI_CODING_AGENT_DIR: '/workspace/pi', CRAWL4AI_API_TOKEN: 'crawl' },
      {
        LTCOOK_API_TOKEN: 'runtime-secret',
        LTCOOK_RUNTIME_USER_TOKEN: 'user-secret',
        OPENAI_API_KEY: 'model-secret',
        PATH: '/usr/bin',
      },
    ),
  ).toEqual({
    PI_CODING_AGENT_DIR: '/workspace/pi',
    CRAWL4AI_API_TOKEN: 'crawl',
    PATH: '/usr/bin',
  });
});

test.skipIf(process.platform === 'win32')(
  'bundled web adapter waits for local SearXNG before a batch and scopes stored results',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ltcook-web-test-'));
    const node = Bun.which('node');
    if (!node) throw new Error('Node is required to exercise the bundled web adapter.');
    const queries: string[] = [];
    let healthChecks = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/healthz') {
          healthChecks++;
          return new Response(null, { status: healthChecks > 1 ? 200 : 503 });
        }
        if (url.pathname !== '/search' || url.searchParams.get('format') !== 'json')
          return new Response(null, { status: 404 });
        if (healthChecks < 2) return new Response(null, { status: 503 });
        queries.push(url.searchParams.get('q') ?? '');
        return Response.json({
          results: [
            {
              title: 'Recorded document',
              url: 'https://example.org/report',
              content: 'Fixture evidence',
            },
          ],
        });
      },
    });
    const preparer = join(root, 'prepare-native');
    const environment = {
      PI_CODING_AGENT_DIR: root,
      LTCOOK_SERVICE_CONNECTION: 'local',
      LTCOOK_SEARXNG_URL: String(server.url),
    };
    await writeFile(
      preparer,
      `#!${node}\nconsole.log(JSON.stringify({workspaceRoot:process.argv.at(-1),environment:${JSON.stringify(environment)}}));\n`,
      { mode: 0o700 },
    );
    await writeFile(
      join(root, 'web-search.json'),
      JSON.stringify({
        provider: 'searxng',
        webSearch: { allowedProviders: ['searxng'] },
        searxngBaseUrl: String(server.url),
        workflow: 'none',
      }),
    );
    const service = new WebToolService(preparer, resolve(import.meta.dir, '../../..'), node, {
      PATH: process.env.PATH,
    });
    const [search, , stored] = createWebTools(service);
    const context = {
      agentId: 'first',
      workspaceRoot: root,
      workspaceFileAccess: false,
      signal: AbortSignal.timeout(8000),
    };
    try {
      const found = await search!.invoke(
        { queries: ['release evidence', 'startup logs'] },
        context,
      );
      const content = String(found.content);
      expect(content).toContain('Recorded document');
      expect(content).toContain('ltcook_web_content');
      expect(queries.sort()).toEqual(['release evidence', 'startup logs']);
      const responseId = content.match(/responseId "([^"]+)"/)?.[1];
      expect(responseId).toBeTruthy();
      expect(
        String((await stored!.invoke({ responseId, queryIndex: 0 }, context)).content),
      ).toContain('Fixture evidence');
      expect(
        String((await stored!.invoke({ responseId, queryIndex: 1 }, context)).content),
      ).toContain('Fixture evidence');
      await expect(
        stored!.invoke({ responseId, queryIndex: 0 }, { ...context, agentId: 'second' }),
      ).rejects.toThrow(/no stored results/i);
      await service.disposeAgent(context.agentId);
      await expect(stored!.invoke({ responseId, queryIndex: 0 }, context)).rejects.toThrow(
        /no stored results/i,
      );
    } finally {
      await service.close();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);

import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
  expect(Value.Check(webDefinitions[0]!.inputSchema, { query: '  ' })).toBe(false);
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
  expect(
    Value.Check(webDefinitions[2]!.inputSchema, { responseId: 'abc', findText: ['a quote'] }),
  ).toBe(true);
  expect(
    Value.Check(webDefinitions[0]!.outputSchema, {
      responseId: 'abc',
      content: 'No sources',
      queries: [{ query: 'test', error: 'failed', sources: [] }],
    }),
  ).toBe(false);
});

test('shared catalog delegates to one service with authorized agent and workspace', async () => {
  const seen: unknown[] = [];
  const service = {
    async call(...args: unknown[]) {
      seen.push(args);
      return {
        content: 'No sources',
        responseId: 'abc',
        queries: [{ query: 'subject', sources: [] }],
      };
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
  expect(response).toEqual({
    content: 'No sources',
    responseId: 'abc',
    queries: [{ query: 'subject', sources: [] }],
  });
  expect(seen).toEqual([[ctx, 'ltcook_web_search', { query: 'subject' }]]);
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
  'web tools wait for local SearXNG, return a structured batch, and read agent-scoped results',
  async () => {
    const node = Bun.which('node');
    if (!node) throw new Error('Node is required to exercise the bundled web adapter.');
    const repoRoot = resolve(import.meta.dir, '../../..');
    const root = await mkdtemp(join(tmpdir(), 'ltcook-web-test-'));
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
        if (url.pathname === '/report')
          return new Response('Release notes\n\nThe fixture contains a searchable passage.');
        if (url.pathname !== '/search' || url.searchParams.get('format') !== 'json')
          return new Response(null, { status: 404 });
        if (healthChecks < 2) return new Response(null, { status: 503 });
        const query = url.searchParams.get('q') ?? '';
        queries.push(query);
        if (query === 'startup logs') return new Response('Fixture error', { status: 503 });
        return Response.json({
          results: [
            {
              title: 'Recorded document',
              url: `${url.origin}/report`,
              content: 'Fixture evidence',
            },
          ],
        });
      },
    });
    const preparer = join(root, 'prepare-native');
    const service = new WebToolService(preparer, root, node, { PATH: process.env.PATH });
    try {
      await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
      await writeFile(join(root, 'package.json'), '{"type":"module"}');
      const build = await Bun.build({
        entrypoints: [join(repoRoot, 'runtime/src/tools/web-mcp.mjs')],
        outdir: join(root, 'runtime/dist/tools'),
        naming: 'web-mcp.js',
        target: 'node',
        format: 'esm',
        packages: 'external',
      });
      if (!build.success) throw new Error(build.logs.map((log) => log.message).join('\n'));
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
          ssrf: { allowRanges: ['127.0.0.1/32'] },
        }),
      );
      const [search, fetchPage, stored] = createWebTools(service);
      const context = {
        agentId: 'first',
        workspaceRoot: root,
        workspaceFileAccess: false,
        signal: AbortSignal.timeout(8000),
      };
      const reportUrl = new URL('/report', server.url).href;
      const found = await search!.invoke(
        { queries: [' release evidence ', 'startup logs'] },
        context,
      );
      expect(found.content).toContain('Recorded document');
      expect(found.content).toContain('ltcook_web_content');
      expect(found.content).not.toContain('get_search_content(');
      expect(queries.sort()).toEqual(['release evidence', 'startup logs']);
      expect(found.responseId).toEqual(expect.any(String));
      expect(found.fetchId).toBeUndefined();
      expect(found.queries).toEqual([
        {
          query: ' release evidence ',
          sources: [{ title: 'Recorded document', url: reportUrl, snippet: 'Fixture evidence' }],
        },
        { query: 'startup logs', error: expect.stringContaining('503') },
      ]);
      const { responseId } = found;
      expect(
        (await stored!.invoke({ responseId, query: ' release evidence ' }, context)).content,
      ).toContain('Fixture evidence');
      await expect(stored!.invoke({ responseId, queryIndex: 1 }, context)).rejects.toThrow('503');
      const foundWithPages = await search!.invoke(
        { query: 'release evidence', includeContent: true },
        context,
      );
      expect(foundWithPages.fetchId).toEqual(expect.any(String));
      expect(
        (await stored!.invoke({ responseId: foundWithPages.fetchId, url: reportUrl }, context))
          .content,
      ).toContain('searchable passage');
      const fetched = await fetchPage!.invoke({ url: reportUrl, mode: 'raw' }, context);
      expect(fetched).toEqual({
        content: expect.stringContaining('searchable passage'),
        responseId: expect.any(String),
      });
      const passage = await stored!.invoke(
        { responseId: fetched.responseId, findText: 'SEARCHABLE PASSAGE' },
        context,
      );
      expect(passage.content).toContain('searchable passage');
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

import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RepositorySourceReader } from '../../../runtime/src/repository/evidence.js';
import { openRepositoryWorkspace } from '../../../runtime/src/repository/workspace.js';
import { createRepoLocateTool } from '../../../runtime/src/tools/repo-locate.js';
import { createRepoSearchTool } from '../../../runtime/src/tools/repo-search.js';
import { traceRepository } from '../../../runtime/src/tools/repo-trace.js';

type Search = ReturnType<typeof createRepoSearchTool>['search'];
const unavailable = {
  status: 'unavailable',
  provider: 'colgrep',
  kind: 'ranked',
  partial: true,
  truncated: false,
  freshness: 'unknown',
  capturedAt: '2026-11-23T12:00:00Z',
  diagnostics: [{ source: 'colgrep', code: 'fixture', message: 'Search unavailable' }],
} as const satisfies Awaited<ReturnType<Search>>;

async function fixture(run: (workspaceRoot: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ltcook-locate-')));
  try {
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    await run(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function context(workspaceRoot: string, signal = new AbortController().signal) {
  return {
    workspaceRoot,
    signal,
    agentId: 'test',
    workspaceFileAccess: false,
    repositorySearchAccess: true,
  };
}

function hit(name: string, excerpt: string, excerptTruncated?: true) {
  return { name, excerpt, path: 'source.ts', startLine: 1, endLine: 1, excerptTruncated };
}

test.skipIf(!Bun.which('rg'))(
  'Locate prioritizes roles over early references and verifies numbered context',
  () =>
    fixture(async (root) => {
      await mkdir(path.join(root, 'tests'));
      const references = Array.from({ length: 80 }, () => "import { locate } from './z-source';");
      await writeFile(path.join(root, 'a-imports.ts'), references.join('\n') + '\n');
      await writeFile(
        path.join(root, 'b-caller.ts'),
        "export const result = locate('project');\nexport const ready = true;\n",
      );
      await writeFile(
        path.join(root, 'tests/locate.test.ts'),
        "expect(locate('project')).toBeDefined();\n",
      );
      const definition = ['export function locate(', '  project: string,', ') {'];
      await writeFile(
        path.join(root, 'z-source.ts'),
        [...definition, '  return project;', '}'].join('\n') + '\n',
      );

      const result = await createRepoLocateTool().invoke({ symbol: 'locate' }, context(root));
      const search = result.searches[0]!;
      expect(search.status).toBe('ready');
      expect(search.truncated).toBe(true);
      expect(search.results?.map(({ role }) => role)).toEqual([
        'definition',
        'caller',
        'test',
        'reference',
        'reference',
        'reference',
      ]);
      expect(search.results?.[0]).toEqual({
        role: 'definition',
        path: 'z-source.ts',
        startLine: 1,
        endLine: 3,
        excerpt: definition.join('\n'),
      });
      expect(search.results?.[1]).toMatchObject({ path: 'b-caller.ts', endLine: 2 });
      expect(search.results?.[2]).toMatchObject({ path: 'tests/locate.test.ts' });
    }),
);

test('Locate uses exact search for a symbol and a verified identifier for conceptual follow-up', () =>
  fixture(async (root) => {
    const calls: Parameters<Search>[1][] = [];
    const tool = createRepoLocateTool({
      async search(_workspace, input) {
        calls.push(input);
        if (input.mode === 'hybrid')
          return {
            ...unavailable,
            status: 'ready',
            freshness: 'cached',
            results: [
              hit('wrong', 'function wrongSuffix() {}'),
              hit('clipped', 'function clipped', true),
              hit('reserveSlot', 'function reserveSlot() {}'),
              hit('later', 'function later() {}'),
            ],
          };
        return {
          ...unavailable,
          provider: 'ripgrep',
          kind: 'exhaustive',
          status: 'ready',
          results: [],
        };
      },
    });
    await expect(tool.invoke({ symbol: 'known' }, context(root))).resolves.toMatchObject({
      followUp: 'not-needed',
      searches: [{ query: 'known', mode: 'exact' }],
    });
    await expect(
      tool.invoke({ query: 'reserve a slot', paths: ['.'] }, context(root)),
    ).resolves.toMatchObject({
      followUp: 'attempted',
      searches: [
        { mode: 'hybrid', partial: true, diagnostics: unavailable.diagnostics },
        { mode: 'exact', query: 'reserveSlot', provider: 'ripgrep' },
      ],
    });
    expect(calls.map(({ mode, query, paths }) => [mode, query, paths])).toEqual([
      ['exact', 'known', undefined],
      ['hybrid', 'reserve a slot', ['.']],
      ['exact', 'reserveSlot', ['.']],
    ]);
    await expect(tool.invoke({ symbol: 'x', query: 'y' }, context(root))).rejects.toThrow(
      /exactly one/,
    );
    await expect(
      tool.invoke({ symbol: 'x' }, { ...context(root), repositorySearchAccess: false }),
    ).rejects.toThrow(/unavailable/);
  }));

test('Locate distinguishes an unavailable search, absent identifier, and failed follow-up', () =>
  fixture(async (root) => {
    const tool = createRepoLocateTool({
      async search(_workspace, request) {
        if (request.mode === 'exact') throw new Error('Follow-up failed');
        if (request.query === 'unavailable') return unavailable;
        return {
          ...unavailable,
          status: 'ready',
          results: request.query === 'no match' ? [] : [hit('name', 'const name = 1;')],
        };
      },
    });
    for (const [query, followUp] of [
      ['unavailable', 'initial-unavailable'],
      ['no match', 'no-verified-symbol'],
      ['match', 'failed'],
    ]) {
      const result = await tool.invoke({ query }, context(root));
      expect(result).toMatchObject({ followUp });
      expect(result.searches).toHaveLength(1);
    }
  }));

test.skipIf(!Bun.which('rg'))(
  'Locate trace cites distinct leads and shares evidence between them',
  () =>
    fixture(async (root) => {
      await mkdir(path.join(root, 'tests'));
      await writeFile(
        path.join(root, 'source.ts'),
        [
          'export function startDispatch() {',
          '  return process.env.WORKER_DEADLINE_MS ?? 500;',
          '}',
        ].join('\n'),
      );
      await writeFile(path.join(root, 'launch.py'), 'environment["WORKER_DEADLINE_MS"] = "600"\n');
      await writeFile(
        path.join(root, 'a-prefix.ts'),
        'export const ignored = process.env.OTHER_WORKER_DEADLINE_MS;\n',
      );
      await writeFile(
        path.join(root, 'tests/dispatch.test.ts'),
        [
          "import { startDispatch } from '../source.js';",
          "test('uses a default deadline', () => {",
          '  const timeout = startDispatch();',
          '  expect(timeout).toBe(500);',
          '});',
        ].join('\n'),
      );
      const locate = createRepoLocateTool();
      const trace = (
        await locate.execute(
          {
            trace: {
              question: 'Where does the worker deadline come from?',
              leads: [
                { mode: 'exact', query: 'startDispatch' },
                { mode: 'literal', query: 'WORKER_DEADLINE_MS' },
              ],
            },
          },
          context(root),
        )
      ).trace!;

      const implementation = trace.evidence.filter(({ path }) => path === 'source.ts');
      expect(implementation).toHaveLength(1);
      expect(
        trace.leads.every(({ evidenceIds }) => evidenceIds.includes(implementation[0]!.id)),
      ).toBe(true);
      expect(trace.evidence).toContainEqual(
        expect.objectContaining({
          path: 'tests/dispatch.test.ts',
          excerpt: expect.stringContaining('expect(timeout).toBe(500)'),
        }),
      );
      const launcher = trace.evidence.find(({ path }) => path === 'launch.py');
      expect(launcher?.excerpt).toContain('"600"');
      const literal = trace.connections.find(({ kind }) => kind === 'shared-literal');
      expect(literal?.literal).toBe('WORKER_DEADLINE_MS');
      expect([literal?.from, literal?.to]).toEqual(
        expect.arrayContaining([launcher!.id, implementation[0]!.id]),
      );
      expect(literal?.from === implementation[0]!.id ? literal.fromLine : literal?.toLine).toBe(2);
      const caller = trace.evidence.find(({ path }) => path === 'tests/dispatch.test.ts')!;
      expect(trace.connections).toContainEqual({
        kind: 'call',
        from: caller.id,
        to: caller.id,
        fromLine: 3,
        toLine: 1,
      });
    }),
);

test.each([false, true])(
  'Locate trace retains fast evidence across a sibling deadline (source changed: %s)',
  (changed) =>
    fixture(async (root) => {
      const pathName = 'source.txt';
      const excerpt = 'fast evidence';
      await writeFile(path.join(root, pathName), excerpt);
      const sourceRead = Promise.withResolvers<void>();
      const deadline = new AbortController();
      class ObservedReader extends RepositorySourceReader {
        override async read(...args: Parameters<RepositorySourceReader['read']>) {
          const result = await super.read(...args);
          if (args[0] === pathName) sourceRead.resolve();
          return result;
        }
      }
      const trace = await traceRepository(
        {
          question: 'Find two behaviors.',
          leads: [
            { mode: 'literal', query: excerpt },
            { mode: 'hybrid', query: 'slow source' },
          ],
        },
        {
          reader: new ObservedReader(await openRepositoryWorkspace(root)),
          allows: () => true,
          callerSignal: new AbortController().signal,
          deadline: deadline.signal,
          async search({ mode }, signal) {
            if (mode === 'hybrid') {
              await sourceRead.promise;
              if (changed) await writeFile(path.join(root, pathName), 'a replacement source');
              deadline.abort();
              signal.throwIfAborted();
            }
            return {
              ...unavailable,
              status: 'ready',
              freshness: 'current',
              partial: false,
              results: [{ path: pathName, startLine: 1, endLine: 1, excerpt }],
            };
          },
        },
      );
      expect(trace.leads[1]?.gaps).toEqual(['deadline']);
      if (changed) {
        expect(trace.evidence).toEqual([]);
        expect(trace.leads[0]?.gaps).toEqual(['source-unavailable']);
      } else {
        expect(trace.evidence).toHaveLength(1);
        expect(trace.evidence[0]?.excerpt).toBe(excerpt);
        expect(trace.leads[0]?.evidenceIds).toEqual([trace.evidence[0]?.id]);
      }
    }),
);

test('Locate trace keeps evidence when a sibling lead is unavailable, and follows the callable anchor', () =>
  fixture(async (root) => {
    const local = 'const rewound = true;';
    const source = 'export function dispatch() { return 500; }';
    await writeFile(path.join(root, 'source.ts'), `${local}\n${source}`);
    const calls: string[] = [];
    const bothStarted = Promise.withResolvers<void>();
    const locate = createRepoLocateTool({
      async search(_workspace, { mode, query }) {
        calls.push(query);
        if (mode === 'hybrid') {
          if (calls.length === 2) bothStarted.resolve();
          await bothStarted.promise;
          if (query === 'history?') return unavailable;
        }
        return {
          ...unavailable,
          status: 'ready',
          freshness: 'current',
          partial: false,
          diagnostics: [],
          results: [
            ...(mode === 'hybrid' ? [hit('rewound', local)] : []),
            { ...hit('dispatch', source), startLine: 2, endLine: 2 },
          ],
        };
      },
    });
    const result = await locate.execute(
      { trace: { question: 'Dispatch? history?' } },
      context(root),
    );
    const trace = result.trace!;
    expect(calls).toEqual(['Dispatch?', 'history?', 'dispatch']);
    expect(trace.leads[0]?.evidenceIds.length).toBeGreaterThan(0);
    expect(trace.leads[1]).toMatchObject({
      evidenceIds: [],
      gaps: ['unavailable', 'search-partial'],
    });
    expect(trace.evidence.some(({ excerpt }) => excerpt.includes('return 500'))).toBe(true);
    await expect(
      locate.invoke(
        { trace: { question: 'who', leads: [{ mode: 'exact', query: 'not a symbol' }] } },
        context(root),
      ),
    ).rejects.toThrow(/Exact leads/);
  }));

test('Locate trace propagates external cancellation even with independent leads', () =>
  fixture(async (root) => {
    const controller = new AbortController();
    const locate = createRepoLocateTool({
      async search() {
        controller.abort(new Error('trace canceled by caller'));
        return unavailable;
      },
    });
    await expect(
      locate.invoke({ trace: { question: 'A? B?' } }, context(root, controller.signal)),
    ).rejects.toThrow('trace canceled by caller');
  }));

test('Locate propagates cancellation and refuses to return evidence after a workspace replacement', () =>
  fixture(async (root) => {
    const controller = new AbortController();
    const locate = (change: () => Promise<void>) =>
      createRepoLocateTool({
        async search(_workspace, request) {
          if (request.mode === 'exact') await change();
          return { ...unavailable, status: 'ready', results: [hit('name', 'const name = 1;')] };
        },
      });
    const canceled = locate(async () => controller.abort(new Error('fixture aborted')));
    await expect(
      canceled.invoke({ query: 'find it' }, context(root, controller.signal)),
    ).rejects.toThrow('fixture aborted');
    const replaced = locate(async () => {
      await rename(root, root + '-old');
      await mkdir(root);
    });
    await expect(replaced.invoke({ query: 'find it' }, context(root))).rejects.toThrow(
      /workspace changed/,
    );
  }));

test('Locate reports a changed match instead of attaching context from a different source', () =>
  fixture(async (root) => {
    await writeFile(path.join(root, 'source.ts'), 'function different() {\n  return true;\n}\n');
    const tool = createRepoLocateTool({
      async search() {
        return {
          ...unavailable,
          status: 'ready',
          freshness: 'current',
          partial: false,
          diagnostics: [],
          results: [hit('locate', 'function locate() {')],
        };
      },
    });
    await expect(tool.invoke({ symbol: 'locate' }, context(root))).resolves.toMatchObject({
      searches: [
        {
          freshness: 'stale',
          partial: true,
          diagnostics: [{ code: 'source-changed' }],
          results: [],
        },
      ],
    });
  }));

test('Locate opens the smallest complete block and keeps the anchor when clipped', () =>
  fixture(async (root) => {
    await writeFile(
      path.join(root, 'source.ts'),
      [
        "import { test } from 'bun:test';",
        "test('wrapper', () => {",
        '  function nested() {',
        '    return 17;',
        '  }',
        '  nested();',
        '});',
      ].join('\n'),
    );
    await writeFile(
      path.join(root, 'test_sample.py'),
      [
        '@decorator',
        'def test_wrapper():',
        '    value = """a string',
        '  with an unindented line"""',
        '    assert value',
        '',
        'def unrelated():',
        '    pass',
      ].join('\n'),
    );
    await writeFile(path.join(root, 'notes.txt'), `first\n${'x'.repeat(2500)}\nanchor\nlast`);
    const locate = createRepoLocateTool();
    const open = (path: string, line: number, maxLines?: number) =>
      locate.invoke({ location: { path, line, maxLines } }, context(root));

    expect((await open('source.ts', 4)).source).toMatchObject({
      anchorLine: 4,
      block: { kind: 'function', startLine: 3, endLine: 5 },
      startLine: 3,
      endLine: 5,
      excerpt: '  function nested() {\n    return 17;\n  }',
      complete: true,
    });
    expect((await open('source.ts', 6)).source).toMatchObject({
      block: { kind: 'test' },
      complete: true,
    });
    expect((await open('source.ts', 4, 2)).source).toMatchObject({
      startLine: 3,
      endLine: 4,
      complete: false,
    });
    expect((await open('test_sample.py', 1)).source).toMatchObject({
      anchorLine: 1,
      block: { kind: 'test', startLine: 1, endLine: 5 },
      complete: true,
    });
    expect((await open('notes.txt', 3)).source).toMatchObject({
      anchorLine: 3,
      startLine: 3,
      endLine: 4,
      excerpt: 'anchor\nlast',
      complete: false,
    });
    await expect(open('source.ts', 8)).rejects.toThrow(/outside the file/);
  }));

test.skipIf(process.platform === 'win32')(
  'Locate honors search access, paths, exclusions and symbolic links when opening a location',
  () =>
    fixture(async (root) => {
      await writeFile(path.join(root, 'file.ts'), 'const value = 1;');
      await writeFile(path.join(root, '.env'), 'secret');
      await symlink('file.ts', path.join(root, 'link.ts'));
      const locate = createRepoLocateTool();
      const location = { path: 'file.ts', line: 1 };
      await expect(
        locate.invoke({ location }, { ...context(root), repositorySearchAccess: false }),
      ).rejects.toThrow(/unavailable/);
      await expect(locate.invoke({ location, paths: ['link.ts'] }, context(root))).rejects.toThrow(
        /symbolic links/,
      );
      await expect(
        locate.invoke({ location: { ...location, path: '.env' } }, context(root)),
      ).rejects.toThrow(/outside the search scope/);
      await expect(
        locate.invoke({ location: { ...location, path: '../file.ts' } }, context(root)),
      ).rejects.toThrow(/without traversal/);
    }),
);

test.skipIf(!Bun.which('rg'))(
  'Locate batches symbols in order and verifies a single local connection per stage',
  () =>
    fixture(async (root) => {
      await writeFile(
        path.join(root, 'target.ts'),
        ['export function original() {', '  return 1;', '}'].join('\n'),
      );
      await writeFile(
        path.join(root, 'barrel.ts'),
        "export { original as exported } from './target.js';",
      );
      await writeFile(
        path.join(root, 'caller.ts'),
        [
          'import {',
          '  exported as aliased,',
          "} from './barrel.js';",
          'export const wrapper = () => aliased();',
        ].join('\n'),
      );
      const locate = createRepoLocateTool();
      const result = await locate.invoke(
        { symbols: ['wrapper', 'aliased', 'exported', 'absent'], follow: true },
        context(root),
      );
      expect(result.followUp).toBe('not-needed');
      expect(result.searches.map(({ query }) => query)).toEqual([
        'wrapper',
        'aliased',
        'exported',
        'absent',
      ]);
      expect(result.searches[0]?.connections).toMatchObject([
        {
          kind: 'wrapper',
          from: { path: 'caller.ts', startLine: 4 },
          to: { path: 'caller.ts', startLine: 1, endLine: 3 },
        },
      ]);
      expect(result.searches[1]?.connections).toMatchObject([
        {
          kind: 'import',
          from: { path: 'caller.ts', startLine: 1, endLine: 3 },
          to: { path: 'barrel.ts', startLine: 1 },
        },
      ]);
      expect(result.searches[2]?.connections).toMatchObject([
        {
          kind: 're-export',
          from: { path: 'barrel.ts', startLine: 1 },
          to: { path: 'target.ts', startLine: 1 },
        },
      ]);
      expect(result.searches[3]?.results).toEqual([]);
      const restricted = await locate.invoke(
        { symbol: 'aliased', paths: ['caller.ts'], follow: true },
        context(root),
      );
      expect(restricted.searches[0]?.connections).toBeUndefined();
      await expect(
        locate.invoke({ symbols: ['wrapper', ' wrapper '] }, context(root)),
      ).rejects.toThrow(/distinct/);
    }),
);

test('Verified source reads reuse one snapshot and refuse to mix in new file contents', () =>
  fixture(async (root) => {
    const file = path.join(root, 'source.ts');
    await writeFile(file, 'const before = 1;');
    const reader = new RepositorySourceReader(await openRepositoryWorkspace(root));
    const { signal } = context(root);
    const [first, second] = await Promise.all([
      reader.read('source.ts', signal),
      reader.read('./source.ts', signal),
    ]);
    expect(first).toBe(second);
    await writeFile(file, 'const after = 2;');
    expect(await reader.read('source.ts', signal)).toBe('source-changed');
  }));

test.skipIf(!Bun.which('git') || !Bun.which('rg'))(
  'Git ranking prioritizes base and worktree changes without filtering other matches',
  () =>
    fixture(async (root) => {
      function git(...args: string[]) {
        const result = Bun.spawnSync(
          [
            'git',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.com',
            ...args,
          ],
          { cwd: root },
        );
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return result.stdout.toString().trim();
      }
      git('init', '-q');
      await writeFile(path.join(root, 'a-other.ts'), 'use(shared);');
      await writeFile(path.join(root, 'p-working.ts'), 'use(shared);');
      await writeFile(path.join(root, 'z-logic.test.ts'), 'test("shared", () => shared());');
      await writeFile(path.join(root, 'z-logic.ts'), 'const shared = 1;');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      await writeFile(path.join(root, 'z-logic.ts'), 'const shared = 2;');
      git('commit', '-qam', 'change');
      await writeFile(path.join(root, 'p-working.ts'), 'use(shared, 3);');
      await writeFile(path.join(root, 'q-untracked.ts'), 'use(shared, 4);');
      const tool = createRepoSearchTool();
      const ranked = await tool.invoke({ query: 'shared', mode: 'exact', base }, context(root));
      expect(ranked.base).toEqual({ reference: base, commit: base });
      expect(ranked.results?.map(({ path }) => path)).toEqual([
        'p-working.ts',
        'q-untracked.ts',
        'z-logic.test.ts',
        'z-logic.ts',
        'a-other.ts',
      ]);
      const fallback = await tool.invoke(
        { query: 'shared', mode: 'exact', base: 'missing-ref', limit: 1 },
        context(root),
      );
      expect(fallback).toMatchObject({
        partial: true,
        diagnostics: [{ code: 'base-commit-unavailable' }],
      });
      expect(fallback.results?.[0]?.path).toBe('a-other.ts');
      const grouped = await createRepoLocateTool().invoke(
        { symbols: ['shared', 'use'], base },
        context(root),
      );
      expect(grouped.searches.map((search) => search.base)).toEqual([ranked.base, ranked.base]);
      expect(
        grouped.searches[0]?.results?.filter(({ role }) => role === 'reference').at(-1)?.path,
      ).toBe('a-other.ts');
    }),
);

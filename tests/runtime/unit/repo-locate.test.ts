import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRepoLocateTool } from '../../../runtime/src/tools/repo-locate.js';
import type { createRepoSearchTool } from '../../../runtime/src/tools/repo-search.js';

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

import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RiedService } from '../../../runtime/src/repository/discovery.js';
import {
  readRepositoryMap,
  stageRepositoryFiles,
} from '../../../runtime/src/repository/filesystem.js';
import { openRepositoryWorkspace } from '../../../runtime/src/repository/workspace.js';
import { createRiedTool } from '../../../runtime/src/tools/ried.js';

test('repository maps are bounded and omit links, sensitive files, and generated directories', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ltcook-repository-map-'));
  try {
    const root = path.join(home, 'workspace');
    const outside = path.join(home, 'outside');
    await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
    await mkdir(path.join(root, 'node_modules'));
    await mkdir(outside);
    const oddPath =
      process.platform === 'win32' ? 'name with spaces.ts' : 'name with tab\tand space.ts';
    await writeFile(path.join(root, 'src', oddPath), 'export const one = 1;');
    await writeFile(path.join(root, 'src', 'nested', 'deeper.ts'), 'export const two = 2;');
    await writeFile(path.join(root, '.env'), 'sensitive content');
    await writeFile(path.join(outside, 'private.ts'), 'outside workspace');
    await symlink(outside, path.join(root, 'outside-link'), 'junction');
    await symlink(path.join(root, 'src'), path.join(root, 'inside-link'), 'junction');

    const workspace = await openRepositoryWorkspace(root);
    const tree = await readRepositoryMap(workspace, '.', { maxDepth: 2, maxEntries: 20 });
    expect(tree.truncated).toBe(true);
    expect(tree.partial).toBe(false);
    expect(tree.value.entries.map(({ path: entry }) => entry)).toEqual([
      'src',
      `src/${oddPath}`,
      'src/nested',
    ]);
    const one = await readRepositoryMap(workspace, 'src', { maxDepth: 3, maxEntries: 1 });
    expect(one.value.entries).toHaveLength(1);
    expect(one.truncated).toBe(true);
    const ried = new RiedService(path.join(home, 'cache'), undefined, () => ({ PATH: '' }));
    expect(
      await createRiedTool(ried).invoke(
        { operation: 'map', maxDepth: 2, maxEntries: 20 },
        {
          agentId: 'map-fixture',
          workspaceRoot: root,
          workspaceFileAccess: false,
          signal: new AbortController().signal,
        },
      ),
    ).toMatchObject({
      value: {
        provider: 'filesystem',
        status: 'partial',
        freshness: 'current',
        partial: false,
        truncated: true,
        diagnostics: ['Directory map reached its scan or depth limit'],
        diagnosticDetails: [
          {
            source: 'filesystem',
            code: 'map-limit',
            message: 'Directory map reached its scan or depth limit',
          },
        ],
      },
    });
    for (const target of ['../outside', outside, 'C:repo', 'outside-link', 'inside-link', '.env']) {
      await expect(
        readRepositoryMap(workspace, target, { maxDepth: 1, maxEntries: 10 }),
      ).rejects.toThrow();
    }
    await expect(workspace.resolvePath(`src/${oddPath}`, { kind: 'file' })).resolves.toMatchObject({
      relative: `src/${oddPath}`,
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test('provider staging isolates a selected file and honors byte and entry limits', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ltcook-repository-stage-'));
  try {
    const root = path.join(home, 'workspace');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'one.ts'), 'one');
    await writeFile(path.join(root, 'src', 'oversize.ts'), 'too large for sample');
    await writeFile(path.join(root, 'ignored.ts'), 'sibling');
    const workspace = await openRepositoryWorkspace(root);
    const staged = await stageRepositoryFiles(workspace, { target: 'src', maxFileBytes: 4 });
    try {
      expect(staged).toMatchObject({ fileCount: 1, partial: false, truncated: true });
      expect(await readdir(staged.workspace.root)).toEqual(['src']);
      expect(await readdir(path.join(staged.workspace.root, 'src'))).toEqual(['one.ts']);
      expect(await readFile(path.join(staged.workspace.root, 'src', 'one.ts'), 'utf8')).toBe('one');
    } finally {
      await staged.dispose();
    }
    await expect(readdir(staged.workspace.root)).rejects.toThrow();
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

const brief = process.env.LTCOOK_TEST_BRIEF;
test.skipIf(!brief)(
  'pinned brief outlines an individual source file and reports repository inventory',
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'ltcook-repository-outline-'));
    try {
      const root = path.join(home, 'workspace');
      await mkdir(path.join(root, 'src'), { recursive: true });
      await mkdir(path.join(root, 'tests'));
      await writeFile(
        path.join(root, 'src', 'wanted.ts'),
        'export function wanted(): number { return 1; }\n',
      );
      await writeFile(
        path.join(root, 'src', 'unrelated.ts'),
        'export function unrelated(): number { return 2; }\n',
      );
      await writeFile(path.join(root, 'tests', 'wanted.test.ts'), 'test("example", () => {});\n');
      await writeFile(path.join(root, 'AGENTS.md'), '# Project Instructions\n');
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', scripts: { test: 'fixture-test' } }),
      );
      const service = new RiedService(path.join(home, 'cache'), brief, () => ({ PATH: '' }));
      const context = { id: 'fixture', workspaceRoot: root };
      const outline = await service.get(context, { operation: 'outline', target: 'src/wanted.ts' });
      expect(outline).toMatchObject({
        operation: 'outline',
        provider: 'brief',
        value: { target: 'src/wanted.ts', outline: expect.stringContaining('function wanted') },
        freshness: 'current',
        truncated: false,
      });
      expect(JSON.stringify(outline)).not.toContain('unrelated');
      expect(
        await service.get(context, { operation: 'section', section: 'repository' }),
      ).toMatchObject({
        value: {
          layout: { sourceDirs: ['src'], testDirs: ['tests'] },
          scripts: [{ name: 'test', run: 'fixture-test' }],
          resources: { agents: { agents: 'AGENTS.md' } },
        },
        freshness: 'current',
      });
      expect(
        await service.get(context, { operation: 'section', section: 'repository' }),
      ).toMatchObject({
        freshness: 'cached',
      });
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  },
);

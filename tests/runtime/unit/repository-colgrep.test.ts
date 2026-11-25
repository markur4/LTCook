import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createColgrepProvider } from '../../../runtime/src/repository/providers/colgrep.js';
import { openRepositoryWorkspace } from '../../../runtime/src/repository/workspace.js';
import { createRepoSearchTool } from '../../../runtime/src/tools/repo-search.js';

async function fixture(run: (root: string, source: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ltcook-retrieval-')));
  try {
    const source = path.join(root, 'source');
    await mkdir(source);
    await run(root, source);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test.skipIf(process.platform === 'win32')(
  'ColGREP retains verified evidence after stale locations and malformed or unauthorized candidates',
  () =>
    fixture(async (root, source) => {
      const files: Record<string, string> = {};
      async function asset(name: string, content: string, mode = 0o600) {
        await writeFile(path.join(root, name), content, { mode });
        files[name] = createHash('sha256').update(content).digest('hex');
      }
      await mkdir(path.join(root, 'model'));
      for (const name of [
        'config.json',
        'config_sentence_transformers.json',
        'onnx_config.json',
        'tokenizer.json',
        'model.onnx',
        'model_int8.onnx',
      ])
        await asset(`model/${name}`, 'asset');
      await asset('library', 'asset');
      await asset(
        'colgrep',
        `#!${process.execPath}
if (process.argv.includes('--pattern=[')) {
  console.error('regex parse error: unclosed character class');
  process.exit(2);
}
if (process.argv.includes('blocked index update')) {
  process.once('SIGINT', async () => {
    await Bun.write(${JSON.stringify(path.join(root, 'safe-index-checkpoint'))}, 'finished');
    process.exit(130);
  });
  await Bun.write(${JSON.stringify(path.join(root, 'active-index-operation'))}, 'started');
  await Bun.sleep(10000);
  console.log('[]');
} else if (process.argv.includes('cached read') || process.argv.includes('resumed read')) {
  const cached = process.argv.includes('cached read');
  if (process.argv.includes('--no-update') !== cached) process.exit(2);
  console.log('[]');
} else if (process.argv.includes('large output')) {
  console.log('x'.repeat(4 * 1024 * 1024 + 1));
} else if (process.argv.includes('large diagnostics')) {
  console.error('x'.repeat(64 * 1024 + 1));
} else {
  console.log(await Bun.file(${JSON.stringify(path.join(root, 'native.json'))}).text());
}
`,
        0o700,
      );
      await writeFile(
        path.join(root, 'assets.json'),
        JSON.stringify({ binary: 'colgrep', library: 'library', model: 'model', files }),
      );

      const classSource = 'class Cache {\n  get(key: string) {\n    return key;\n  }\n}';
      const longLine = 'x'.repeat(2001);
      await writeFile(path.join(source, 'a.ts'), classSource.replaceAll('\n', '\r\n') + '\r\n');
      await writeFile(path.join(source, 'b.ts'), `${longLine}\n`);
      await writeFile(path.join(source, 'changed.ts'), 'const newName = 1;\n');
      await writeFile(path.join(source, 'renamed.ts'), 'const movedName = 1;\n');
      await rename(path.join(source, 'renamed.ts'), path.join(source, 'moved.ts'));
      await writeFile(path.join(source, 'deleted.ts'), 'const removedName = 1;\n');
      await rm(path.join(source, 'deleted.ts'));
      const outside = path.join(root, 'outside.ts');
      await writeFile(outside, 'const outside = 1;\n');
      await symlink(outside, path.join(source, 'link.ts'));

      const unit = (file: string, code: string, end_line = 1) => ({
        file,
        code,
        name: 'Cache',
        line: 1,
        end_line,
      });
      await writeFile(
        path.join(root, 'native.json'),
        JSON.stringify([
          { unit: unit(path.join(source, 'changed.ts'), 'const oldName = 1;') },
          { unit: unit(path.join(source, 'renamed.ts'), 'const movedName = 1;') },
          { unit: unit(path.join(source, 'deleted.ts'), 'const removedName = 1;') },
          { unit: unit(outside, 'const outside = 1;') },
          { unit: unit(path.join(source, 'link.ts'), 'const outside = 1;') },
          {
            unit: unit(path.join(source, 'a.ts'), classSource, 5),
            matches: [{ line: 2, end_line: 4, name: 'Cache.get' }],
          },
          { unit: { file: path.join(source, 'a.ts') } },
          { unit: unit(path.join(source, 'b.ts'), longLine) },
        ]),
      );
      const provider = createColgrepProvider({
        deploymentDirectory: root,
        cacheDirectory: path.join(root, 'cache'),
      });
      const workspace = await openRepositoryWorkspace(source);
      const signal = new AbortController().signal;
      expect(await provider.readStatus(workspace)).toEqual({
        availability: 'not-ready',
        activity: 'idle',
        diagnostic: null,
      });
      await expect(lstat(path.join(root, 'cache'))).rejects.toHaveProperty('code', 'ENOENT');
      provider.setIndexingEnabled(false);
      expect(provider.isIndexingEnabled()).toBe(false);
      await expect(provider.buildIndex(workspace, signal)).rejects.toThrow('indexing is paused');
      expect(await provider.search(workspace, { query: 'cached read' }, signal)).toMatchObject({
        value: { status: 'unavailable' },
        diagnostics: [{ code: 'indexing-paused' }],
      });
      await expect(lstat(path.join(root, 'cache'))).rejects.toHaveProperty('code', 'ENOENT');
      provider.setIndexingEnabled(true);
      const result = await provider.search(workspace, { query: 'cache' }, signal);
      expect(result).toMatchObject({
        provider: 'colgrep',
        partial: true,
        truncated: true,
        freshness: 'stale',
        value: {
          kind: 'ranked',
          status: 'ready',
          hits: [
            { path: 'a.ts', startLine: 1, endLine: 5, name: 'Cache', excerpt: classSource },
            {
              path: 'b.ts',
              startLine: 1,
              endLine: 1,
              excerpt: longLine.slice(0, 2000),
              excerptTruncated: true,
            },
          ],
        },
      });
      expect(result.diagnostics.map(({ code }) => code)).toEqual([
        'source-changed',
        'source-missing',
        'outside-workspace',
        'source-unavailable',
        'invalid-hit',
      ]);
      expect(JSON.stringify(result)).not.toContain(outside);

      const tool = createRepoSearchTool(provider);
      const context = {
        agentId: 'fixture',
        workspaceRoot: source,
        workspaceFileAccess: false,
        repositorySearchAccess: true,
        signal,
      };
      for (const [query, code] of [
        ['large output', 'output-limit'],
        ['large diagnostics', 'diagnostic-limit'],
      ]) {
        const unavailable = await tool.invoke({ query }, context);
        expect(unavailable).toMatchObject({
          status: 'unavailable',
          partial: true,
          truncated: true,
          freshness: 'unknown',
          diagnostics: [{ source: 'colgrep', code }],
        });
        expect(unavailable.results).toBeUndefined();
      }
      await expect(tool.invoke({ query: 'cache', pattern: '[' }, context)).rejects.toThrow(
        'ColGREP could not search with the supplied regular expression.',
      );

      const update = provider.search(workspace, { query: 'blocked index update' }, signal);
      try {
        const started = Bun.file(path.join(root, 'active-index-operation'));
        for (let attempt = 0; attempt < 200 && !(await started.exists()); attempt++) {
          await Bun.sleep(10);
        }
        expect(await started.exists()).toBe(true);
      } finally {
        provider.setIndexingEnabled(false);
        expect(await update).toMatchObject({
          value: { status: 'unavailable' },
          diagnostics: [{ code: 'indexing-paused' }],
        });
      }
      expect(await Bun.file(path.join(root, 'safe-index-checkpoint')).text()).toBe('finished');

      const workspaceKey = createHash('sha256')
        .update(workspace.root)
        .update('\0')
        .update(workspace.identity)
        .digest('hex');
      const directory = path.join(root, 'cache', workspaceKey, 'indices', 'fixture-index');
      const index = path.join(directory, 'index');
      await mkdir(index, { recursive: true });
      await writeFile(
        path.join(directory, 'project.json'),
        JSON.stringify({ model: path.join(root, 'model'), project_path: source }),
      );
      await writeFile(path.join(directory, '.building'), 'building');
      expect(await provider.search(workspace, { query: 'cached read' }, signal)).toMatchObject({
        value: { status: 'unavailable' },
        diagnostics: [{ code: 'indexing-paused' }],
      });
      await rm(path.join(directory, '.building'));
      await writeFile(
        path.join(directory, 'state.json'),
        JSON.stringify({ cli_version: '1.8.5', index_format_version: 3, dirty: false }),
      );
      await writeFile(
        path.join(index, 'metadata.json'),
        JSON.stringify({ num_documents: 1, num_chunks: 1 }),
      );
      for (const file of [
        'metadata.db',
        'centroids.npy',
        'ivf.npy',
        'ivf_lengths.npy',
        'doclens.0.json',
        '0.codes.npy',
        '0.residuals.npy',
      ])
        await writeFile(path.join(index, file), 'fixture');
      expect(await provider.search(workspace, { query: 'cached read' }, signal)).toMatchObject({
        value: { status: 'ready' },
        freshness: 'cached',
      });
      provider.setIndexingEnabled(true);
      expect(await provider.search(workspace, { query: 'resumed read' }, signal)).toMatchObject({
        value: { status: 'ready' },
      });
    }),
);

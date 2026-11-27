import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createColgrepProvider } from '../../../runtime/src/repository/providers/colgrep.js';
import { openRepositoryWorkspace } from '../../../runtime/src/repository/workspace.js';
import { createRepoSearchTool } from '../../../runtime/src/tools/repo-search.js';
import { createRepoLocateTool } from '../../../runtime/src/tools/repo-locate.js';

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

async function waitForFile(file: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await Bun.file(file).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${path.basename(file)}.`);
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
const fs = await import('node:fs/promises');
const path = await import('node:path');
if (process.argv.includes('--pattern=[')) {
  console.error('regex parse error: unclosed character class');
  process.exit(2);
}
if (process.argv[2] === 'init') {
  const arguments_ = process.argv.slice(3);
  const model = arguments_[arguments_.indexOf('--model') + 1];
  const workspace = arguments_[arguments_.indexOf('--') + 1];
  const indexes = process.env.COLGREP_DATA_DIR;
  const directory = path.join(indexes, 'fixture-index');
  const countFile = ${JSON.stringify(path.join(root, 'init-count'))};
  const count = Number(await Bun.file(countFile).text().catch(() => '0')) + 1;
  await Bun.write(countFile, String(count));
  await fs.mkdir(directory, { recursive: true });
  await Bun.write(path.join(directory, 'project.json'), JSON.stringify({ model, project_path: workspace }));
  await Bun.write(path.join(directory, '.building'), 'building');
  if (count > 1 && await Bun.file(${JSON.stringify(path.join(root, 'hold-refresh'))}).exists()) {
    await Bun.write(${JSON.stringify(path.join(root, 'refresh-started'))}, 'started');
    while (!(await Bun.file(${JSON.stringify(path.join(root, 'finish-refresh'))}).exists())) await Bun.sleep(10);
    if (await Bun.file(${JSON.stringify(path.join(root, 'fail-refresh'))}).exists()) {
      console.error('simulated refresh failure');
      process.exit(1);
    }
  }
  await fs.rm(path.join(directory, '.building'), { force: true });
  console.log('[]');
} else if (process.argv.includes('blocked query')) {
  await Bun.write(${JSON.stringify(path.join(root, 'query-started'))}, 'started');
  await Bun.sleep(10000);
} else if (process.argv.includes('repository index validation')) {
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
      const tool = createRepoSearchTool(provider);
      const context = {
        agentId: 'fixture',
        workspaceRoot: source,
        workspaceFileAccess: false,
        repositorySearchAccess: true,
        signal,
      };
      const locate = createRepoLocateTool(tool);
      const trace = () =>
        locate.invoke(
          {
            trace: {
              question: 'Find the cache implementation',
              leads: [
                { query: 'cached read', mode: 'hybrid' },
                { query: 'class Cache', mode: 'literal' },
              ],
            },
          },
          context,
        );
      if (Bun.which('rg')) {
        expect(await tool.invoke({ query: 'class Cache', mode: 'hybrid' }, context)).toMatchObject({
          provider: 'ripgrep',
          status: 'ready',
          partial: true,
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: 'lexical-fallback' }),
          ]),
        });
      } else {
        expect(
          await tool.invoke({ query: 'class Cache', mode: 'semantic' }, context),
        ).toMatchObject({
          provider: 'colgrep',
          status: 'unavailable',
        });
      }
      expect(await provider.search(workspace, { query: 'cached read' }, signal)).toMatchObject({
        value: { status: 'unavailable' },
        diagnostics: [{ code: 'index-unavailable' }],
      });
      expect(await provider.readStatus(workspace)).toEqual({
        availability: 'not-ready',
        activity: 'idle',
        diagnostic: null,
      });
      await expect(lstat(path.join(root, 'cache'))).rejects.toHaveProperty('code', 'ENOENT');
      await provider.buildIndex(workspace, signal);
      expect(provider.isIndexingEnabled()).toBe(true);
      const cold = await trace();
      const lexical = cold.trace?.leads[1];
      if (Bun.which('rg')) expect(lexical?.evidenceIds.length).toBeGreaterThan(0);
      else expect(lexical?.gaps).toContain('unavailable');
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
      expect(await provider.readStatus(workspace)).toMatchObject({
        availability: 'ready',
        activity: 'idle',
      });

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

      provider.setIndexingEnabled(false);
      expect(await provider.readStatus(workspace)).toMatchObject({
        availability: 'ready',
        activity: 'paused',
      });
      provider.setIndexingEnabled(true);
      expect(await provider.search(workspace, { query: 'resumed read' }, signal)).toMatchObject({
        value: { status: 'ready' },
      });

      const previousGeneration = (await provider.readStatus(workspace)).generation;
      expect(previousGeneration).toEqual(expect.any(String));
      await writeFile(path.join(root, 'hold-refresh'), 'hold');
      await writeFile(path.join(source, 'changed.ts'), 'const backgroundRefresh = 2;\n');
      const releaseAuthorization = provider.indexService.activate(workspace);
      try {
        await waitForFile(path.join(root, 'refresh-started'));
        const queryAbort = new AbortController();
        const query = provider.search(workspace, { query: 'blocked query' }, queryAbort.signal);
        await waitForFile(path.join(root, 'query-started'));
        queryAbort.abort(new Error('The caller cancelled this query.'));
        await expect(query).rejects.toThrow('The caller cancelled this query.');
        expect(provider.indexService.status(workspace).activity).toBe('indexing');
        expect((await provider.readStatus(workspace)).generation).toBe(previousGeneration);

        await writeFile(path.join(root, 'finish-refresh'), 'finish');
        let refreshed = await provider.readStatus(workspace);
        for (
          let attempt = 0;
          attempt < 200 && refreshed.generation === previousGeneration;
          attempt++
        ) {
          await Bun.sleep(10);
          refreshed = await provider.readStatus(workspace);
        }
        expect(refreshed).toMatchObject({ availability: 'ready' });
        expect(refreshed.generation).not.toBe(previousGeneration);
      } finally {
        releaseAuthorization();
      }

      await rm(path.join(root, 'finish-refresh'), { force: true });
      await rm(path.join(root, 'refresh-started'), { force: true });
      await writeFile(path.join(source, 'changed.ts'), 'const failedRefresh = 3;\n');
      await writeFile(path.join(root, 'fail-refresh'), 'fail');
      const beforeFailure = (await provider.readStatus(workspace)).generation;
      const failedRefresh = provider.buildIndex(workspace, signal);
      await waitForFile(path.join(root, 'refresh-started'));
      await writeFile(path.join(root, 'finish-refresh'), 'finish');
      await expect(failedRefresh).rejects.toThrow();
      expect((await provider.readStatus(workspace)).generation).toBe(beforeFailure);
    }),
);

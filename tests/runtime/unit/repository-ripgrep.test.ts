import { expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRipgrepProvider } from '../../../runtime/src/repository/providers/ripgrep.js';
import { openRepositoryWorkspace } from '../../../runtime/src/repository/workspace.js';

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

test('ripgrep distinguishes provider absence from an authorized scan and respects cancellation', () =>
  fixture(async (_root, source) => {
    const workspace = await openRepositoryWorkspace(source);
    const provider = createRipgrepProvider({ pathValue: source });
    const controller = new AbortController();
    expect(await provider.search(workspace, { query: 'hello' }, controller.signal)).toMatchObject({
      value: { kind: 'exhaustive', status: 'unavailable', hits: [] },
      diagnostics: [{ code: 'missing-executable' }],
      partial: true,
    });
    controller.abort(new Error('cancel this retrieval'));
    await expect(provider.search(workspace, { query: 'hello' }, controller.signal)).rejects.toThrow(
      'cancel this retrieval',
    );
  }));

test.skipIf(process.platform === 'win32')(
  'ripgrep can retain matches from a failed scan and cancel an active scan',
  () =>
    fixture(async (root, source) => {
      await writeFile(path.join(source, 'a.ts'), 'const answer = 42;\n');
      const started = path.join(root, 'started');
      const match = JSON.stringify({
        type: 'match',
        data: { path: { text: './a.ts' }, lines: { text: 'const answer = 42;\n' }, line_number: 1 },
      });
      await writeFile(
        path.join(root, 'rg'),
        `#!${process.execPath}
console.log(${JSON.stringify(match)});
if (process.argv.includes('wait')) {
  await Bun.write(${JSON.stringify(started)}, 'started');
  await Bun.sleep(10000);
}
process.exitCode = 2;
`,
        { mode: 0o700 },
      );
      const workspace = await openRepositoryWorkspace(source);
      const provider = createRipgrepProvider({ pathValue: root });
      const controller = new AbortController();
      expect(
        await provider.search(workspace, { query: 'answer' }, controller.signal),
      ).toMatchObject({
        value: { status: 'ready', hits: [{ path: 'a.ts', startLine: 1 }] },
        partial: true,
        diagnostics: [{ code: 'search-failed' }],
      });
      const pending = provider.search(workspace, { query: 'wait' }, controller.signal);
      try {
        const deadline = Date.now() + 2000;
        while (
          !(await access(started).then(
            () => true,
            () => false,
          ))
        ) {
          if (Date.now() > deadline) throw new Error('Expected the fake ripgrep process to start');
          await Bun.sleep(10);
        }
      } finally {
        controller.abort(new Error('cancel the active scan'));
        await expect(pending).rejects.toThrow('cancel the active scan');
      }
    }),
);

test.skipIf(!Bun.which('rg'))(
  'ripgrep scans exact, literal and regex matches with authorized bounded evidence',
  () =>
    fixture(async (root, source) => {
      const text = 'const reserve = 1;\r\nconst reserveAgain = reserve;\r\nconst text = "-e";\r\n';
      await writeFile(path.join(source, 'a.ts'), text);
      await writeFile(path.join(source, '.gitignore'), 'ignored.ts\n');
      await writeFile(path.join(source, 'ignored.ts'), text);
      await mkdir(path.join(source, 'nested'));
      await writeFile(path.join(source, 'nested', 'b.ts'), text);
      await writeFile(path.join(root, 'outside.ts'), text);
      if (process.platform !== 'win32')
        await symlink(path.join(root, 'outside.ts'), path.join(source, 'link.ts'));
      const workspace = await openRepositoryWorkspace(source);
      const provider = createRipgrepProvider();
      const signal = new AbortController().signal;
      const exact = await provider.search(
        workspace,
        { query: 'reserve', mode: 'exact', limit: 3 },
        signal,
      );
      expect(exact).toMatchObject({
        provider: 'ripgrep',
        truncated: true,
        partial: false,
        freshness: 'current',
        value: {
          kind: 'exhaustive',
          status: 'ready',
          hits: [
            { path: 'a.ts', startLine: 1, endLine: 1, excerpt: 'const reserve = 1;' },
            { path: 'a.ts', startLine: 2, endLine: 2 },
            { path: 'nested/b.ts', startLine: 1, endLine: 1 },
          ],
        },
      });
      expect(
        (await provider.search(workspace, { query: 'reserve', mode: 'exact', limit: 4 }, signal))
          .truncated,
      ).toBe(false);
      expect(
        await provider.search(
          workspace,
          { query: '-e', paths: ['nested', './nested/b.ts'] },
          signal,
        ),
      ).toMatchObject({
        truncated: false,
        value: { hits: [{ path: 'nested/b.ts', startLine: 3 }] },
      });
      expect(
        await provider.search(
          workspace,
          { query: 'reserve[A-Z]\\w+', mode: 'regex', paths: ['a.ts'] },
          signal,
        ),
      ).toMatchObject({
        value: { hits: [{ path: 'a.ts', startLine: 2 }] },
      });
      expect(
        await provider.search(workspace, { query: 'reserve[A-Z]\\w+', mode: 'literal' }, signal),
      ).toMatchObject({
        partial: false,
        value: { status: 'ready', hits: [] },
      });
      expect(await provider.search(workspace, { query: '[', mode: 'regex' }, signal)).toMatchObject(
        {
          partial: true,
          value: { status: 'unavailable', hits: [] },
        },
      );
      await expect(
        provider.search(workspace, { query: 'reserve', paths: ['../outside.ts'] }, signal),
      ).rejects.toThrow(/traversal/);
    }),
);

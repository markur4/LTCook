import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepositorySourceReader } from '../../../runtime/src/repository/evidence.js';
import { createSourceNavigation } from '../../../runtime/src/repository/source-navigation.js';
import { openRepositoryWorkspace } from '../../../runtime/src/repository/workspace.js';

async function fixture(
  files: Record<string, string>,
  run: (makeNavigation: (allows?: (path: string) => boolean) => Navigation) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'ltcook-source-navigation-'));
  try {
    await Promise.all(
      Object.entries(files).map(([path, source]) => writeFile(join(root, path), source)),
    );
    const workspace = await openRepositoryWorkspace(root);
    await run((allows = () => true) =>
      createSourceNavigation(
        new RepositorySourceReader(workspace),
        new AbortController().signal,
        allows,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type Navigation = ReturnType<typeof createSourceNavigation>;

test('trace follows an alias through a wrapper, import and re-export to behavior', () => {
  const wrapper = 'export const start = () => aliased();';
  return fixture(
    {
      'entry.ts': `import { exported as aliased } from './barrel.js';\n${wrapper}`,
      'barrel.ts': "export { implementation as exported } from './target.js';",
      'target.ts': 'export function implementation() {\n  return 17;\n}',
    },
    async (makeNavigation) => {
      const anchor = { path: 'entry.ts', startLine: 2, endLine: 2, excerpt: wrapper };
      const navigation = makeNavigation();
      const result = await navigation.trace('start', [anchor, anchor], 3, 6);
      expect(result.incomplete).toBe(false);
      expect(result.connections).toMatchObject([
        { kind: 'wrapper', from: { path: 'entry.ts', startLine: 2 }, to: { path: 'entry.ts' } },
        { kind: 'import', from: { path: 'entry.ts', startLine: 1 }, to: { path: 'barrel.ts' } },
        {
          kind: 're-export',
          from: { path: 'barrel.ts', startLine: 1 },
          to: {
            path: 'target.ts',
            startLine: 1,
            endLine: 3,
            excerpt: 'export function implementation() {\n  return 17;\n}',
          },
        },
      ]);
      expect(await navigation.trace('start', [anchor], 2, 6)).toMatchObject({
        incomplete: true,
        connections: result.connections.slice(0, 2),
      });
      expect(await navigation.trace('start', [anchor], 3, 1)).toMatchObject({
        incomplete: true,
        connections: result.connections.slice(0, 1),
      });
      expect(
        await makeNavigation((path) => path !== 'barrel.ts').trace('start', [anchor], 3, 6),
      ).toMatchObject({ incomplete: true, connections: result.connections.slice(0, 1) });
    },
  );
});

test('trace verifies a direct call and leaves shadowed or ambiguous targets unresolved', () => {
  const caller = 'export function caller() {';
  const shadowed = 'export function shadowed(execute: () => number) {';
  return fixture(
    {
      'caller.ts': [
        caller,
        '  const result = execute();',
        '  return result + 1;',
        '}',
        'function execute() {',
        '  return 17;',
        '}',
      ].join('\n'),
      'shadowed.ts': [
        "import { execute } from './target.js';",
        shadowed,
        '  const result = execute();',
        '  return result + 1;',
        '}',
      ].join('\n'),
      'ambiguous.ts': "export { execute } from './target.js';",
      'target.ts': 'export function execute() { return 1; }',
      'target.tsx': 'export function execute() { return 2; }',
    },
    async (makeNavigation) => {
      const navigation = makeNavigation();
      const anchor = (path: string, line: number, excerpt: string) => ({
        path,
        startLine: line,
        endLine: line,
        excerpt,
      });
      expect(
        await navigation.trace('caller', [anchor('caller.ts', 1, caller)], 3, 6),
      ).toMatchObject({
        incomplete: false,
        connections: [
          {
            kind: 'call',
            from: { path: 'caller.ts', startLine: 2, excerpt: '  const result = execute();' },
            to: { path: 'caller.ts', startLine: 5, endLine: 7 },
          },
        ],
      });
      expect(
        await navigation.trace('shadowed', [anchor('shadowed.ts', 2, shadowed)], 3, 6),
      ).toEqual({ incomplete: true, connections: [] });
      expect(
        await navigation.trace(
          'execute',
          [anchor('ambiguous.ts', 1, "export { execute } from './target.js';")],
          3,
          6,
        ),
      ).toEqual({ incomplete: true, connections: [] });
    },
  );
});

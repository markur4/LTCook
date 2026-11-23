import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBriefInventory, readBrief } from '../../../runtime/src/repository/providers/brief.js';
import { openRepositoryWorkspace } from '../../../runtime/src/repository/workspace.js';

test('projects brief 0.16.0 metadata with command provenance and workspace-relative paths', () => {
  const inventory = parseBriefInventory({
    version: '0.16.0',
    path: '/ignored/process/report/root',
    languages: [{ name: 'TypeScript' }],
    manifests: [{ path: 'ui app/package.json', ecosystem: 'npm', kind: 'manifest' }],
    dependencies: [{ manifest: 'ui app/package.json', name: 'vitest', scope: 'development' }],
    package_managers: [{ name: 'Bun', config_files: ['bun.lock'] }],
    scripts: [{ name: 'test:unit', run: 'bun test tests', source: 'package.json' }],
    layout: { source_dirs: ['ui app/src'], test_dirs: ['ui app/tests'], mirrors_source: true },
    tools: {
      test: [
        {
          name: 'Vitest',
          confidence: 'high',
          config_files: ['vitest.config.ts'],
          command: {
            run: 'bun run test:unit',
            source: 'project_script',
            inferred_tool: 'Vitest',
            alternatives: ['vitest run'],
          },
        },
      ],
      format: [{ name: 'Prettier' }],
      lint: [{ name: 'ESLint' }],
      typecheck: [{ name: 'tsc' }],
      build: [{ name: 'Vite' }],
      docs: [{ name: 'MkDocs', config_files: ['mkdocs.yml'] }],
    },
    style: { indentation: 'configured', indent_source: 'prettier', trailing_newline: false },
    platforms: {
      runtime_version_files: { '.node-version': '26.13.1' },
      ci_matrix_versions: { python: ['3.12', '3.13'] },
      ci_matrix_os: ['macos-latest', 'windows-latest'],
    },
    resources: {
      readme: 'README.md',
      changelog: 'docs/Change Log.md',
      community: { contributing: 'CONTRIBUTING.md' },
      agents: { agents: 'AGENTS.md' },
      templates: { issue: ['.github/ISSUE_TEMPLATE/bug.md'] },
    },
    skills: [{ name: 'Testing', path: '.claude/skills/test/SKILL.md', format: 'claude' }],
    stats: { scan_entries: 45 },
  });

  expect(inventory).toMatchObject({ partial: false, truncated: false, diagnostics: [] });
  expect(inventory.value).toMatchObject({
    source: 'brief',
    languages: ['TypeScript'],
    manifests: [{ path: 'ui app/package.json', kind: 'manifest' }],
    dependencies: [{ name: 'vitest', scope: 'development' }],
    layout: { sourceDirs: ['ui app/src'], testDirs: ['ui app/tests'], mirrorsSource: true },
    scripts: [{ name: 'test:unit', run: 'bun test tests', source: 'package.json' }],
    packageManagers: [{ name: 'Bun', configFiles: ['bun.lock'] }],
    tools: {
      test: [
        {
          name: 'Vitest',
          confidence: 'high',
          configFiles: ['vitest.config.ts'],
          command: {
            run: 'bun run test:unit',
            source: 'project_script',
            inferredTool: 'Vitest',
            alternatives: ['vitest run'],
          },
        },
      ],
      format: [{ name: 'Prettier' }],
      lint: [{ name: 'ESLint' }],
      typecheck: [{ name: 'tsc' }],
      build: [{ name: 'Vite' }],
      docs: [{ name: 'MkDocs' }],
    },
    conventions: { indentation: 'configured', indentSource: 'prettier', trailingNewline: false },
    platforms: {
      runtimeVersionFiles: { '.node-version': '26.13.1' },
      ciMatrixVersions: { python: ['3.12', '3.13'] },
      ciMatrixOS: ['macos-latest', 'windows-latest'],
    },
    resources: {
      readme: 'README.md',
      changelog: 'docs/Change Log.md',
      community: { contributing: 'CONTRIBUTING.md' },
      agents: { agents: 'AGENTS.md' },
      templates: { issues: ['.github/ISSUE_TEMPLATE/bug.md'] },
    },
    skills: [{ name: 'Testing', path: '.claude/skills/test/SKILL.md', format: 'claude' }],
  });
  expect(inventory.value).not.toHaveProperty('path');
});

test('preserves valid partial metadata and reports projection and scan limits', () => {
  const { partial, truncated, value, diagnostics } = parseBriefInventory({
    languages: null,
    manifests: [{ path: '../outside.json' }, { path: 'nul\0path' }, { path: 'data file.json' }],
    layout: { source_dirs: ['/outside', 'C:\\outside', 'x/../outside', 'src'] },
    resources: {
      agents: { agents: 'C:parent\\AGENTS.md', claude: '.claude/CLAUDE.md' },
      readme: '../README.md',
    },
    dependencies: Array.from({ length: 160 }, (_, index) => ({ name: `dependency-${index}` })),
    stats: { scan_truncated: true },
  });
  expect(partial).toBe(true);
  expect(truncated).toBe(true);
  expect(value.truncated).toBe(true);
  expect(value.dependencies).toHaveLength(128);
  expect(value.manifests).toEqual([{ path: 'data file.json', kind: 'unknown' }]);
  expect(value.layout.sourceDirs).toEqual(['src']);
  expect(value.resources).toEqual({ agents: { claude: '.claude/CLAUDE.md' } });
  expect(diagnostics.map(({ code }) => code)).toEqual([
    'scan-limit',
    'report-limit',
    'invalid-metadata',
  ]);
  expect(parseBriefInventory({ stats: {} }).diagnostics[0]?.code).toBe('malformed-report');
});

test('bounds inventory output when many reported commands are long', () => {
  const command = 'a'.repeat(760);
  const tools = Array.from({ length: 12 }, (_, index) => ({
    name: `Build ${index}`,
    command: { run: command, alternatives: [command, command, command] },
  }));
  const result = parseBriefInventory({
    languages: [],
    tools: { build: tools },
    scripts: Array.from({ length: 48 }, (_, index) => ({ name: `script-${index}`, run: command })),
    stats: {},
  });
  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThan(64 * 1024);
  expect(result.value.tools.build?.[0]?.command?.run).toBe(command);
});

test.skipIf(process.platform === 'win32')(
  'runs brief on isolated regular files without repository executables or external link targets',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'ltcook-brief-'));
    try {
      const workspaceRoot = join(root, 'workspace');
      const outside = join(root, 'outside');
      const executable = join(root, 'brief');
      await mkdir(join(workspaceRoot, '.github'), { recursive: true });
      await mkdir(outside);
      await writeFile(join(outside, 'private.yml'), 'outside the workspace');
      await writeFile(join(workspaceRoot, 'package.json'), '{"name":"fixture"}');
      await writeFile(join(workspaceRoot, '.git'), 'outside scope');
      await symlink(outside, join(workspaceRoot, '.github/workflows'), 'dir');
      await symlink(join(outside, 'private.yml'), join(workspaceRoot, 'AGENTS.md'));
      await writeFile(
        executable,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'brief 0.16.0'
  exit 0
fi
if [ ! -f package.json ] || [ -e .git ] || [ -e AGENTS.md ] || [ -e .github/workflows ]; then
  exit 1
fi
if command -v git >/dev/null 2>&1; then
  exit 1
fi
printf '%s\\n' '{"languages":[{"name":"JavaScript"}],"manifests":[{"path":"package.json","kind":"manifest"}],"stats":{}}'
`,
      );
      await chmod(executable, 0o700);

      const workspace = await openRepositoryWorkspace(workspaceRoot);
      const result = await readBrief(workspace, process.env.PATH ?? '', executable);
      expect(result.value.manifests).toEqual([{ path: 'package.json', kind: 'manifest' }]);
      expect(result.value.languages).toEqual(['JavaScript']);
      expect(result.diagnostics.map(({ code }) => code)).not.toContain('scan-failed');

      await writeFile(executable, "#!/bin/sh\nprintf '%s\\n' 'brief 0.16.01'\n");
      const unsupported = await readBrief(workspace, '', executable);
      expect(unsupported).toMatchObject({
        partial: true,
        diagnostics: [{ code: 'version-mismatch' }],
      });

      const unavailable = await readBrief(workspace, '', join(workspaceRoot, 'package.json'));
      expect(unavailable).toMatchObject({
        partial: true,
        diagnostics: [{ code: 'unavailable' }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { delimiter, join } from 'node:path';
import { RiedService, type RiedSnapshot } from '../../../runtime/src/repository/discovery.js';
import type { Session } from '../../../runtime/src/workflow-api/index.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test('RIED shares one bounded scan, discovers Just modules, and refreshes without running project commands', async () => {
  const home = mkdtempSync(join(os.tmpdir(), 'ltcook-ried-'));
  directories.push(home);
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  mkdirSync(join(workspace, 'runtime'));
  const sentinel = join(home, 'project-command-ran');
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: `touch ${sentinel}` } }),
  );
  writeFileSync(
    join(workspace, 'justfile'),
    `mod runtime 'runtime/justfile'\n\nbuild:\n    touch ${sentinel}\n`,
  );
  writeFileSync(join(workspace, 'runtime/justfile'), 'check:\n    touch ' + sentinel + '\n');
  execFileSync('git', ['init', '-q', workspace]);
  execFileSync('git', ['-C', workspace, 'add', '.']);
  execFileSync('git', [
    '-C',
    workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  ]);
  const counter = join(home, 'count');
  const brief = join(home, 'brief');
  writeFileSync(
    brief,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'brief 0.16.0'; exit 0; fi\necho scan >> '${counter}'\nprintf '%s\\n' '{"languages":[{"name":"JavaScript"}],"manifests":[{"path":"package.json","kind":"npm"}],"dependencies":[],"stats":{"scan_truncated":false}}'\n`,
  );
  chmodSync(brief, 0o700);
  const tools = join(home, 'tools');
  mkdirSync(tools);
  const just = join(tools, 'just');
  const justCalls = join(home, 'just-calls');
  // > Supply Just's metadata boundary while exercising real discovery and module parsing.
  writeFileSync(
    just,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${justCalls}'
if [ ! -f runtime/justfile ] || [ -f package.json ] || [ "$#" -ne 4 ] || [ "$1" != "--dump" ] || [ "$2" != "--dump-format" ] || [ "$3" != "json" ] || [ "$4" != "--no-dotenv" ]; then
  : > '${sentinel}'
  exit 64
fi
printf '%s\\n' '{"recipes":{"build":{}},"modules":{"runtime":{"recipes":{"check":{}},"modules":{}}}}'
`,
  );
  chmodSync(just, 0o700);
  const session: Session = {
    id: 'one',
    teamId: 'team',
    teamInstanceId: 'instance',
    workspaceRoot: workspace,
    createdAt: new Date().toISOString(),
  };
  const service = new RiedService(join(home, 'cache'), brief, () => ({
    PATH: [tools, process.env.PATH ?? ''].join(delimiter),
  }));
  const [first, second] = (await Promise.all([
    service.get(session, { operation: 'refresh' }),
    service.get(session, { operation: 'refresh' }),
  ])) as RiedSnapshot[];
  expect(first).toMatchObject({
    provider: 'ried',
    freshness: 'current',
    partial: false,
    truncated: false,
    diagnosticDetails: [],
  });
  expect(first.repository.languages).toEqual(['JavaScript']);
  expect(first.recipes).toEqual({
    source: 'just',
    items: [
      { name: 'build', module: '' },
      { name: 'check', module: 'runtime' },
    ],
  });
  expect(readFileSync(justCalls, 'utf8').trim().split('\n')).toEqual([
    '--dump --dump-format json --no-dotenv',
  ]);
  expect(first.git.head).toBeTruthy();
  expect(second.repository.manifests).toHaveLength(1);
  expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(existsSync(sentinel)).toBe(false);
  expect(await service.get(session, { operation: 'summary' })).toMatchObject({
    provider: 'ried',
    recipes: 2,
    freshness: 'cached',
  });
  expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
  writeFileSync(join(workspace, 'changed.txt'), 'changed');
  const git = (await service.get(session, { operation: 'section', section: 'git' })) as {
    value: RiedSnapshot['git'];
  };
  expect(git.value.untracked).toBe(1);
  expect(git).toMatchObject({ provider: 'git', freshness: 'current' });
  await service.get(session, { operation: 'refresh' });
  expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(2);
  expect(readFileSync(justCalls, 'utf8').trim().split('\n')).toEqual([
    '--dump --dump-format json --no-dotenv',
    '--dump --dump-format json --no-dotenv',
  ]);
  expect(existsSync(sentinel)).toBe(false);

  const cacheDirectory = join(home, 'cache');
  const [cacheFile] = readdirSync(cacheDirectory);
  if (!cacheFile) throw new Error('No repository metadata cache was written');
  const cachedPath = join(cacheDirectory, cacheFile);
  const cached = JSON.parse(readFileSync(cachedPath, 'utf8'));
  cached.repository.languages = [99];
  writeFileSync(cachedPath, JSON.stringify(cached));
  expect(await service.get(session, { operation: 'summary' })).toMatchObject({
    languages: ['JavaScript'],
  });
  expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(3);

  const malformedDiagnostic = JSON.parse(readFileSync(cachedPath, 'utf8'));
  malformedDiagnostic.diagnostics = [{ message: 'Incomplete cached diagnostic' }];
  writeFileSync(cachedPath, JSON.stringify(malformedDiagnostic));
  const rebuilt = await service.get(session, { operation: 'section', section: 'repository' });
  expect(rebuilt).toMatchObject({
    provider: 'brief',
    freshness: 'current',
    diagnostics: [],
    diagnosticDetails: [],
  });
  expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(4);
  expect(
    await service.get(session, {
      operation: 'section',
      section: 'repository',
      filter: { includePaths: ['package.json'] },
    }),
  ).toMatchObject({
    section: 'repository',
    filter: {
      effective: { includePaths: ['package.json'] },
      budgetExhausted: false,
    },
  });
  expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(5);
  expect(await service.get(session, { operation: 'section', section: 'repository' })).toMatchObject(
    { freshness: 'cached' },
  );
  expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(5);
});

test('RIED rejects filters on unsupported inventory operations and direct file outlines', async () => {
  const home = mkdtempSync(join(os.tmpdir(), 'ltcook-ried-filter-validation-'));
  directories.push(home);
  const workspaceRoot = join(home, 'workspace');
  mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'src', 'source.ts'), 'export const value = 1;');
  const service = new RiedService(join(home, 'cache'), undefined, () => ({ PATH: '' }));
  const context = { id: 'filter-validation', workspaceRoot };

  await expect(service.get(context, { operation: 'summary', filter: {} })).rejects.toThrow(
    'summary does not support filter',
  );
  await expect(
    service.get(context, {
      operation: 'map',
      filter: { includeText: ['value'] },
    }),
  ).rejects.toThrow('RIED supports filter.includePaths and filter.excludePaths only');
  await expect(
    service.get(context, {
      operation: 'outline',
      target: 'src/source.ts',
      filter: { includePaths: ['src/**'] },
    }),
  ).rejects.toThrow('RIED outline filters require a directory target');
  await expect(
    service.get(context, {
      operation: 'section',
      section: 'host',
      filter: {},
    }),
  ).rejects.toThrow('section host does not support filter');
});

test('RIED reports missing discovery tools without running project commands', async () => {
  const home = mkdtempSync(join(os.tmpdir(), 'ltcook-ried-missing-'));
  directories.push(home);
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const sentinel = join(home, 'project-command-ran');
  writeFileSync(join(workspace, 'justfile'), `check:\n    touch ${sentinel}\n`);
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ scripts: { test: `touch ${sentinel}` } }),
  );
  const session: Session = {
    id: 'two',
    teamId: 'team',
    teamInstanceId: 'instance',
    workspaceRoot: workspace,
    createdAt: new Date().toISOString(),
  };
  const service = new RiedService(join(home, 'cache'), join(home, 'missing-brief'), () => ({
    PATH: '',
  }));
  const result = await service.get(session, { operation: 'summary' });
  expect(result).toMatchObject({
    status: 'partial',
    provider: 'ried',
    freshness: 'current',
    partial: true,
    truncated: false,
    recipes: 0,
    diagnosticDetails: [
      { source: 'brief', code: 'unavailable', message: expect.stringContaining('brief v0.16.0') },
      {
        source: 'just',
        code: 'unavailable',
        message: 'Just is unavailable outside the workspace',
      },
      {
        source: 'git',
        code: 'git-unavailable',
        message: 'Git is unavailable outside the workspace',
      },
    ],
  });
  expect(result.diagnostics.some((item) => item.includes('brief v0.16.0'))).toBe(true);
  expect(result.diagnostics).toContain('Just is unavailable outside the workspace');
  expect(existsSync(sentinel)).toBe(false);
});

test('RIED reports WSL in the host section and summary without reusing native Linux inventory', async () => {
  const workspace = mkdtempSync(join(os.tmpdir(), 'ltcook-ried-host-'));
  directories.push(workspace);
  const service = new RiedService(
    join(workspace, 'cache'),
    join(workspace, 'missing-brief'),
    () => ({
      PATH: '',
    }),
  );
  const session = { id: 'host', workspaceRoot: workspace };
  const { WSL_INTEROP, WSL_DISTRO_NAME } = process.env;
  const platform = spyOn(os, 'platform').mockReturnValue('linux');
  const release = spyOn(os, 'release').mockReturnValue('6.6.114.1-microsoft-standard-WSL2');
  try {
    delete process.env.WSL_INTEROP;
    delete process.env.WSL_DISTRO_NAME;
    expect(await service.get(session, { operation: 'section', section: 'host' })).toMatchObject({
      provider: 'node',
      value: { os: 'linux', wsl: true },
    });
    release.mockReturnValue('6.6.114.1-generic');
    expect(await service.get(session, { operation: 'summary' })).toMatchObject({
      host: { os: 'linux', wsl: false },
    });
    process.env.WSL_INTEROP = '/run/WSL/interop';
    expect(await service.get(session, { operation: 'summary' })).toMatchObject({
      host: { os: 'linux', wsl: true },
    });
    delete process.env.WSL_INTEROP;
    process.env.WSL_DISTRO_NAME = 'Fixture';
    expect(await service.get(session, { operation: 'summary' })).toMatchObject({
      host: { os: 'linux', wsl: true },
    });
    platform.mockReturnValue('win32');
    expect(await service.get(session, { operation: 'summary' })).toMatchObject({
      host: { os: 'win32', wsl: false },
    });
  } finally {
    platform.mockRestore();
    release.mockRestore();
    if (WSL_INTEROP === undefined) delete process.env.WSL_INTEROP;
    else process.env.WSL_INTEROP = WSL_INTEROP;
    if (WSL_DISTRO_NAME === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = WSL_DISTRO_NAME;
  }
});

test.skipIf(process.platform === 'win32')(
  'RIED validates Just sources before invoking metadata discovery',
  async () => {
    const home = mkdtempSync(join(os.tmpdir(), 'ltcook-ried-recipe-scope-'));
    directories.push(home);
    const workspaceRoot = join(home, 'workspace');
    const tools = join(home, 'tools');
    mkdirSync(workspaceRoot);
    mkdirSync(tools);
    const invocation = join(home, 'just-invoked');
    const just = join(tools, 'just');
    writeFileSync(just, `#!/bin/sh\n: > '${invocation}'\nprintf '{}\n'\n`);
    chmodSync(just, 0o700);
    writeFileSync(join(home, 'outside.just'), 'outside-recipe:\n');
    writeFileSync(join(workspaceRoot, 'justfile'), "import '../outside.just'\nlocal-recipe:\n");

    const service = new RiedService(join(home, 'cache'), undefined, () => ({ PATH: tools }));
    const inventory = await service.get(
      { id: 'scope', workspaceRoot },
      {
        operation: 'section',
        section: 'recipes',
      },
    );
    expect(inventory).toMatchObject({
      status: 'partial',
      provider: 'just',
      partial: true,
      diagnostics: expect.arrayContaining([
        'Just imports and modules must stay inside the workspace',
      ]),
      diagnosticDetails: expect.arrayContaining([
        {
          source: 'just',
          code: 'source-scope',
          message: 'Just imports and modules must stay inside the workspace',
        },
      ]),
      value: { items: [] },
    });
    expect(existsSync(invocation)).toBe(false);
  },
);

test('RIED rejects an outline if the recorded workspace becomes a directory link', async () => {
  const home = mkdtempSync(join(os.tmpdir(), 'ltcook-ried-bound-root-'));
  directories.push(home);
  const workspace = join(home, 'workspace');
  const replacement = join(home, 'replacement');
  mkdirSync(workspace);
  mkdirSync(replacement);
  const workspaceRoot = realpathSync(workspace);
  writeFileSync(join(replacement, 'outside.ts'), 'export const outside = true;');
  renameSync(workspace, join(home, 'original'));
  symlinkSync(replacement, workspace, 'junction');

  const service = new RiedService(join(home, 'cache'), undefined, () => ({ PATH: '' }));
  await expect(
    service.get(
      { id: 'bound-session', workspaceRoot, boundWorkspace: true },
      { operation: 'outline', target: 'outside.ts' },
    ),
  ).rejects.toThrow('The bound repository workspace no longer resolves to its recorded directory');
});

test.skipIf(!Bun.which('just'))(
  'native Just inventories a staged local recipe graph without running commands',
  async () => {
    const home = mkdtempSync(join(os.tmpdir(), 'ltcook-ried-native-just-'));
    directories.push(home);
    const workspaceRoot = join(home, 'workspace');
    mkdirSync(join(workspaceRoot, 'checks'), { recursive: true });
    const sentinel = join(home, 'command-ran');
    writeFileSync(
      join(workspaceRoot, 'justfile'),
      `import 'included.just'\nmod checks\n\nbuild:\n    touch "${sentinel}"\n`,
    );
    writeFileSync(join(workspaceRoot, 'included.just'), `lint:\n    touch "${sentinel}"\n`);
    writeFileSync(join(workspaceRoot, 'checks', 'mod.just'), `check:\n    touch "${sentinel}"\n`);
    const service = new RiedService(join(home, 'cache'), undefined, () => ({
      PATH: process.env.PATH ?? '',
    }));
    expect(
      await service.get(
        { id: 'native-just', workspaceRoot },
        {
          operation: 'section',
          section: 'recipes',
        },
      ),
    ).toMatchObject({
      value: {
        items: expect.arrayContaining([
          { name: 'build', module: '' },
          { name: 'lint', module: '' },
          { name: 'check', module: 'checks' },
        ]),
      },
    });
    expect(
      await service.get(
        { id: 'native-just', workspaceRoot },
        {
          operation: 'section',
          section: 'recipes',
          filter: { excludePaths: ['included.just'] },
        },
      ),
    ).toMatchObject({
      partial: true,
      diagnosticDetails: [
        {
          source: 'just',
          code: 'filtered-source-dependency',
        },
      ],
      value: { items: [] },
    });
    expect(existsSync(sentinel)).toBe(false);
  },
);

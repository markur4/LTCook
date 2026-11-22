import { afterEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import { delimiter, join } from 'node:path';
import { RiedService, type RiedSnapshot } from '../../../runtime/src/ried.js';
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
if [ "$#" -ne 4 ] || [ "$1" != "--dump" ] || [ "$2" != "--dump-format" ] || [ "$3" != "json" ] || [ "$4" != "--no-dotenv" ]; then
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
  const summary = (await service.get(session, { operation: 'summary' })) as { recipes: number };
  expect(summary.recipes).toBe(2);
  expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
  writeFileSync(join(workspace, 'changed.txt'), 'changed');
  const git = (await service.get(session, { operation: 'section', section: 'git' })) as {
    value: RiedSnapshot['git'];
  };
  expect(git.value.untracked).toBe(1);
  await service.get(session, { operation: 'refresh' });
  expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(2);
  expect(readFileSync(justCalls, 'utf8').trim().split('\n')).toEqual([
    '--dump --dump-format json --no-dotenv',
    '--dump --dump-format json --no-dotenv',
  ]);
  expect(existsSync(sentinel)).toBe(false);
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
  const result = (await service.get(session, { operation: 'summary' })) as {
    status: string;
    recipes: number;
    diagnostics: string[];
  };
  expect(result.status).toBe('partial');
  expect(result.diagnostics.some((item) => item.includes('brief v0.16.0'))).toBe(true);
  expect(result.recipes).toBe(0);
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

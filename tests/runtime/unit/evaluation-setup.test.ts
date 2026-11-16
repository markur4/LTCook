import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resolveEvaluationContext, snapshotWorkspace } from '../../../runtime/src/evals/setup.js';
import { EvalRunService } from '../../../runtime/src/evals/service.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ltcook-evaluation-setup-'));
  roots.push(root);
  return root;
}

test('Current Setup applies explicit non-secret overrides through the real AppRC resolver', async () => {
  const root = await temporary();
  const previous = process.env.LTCOOK_SHELL_PROVENANCE;
  process.env.LTCOOK_SHELL_PROVENANCE = JSON.stringify({
    HOME: root,
    USERPROFILE: root,
    APPDATA: path.join(root, 'config'),
    LOCALAPPDATA: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'),
    LTCOOK_TEAM: 'default-minimal',
    OPENAI_API_KEY: 'must-not-appear-in-context',
  });
  try {
    const python = path.join(
      process.env.UV_PROJECT_ENVIRONMENT ?? path.resolve(import.meta.dir, '../../../.venv'),
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    );
    const context = resolveEvaluationContext({
      python,
      setup: 'current',
      teamSelection: 'default',
      environmentOverrides: {
        LTCOOK_TEAM: 'default',
        LTCOOK_SEARXNG_URL: 'http://127.0.0.1:8123',
      },
    });
    expect(context.teamSelection).toBe('default');
    expect(context.webConfiguration.searxngBaseUrl).toBe('http://127.0.0.1:8123');
    expect(context.limitations).not.toContain(
      'Workspace team selection differs from the active runtime; using the active runtime team.',
    );
    expect(JSON.stringify(context)).not.toContain('must-not-appear-in-context');
  } finally {
    if (previous === undefined) delete process.env.LTCOOK_SHELL_PROVENANCE;
    else process.env.LTCOOK_SHELL_PROVENANCE = previous;
  }
});

test('snapshots uncommitted inputs and selected ignored guidance, excluding credentials and escaping links', async () => {
  const root = await temporary();
  const source = path.join(root, 'source');
  const target = path.join(root, 'snapshot');
  await mkdir(path.join(source, '.pi/skills/example'), { recursive: true });
  await writeFile(path.join(source, '.gitignore'), '.pi/skills/\nignored.txt\n');
  await writeFile(path.join(source, 'tracked.txt'), 'committed input');
  expect(spawnSync('git', ['init', '-q', source]).status).toBe(0);
  expect(spawnSync('git', ['-C', source, 'add', 'tracked.txt']).status).toBe(0);
  await writeFile(path.join(source, 'tracked.txt'), 'uncommitted input');
  await writeFile(path.join(source, 'untracked.txt'), 'new input');
  await writeFile(path.join(source, '.env'), 'SECRET=excluded');
  await writeFile(path.join(source, 'ignored.txt'), 'private ignored data');
  await writeFile(path.join(source, '.pi/skills/example/SKILL.md'), '# Selected skill');
  await symlink('/etc/passwd', path.join(source, 'outside'));
  const entries = await snapshotWorkspace(source, target);
  expect(await readFile(path.join(target, 'tracked.txt'), 'utf8')).toBe('uncommitted input');
  expect(await readFile(path.join(target, 'untracked.txt'), 'utf8')).toBe('new input');
  expect(await readFile(path.join(target, '.pi/skills/example/SKILL.md'), 'utf8')).toContain(
    'Selected skill',
  );
  for (const file of ['.env', 'ignored.txt', 'outside', '.git'])
    expect(entries.find((entry) => entry.path === file)?.included).toBe(false);
  expect(await readdir(source)).toContain('outside');
});

for (const schema of [1, 2]) {
  test(`unsupported schema ${schema} saved records remain unchanged and are never restarted`, async () => {
    const root = await temporary();
    const id = 'b9c2c440-a86a-43c2-9672-2030cf391de4';
    const folder = path.join(root, 'evals/runs', id);
    await mkdir(folder, { recursive: true });
    const record = JSON.stringify({ schema, runId: id, status: 'running', preset: 'quick' });
    await writeFile(path.join(folder, 'run.json'), record);
    const oldExecution = path.join(folder, '.execution-old');
    await mkdir(oldExecution);
    await writeFile(path.join(oldExecution, 'output.json'), 'preserve unsupported state');
    const service = new EvalRunService(root, async () => {
      throw new Error('Old record must not execute');
    });
    await service.initialize();
    expect(service.list()).toEqual([]);
    expect(await readFile(path.join(folder, 'run.json'), 'utf8')).toBe(record);
    expect(await readFile(path.join(oldExecution, 'output.json'), 'utf8')).toBe(
      'preserve unsupported state',
    );
  });
}

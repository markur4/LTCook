import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createPiRpcRuntime } from '../../../runtime/src/integrations/pi-rpc.js';
import { RiedService } from '../../../runtime/src/tools/ried.js';

const environment = { ...process.env };
const originalCwd = process.cwd();
const directories: string[] = [];
afterEach(() => {
  process.chdir(originalCwd);
  process.env = { ...environment };
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ltcook-standalone-ried-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  const other = join(root, 'other');
  const agent = join(root, 'agent');
  const auth = join(root, 'auth');
  const cache = join(root, 'cache');
  for (const directory of [workspace, other, agent, auth]) mkdirSync(directory);
  const count = join(root, 'scan-count');
  const brief = join(root, 'brief');
  writeFileSync(
    brief,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'brief 0.16.0'; exit 0; fi\necho scan >> '${count}'\nprintf '%s\\n' '{"languages":[{"name":"TypeScript"}],"manifests":[],"dependencies":[],"stats":{}}'\n`,
  );
  chmodSync(brief, 0o700);
  Object.assign(process.env, {
    HOME: auth,
    PI_CODING_AGENT_DIR: agent,
    LTCOOK_PI_AUTH_DIR: auth,
    LTCOOK_RIED_CACHE_DIR: cache,
    LTCOOK_BRIEF_EXECUTABLE: brief,
    PI_OFFLINE: '1',
    LTCOOK_NATIVE_AGENT_ID: '',
    LTCOOK_SESSION_ID: '',
    LTCOOK_AGENT_API_TOKEN: '',
  });
  process.chdir(workspace);
  return { root, workspace, other, agent, cache, brief, count };
}

test('standalone native Pi exposes RIED with the shared cache and rebinds inventory on session changes', async () => {
  const f = fixture();
  const service = new RiedService(f.cache, f.brief, () => ({ PATH: process.env.PATH ?? '' }));
  await service.get({ id: 'managed', workspaceRoot: f.workspace }, { operation: 'summary' });
  const runtime = await createPiRpcRuntime(['--offline']);
  try {
    const read = async () => {
      expect(runtime.session.getActiveToolNames()).toContain('ltcook_ried');
      expect(runtime.session.getAllTools().map((tool) => tool.name)).not.toContain('ltcook_team');
      const tool = runtime.session.getToolDefinition('ltcook_ried');
      if (!tool) throw new Error('RIED was not registered in native Pi');
      const result = await tool.execute(
        'read-inventory',
        { operation: 'summary' },
        undefined,
        undefined,
        {} as never,
      );
      return result.details as { value: { workspaceRoot: string; languages: string[] } };
    };
    expect((await read()).value).toMatchObject({
      workspaceRoot: f.workspace,
      languages: ['TypeScript'],
    });
    expect(readFileSync(f.count, 'utf8').trim().split('\n')).toHaveLength(1);
    await runtime.newSession();
    expect((await read()).value.workspaceRoot).toBe(f.workspace);
    const messageId = runtime.session.sessionManager.appendMessage({
      role: 'user',
      content: 'fixture',
      timestamp: Date.now(),
    });
    await runtime.fork(messageId);
    expect((await read()).value.workspaceRoot).toBe(f.workspace);
    const other = SessionManager.create(f.other, join(f.root, 'sessions'));
    other.appendMessage({ role: 'user', content: 'other fixture', timestamp: Date.now() });
    await runtime.switchSession(other.getSessionFile()!);
    expect((await read()).value.workspaceRoot).toBe(f.other);
    expect(readFileSync(f.count, 'utf8').trim().split('\n')).toHaveLength(2);
  } finally {
    await runtime.dispose();
  }
});

test('standalone Pi without resolved AppRC inventory configuration exposes no RIED tool', async () => {
  fixture();
  delete process.env.LTCOOK_RIED_CACHE_DIR;
  const runtime = await createPiRpcRuntime(['--offline', '--no-session']);
  try {
    expect(runtime.session.getAllTools().map((tool) => tool.name)).not.toContain('ltcook_ried');
  } finally {
    await runtime.dispose();
  }
});

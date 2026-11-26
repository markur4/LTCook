import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildAgentDeepLinkRoute } from '@getpaseo/protocol/agent-deep-link';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WorkspaceMcp } from '../../../runtime/src/integrations/mcp.js';
import { ToolCatalog } from '../../../runtime/src/tools/catalog.js';
import { RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import {
  createWorktreeScopeResolver,
  SessionWorktrees,
} from '../../../runtime/src/integrations/session-worktrees.js';
import { createSessionWorktreeTool } from '../../../runtime/src/tools/session-worktree.js';
import { startPaseoHost } from '../../../runtime/src/integrations/paseo.js';

const root = path.resolve(import.meta.dir, '../../..');
const directory = process.argv[2];
assert(directory && process.platform === 'linux', 'Isolated Linux fixture directory required');
const gitWorkspace = path.join(directory, 'repository');
const deployment = path.join(directory, 'deployment');
const piHome = path.join(directory, 'pi');
const node = process.env.LTCOOK_TEST_NODE ?? 'node';
const run = promisify(execFile);
const browserSession = `ltcook-worktrees-${randomUUID()}`;
const secret = 'offline-worktree-system-token';
const environment = {
  ...process.env,
  PI_CODING_AGENT_DIR: piHome,
  LTCOOK_PI_AUTH_DIR: path.join(directory, 'auth'),
  PI_OFFLINE: '1',
};

async function browser(...args: string[]): Promise<string> {
  const result = await run(
    node,
    [
      path.join(root, 'node_modules/agent-browser/bin/agent-browser.js'),
      '--session',
      browserSession,
      ...args,
    ],
    { timeout: 30_000, maxBuffer: 2_000_000 },
  );
  return result.stdout;
}

async function clickButton(name: string): Promise<void> {
  await browser('find', 'role', 'button', 'click', '--name', name, '--exact');
}

await Promise.all([mkdir(gitWorkspace), mkdir(deployment), mkdir(piHome)]);
await writeFile(
  path.join(piHome, 'models.json'),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: 'http://127.0.0.1:1/v1',
        api: 'openai-completions',
        apiKey: 'fake-local-key',
        models: [{ id: 'test', name: 'Offline startup fixture' }],
      },
    },
  }),
);
await run('git', ['init', '-b', 'main'], { cwd: gitWorkspace });
await run(
  'git',
  [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '--no-gpg-sign',
    '-m',
    'Fixture',
  ],
  { cwd: gitWorkspace },
);

const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
const address = socket.address();
await new Promise<void>((resolve) => socket.close(() => resolve()));
assert(address && typeof address !== 'string');
const listen = `127.0.0.1:${address.port}`;
const endpoint = `http://${listen}`;
const worktrees = new SessionWorktrees(process.env.PATH ?? '');
const resolveScope = createWorktreeScopeResolver(() => undefined);
const api = new RuntimeApi(undefined, secret, listen, environment, undefined, {
  worktrees: { store: worktrees, resolveScope },
});
const tools = new ToolCatalog([createSessionWorktreeTool(worktrees, resolveScope)]);
api.setWorkspaceTools(tools);
api.setWorkspaceMcp(new WorkspaceMcp(tools, listen));
await api.listen();
let host: Awaited<ReturnType<typeof startPaseoHost>> | undefined;
try {
  host = await startPaseoHost({
    node,
    home: path.join(deployment, 'paseo'),
    deploymentRoot: deployment,
    listen: '127.0.0.1:0',
    runtimeApiUrl: endpoint,
    userToken: secret,
    pluginDirectory: path.join(root, 'runtime/dist/paseo-plugin'),
    environment,
    piCommand: path.join(root, 'runtime/dist/integrations/pi-rpc.js'),
  });
  const gitCheckout = await host.api.workspaces.open(gitWorkspace);
  const created = await Promise.all(
    ['first', 'second'].map(async (name) => {
      const agent = await gitCheckout.agents.create({
        title: `Worktree fixture ${name}`,
        config: { provider: 'pi/fixture/test' },
        env: environment,
      });
      return { name, agent, checkout: path.join(directory, `changes-${name}`) };
    }),
  );
  const [first, second] = created;
  assert(first && second);
  for (const { name, agent, checkout } of created) {
    await run('git', ['worktree', 'add', '-b', `changes/${name}`, checkout], {
      cwd: gitWorkspace,
    });
    await writeFile(path.join(checkout, `${name}-session.txt`), `${name} worktree change\n`);
    const grant = await fetch(`${endpoint}/v1/mcp/grant`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        nativeAgentId: agent.id,
        workspaceRoot: gitWorkspace,
        provider: 'pi',
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(grant.status, 200);
    const { token } = (await grant.json()) as { token: string };
    const client = new Client({ name: 'worktree-fixture', version: '1.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      const registration = await client.callTool({
        name: 'ltcook_worktree',
        arguments: { operation: 'use', path: checkout },
      });
      assert.deepEqual(registration.structuredContent, { ok: true });
    } finally {
      await client.close();
    }
  }
  const extraFile = path.join(first.checkout, 'first-extra.txt');
  await writeFile(extraFile, 'Another change in the first worktree\n');
  const status = await fetch(`http://${host.listen}/api/status`);
  assert.equal(status.status, 200);
  const { serverId } = (await status.json()) as { serverId: string };
  assert(serverId);
  await browser('set', 'viewport', '1440', '1000');
  await browser('open', `http://${host.listen}`);
  await browser('wait', '--text', 'New workspace');
  for (const { name, agent } of [second, first]) {
    await browser(
      'open',
      `http://${host.listen}${buildAgentDeepLinkRoute({ serverId, agentId: agent.id })}`,
    );
    await browser('wait', '--text', `Worktree fixture ${name}`);
  }
  await browser('wait', '--text', 'Recent conversation activity');
  const report = await fetch(`${endpoint}/v1/session/worktrees`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ nativeAgentId: first.agent.id, workspaceRoot: gitWorkspace }),
  });
  assert.equal(report.status, 200);
  assert.deepEqual((await report.json()).following, {
    path: first.checkout,
    branch: 'changes/first',
  });
  await clickButton('Working tree diff');
  const worktreePicker = '[data-testid="changes-worktree-picker"]';
  const waitForFile = (name: string) => browser('wait', `[aria-label^="${name}-session.txt,"]`);
  const firstFile = '[aria-label^="first-session.txt,"][aria-expanded]';
  const secondFile = '[aria-label^="second-session.txt,"][aria-expanded]';
  const extraCollapsed = '[aria-label^="first-extra.txt,"][aria-expanded="false"]';
  await browser('wait', worktreePicker);
  await browser('wait', `${firstFile}[aria-expanded="false"]`);
  await browser('wait', extraCollapsed);
  await browser('click', firstFile);
  await browser('wait', `${firstFile}[aria-expanded="true"]`);
  await browser('wait', extraCollapsed);
  await browser('click', worktreePicker);
  await browser('find', 'text', 'changes/second', 'click', '--exact');
  await browser('wait', `${secondFile}[aria-expanded="false"]`);
  await browser('click', worktreePicker);
  await browser('find', 'text', 'Original checkout', 'click', '--exact');
  await browser('wait', '[data-testid="changes-branch-switcher"]');
  await clickButton('Worktree fixture second');
  await waitForFile('second');
  await clickButton('Worktree fixture first');
  await browser('wait', '[data-testid="changes-branch-switcher"]');
  await browser('click', worktreePicker);
  await browser('find', 'text', 'Follow session', 'click', '--exact');
  await browser('wait', `${firstFile}[aria-expanded="false"]`);
  await Promise.all([unlink(path.join(first.checkout, 'first-session.txt')), unlink(extraFile)]);
  await run('git', ['worktree', 'remove', first.checkout], { cwd: gitWorkspace });
  await browser('wait', '[data-testid="changes-branch-switcher"]');
  assert.equal(
    (await run('git', ['branch', '--show-current'], { cwd: gitWorkspace })).stdout.trim(),
    'main',
  );
  console.log(
    JSON.stringify({ result: 'passed', changes: 'follow, pin, resume, and worktree removal' }),
  );
} catch (error) {
  console.error(await browser('snapshot').catch(() => 'Browser unavailable'));
  console.error(await browser('errors').catch(() => 'Browser errors unavailable'));
  throw error;
} finally {
  await browser('close').catch(() => undefined);
  await host?.close();
  await api.close();
}

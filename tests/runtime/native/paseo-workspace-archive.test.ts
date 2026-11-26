import { afterAll, afterEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  authorizeIdleRestart,
  createIdleRestartGate,
  idleRestart,
  idleRestartHandler,
  idleRestartPath,
  workspaceArchiveHandler,
  workspaceArchivePath,
  workspaceArchiveRequestPrefix,
} from '../../../paseo-patches/idle-restart/gate.mjs';
import { patches } from '../../../paseo-patches/idle-restart/patch.mjs';

const serverRoot = new URL(
  '../../../',
  pathToFileURL(createRequire(import.meta.url).resolve('@getpaseo/server')),
);
const patchRoot = new URL('../../../paseo-patches/idle-restart/', import.meta.url);
const gateUrl = new URL('gate.mjs', patchRoot).href;
const archiveFile = 'dist/server/server/workspace-archive-service.js';
const moduleDirectory = mkdtempSync(join(tmpdir(), 'ltcook-archive-module-'));
async function importPatched(file: keyof typeof patches, name: string) {
  const original = new URL(file, serverRoot);
  const transformed = patches[file]
    .apply(readFileSync(original, 'utf8'), { gateUrl })
    .replace(/from "(\.[^"]+)"/g, (_, relative) => {
      return `from ${JSON.stringify(new URL(relative, original).href)}`;
    });
  writeFileSync(join(moduleDirectory, name), transformed);
  return import(pathToFileURL(join(moduleDirectory, name)).href);
}
const { archiveByScope } = await importPatched(archiveFile, 'archive.mjs');
const { sendPromptToAgent } = await importPatched(
  'dist/server/server/agent/agent-prompt.js',
  'prompt.mjs',
);
const { WorkspaceSetupRuntime } = await import(
  new URL('dist/server/server/workspace-setup-runtime.js', serverRoot).href
);
afterAll(() => rmSync(moduleDirectory, { recursive: true, force: true }));

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'ltcook-preserving-archive-'));
  directories.push(root);
  return root;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=',
      ...args,
    ],
    { cwd, stdio: 'pipe', encoding: 'utf8' },
  ).trim();
}

function nativeFixture() {
  const root = temporary();
  const repository = join(root, 'repository');
  const checkout = join(root, 'checkout');
  mkdirSync(repository);
  git(repository, 'init', '-qb', 'main');
  writeFileSync(join(repository, 'tracked.txt'), 'committed\n');
  writeFileSync(join(repository, '.gitignore'), '.cache/\n');
  writeFileSync(
    join(repository, 'paseo.json'),
    JSON.stringify({ worktree: { teardown: ['echo teardown > ../teardown-ran.txt'] } }),
  );
  git(repository, 'add', '.');
  git(repository, 'commit', '--no-gpg-sign', '-qm', 'Fixture');
  git(repository, 'worktree', 'add', '-qb', 'task', checkout);
  const workspace = {
    workspaceId: 'workspace-one',
    cwd: checkout,
    kind: 'worktree',
    worktreeRoot: checkout,
    isPaseoOwnedWorktree: true,
    mainRepoRoot: repository,
    archivedAt: null as string | null,
    pinnedAt: null as string | null,
  };
  const archivedAgents: string[] = [];
  const stoppedSetups: string[] = [];
  let activeTurns: number | undefined = 0;
  const hooks = { beforeRecords: () => {}, atArchive: () => {} };
  const dependencies = {
    paseoHome: join(root, 'paseo'),
    github: { invalidate: () => {} },
    workspaceGitService: { getSnapshot: async () => ({}), invalidateWorktrees: () => {} },
    agentManager: {
      ltcookIdleRestartActiveTurns: () => activeTurns,
      listAgents: () => [],
      getAgent: () => undefined,
      archiveSnapshot: async (id: string) => {
        archivedAgents.push(id);
      },
    },
    agentStorage: { listByWorkspace: async () => [{ id: 'agent-one', archivedAt: null }] },
    getWorkspace: async () => workspace,
    findWorkspaceIdForCwd: async () => workspace.workspaceId,
    listActiveWorkspaces: async () => (workspace.archivedAt ? [] : [workspace]),
    archiveWorkspaceRecord: async (_id: string, at: string) => {
      workspace.archivedAt = at;
      hooks.atArchive();
    },
    emitWorkspaceUpdatesForWorkspaceIds: async () => hooks.beforeRecords(),
    markWorkspaceArchiving: () => {},
    clearWorkspaceArchiving: () => {},
    killTerminalsForWorkspace: async () => {},
    stopWorkspaceSetup: async (workspaceId: string) => {
      stoppedSetups.push(workspaceId);
    },
    assertWorkspaceAutomationAllowed: async () => {},
  };
  return {
    root,
    repository,
    checkout,
    workspace,
    dependencies,
    archivedAgents,
    stoppedSetups,
    hooks,
    setActiveTurns: (value: number | undefined) => {
      activeTurns = value;
    },
  };
}

test('Published archive code preserves dirty, untracked, ignored, and late-written worktree files', async () => {
  const f = nativeFixture();
  writeFileSync(join(f.checkout, 'tracked.txt'), 'uncommitted\n');
  writeFileSync(join(f.checkout, 'untracked.txt'), 'untracked\n');
  mkdirSync(join(f.checkout, '.cache'));
  writeFileSync(join(f.checkout, '.cache', 'ignored.txt'), 'ignored\n');
  f.hooks.atArchive = () => writeFileSync(join(f.checkout, 'late.txt'), 'late save\n');
  const result = await archiveByScope(f.dependencies, {
    requestId: `${workspaceArchiveRequestPrefix}fixture`,
    scope: { kind: 'workspace', workspaceId: f.workspace.workspaceId },
  });
  expect(result).toEqual({
    archivedAgentIds: ['agent-one'],
    archivedWorkspaceIds: ['workspace-one'],
    removedDirectory: false,
  });
  expect(f.workspace.archivedAt).toBeString();
  expect(f.archivedAgents).toEqual(['agent-one']);
  expect(f.stoppedSetups).toEqual([]);
  expect(readFileSync(join(f.checkout, 'tracked.txt'), 'utf8')).toBe('uncommitted\n');
  expect(readFileSync(join(f.checkout, 'untracked.txt'), 'utf8')).toBe('untracked\n');
  expect(readFileSync(join(f.checkout, '.cache', 'ignored.txt'), 'utf8')).toBe('ignored\n');
  expect(readFileSync(join(f.checkout, 'late.txt'), 'utf8')).toBe('late save\n');
  expect(existsSync(join(f.root, 'teardown-ran.txt'))).toBe(false);
  expect(git(f.repository, 'worktree', 'list', '--porcelain')).toContain(f.checkout);
});

test('Manual native archive still runs teardown and removes its owned worktree', async () => {
  const f = nativeFixture();
  const result = await archiveByScope(f.dependencies, {
    requestId: 'manual-archive',
    scope: { kind: 'workspace', workspaceId: f.workspace.workspaceId },
  });
  expect(result.removedDirectory).toBe(true);
  expect(f.stoppedSetups).toEqual(['workspace-one']);
  expect(existsSync(f.checkout)).toBe(false);
  expect(readFileSync(join(f.root, 'teardown-ran.txt'), 'utf8').trim()).toBe('teardown');
});

test.each([1, undefined])(
  'Preserving archive rechecks native work before records change and fails closed (%s)',
  async (activeTurns) => {
    const f = nativeFixture();
    f.hooks.beforeRecords = () => f.setActiveTurns(activeTurns);
    await expect(
      archiveByScope(f.dependencies, {
        requestId: `${workspaceArchiveRequestPrefix}fixture`,
        scope: { kind: 'workspace', workspaceId: f.workspace.workspaceId },
      }),
    ).rejects.toThrow('active or pending');
    expect(f.workspace.archivedAt).toBeNull();
    expect(f.archivedAgents).toEqual([]);
    expect(existsSync(f.checkout)).toBe(true);
    expect(existsSync(join(f.root, 'teardown-ran.txt'))).toBe(false);
  },
);

test('Preserving request IDs reject worktree scope before inspecting or changing records', async () => {
  await expect(
    archiveByScope(
      {},
      {
        requestId: `${workspaceArchiveRequestPrefix}fixture`,
        scope: { kind: 'worktree', targetPath: '/unused' },
      },
    ),
  ).rejects.toThrow('requires workspace scope');
});

function responseFixture() {
  return {
    code: 200,
    body: undefined as unknown,
    status(code: number) {
      this.code = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

function patchedBootstrap() {
  const bootstrapFile = 'dist/server/server/bootstrap.js';
  return patches[bootstrapFile].apply(readFileSync(new URL(bootstrapFile, serverRoot), 'utf8'), {
    gateUrl,
  });
}

function wrapNativeAdmissions(terminalManager: object, workspaceSetupRuntime: object) {
  const source = patchedBootstrap();
  const terminalStart = source.indexOf('    const ltcookCreateTerminal =');
  const terminalEnd = source.indexOf('    applyTerminalAgentHookSetting(', terminalStart);
  const setupStart = source.indexOf('    const ltcookStartWorkspaceSetup =');
  const setupEnd = source.indexOf('    let configuredHostnames =', setupStart);
  expect(terminalStart).toBeGreaterThan(0);
  expect(terminalEnd).toBeGreaterThan(terminalStart);
  expect(setupStart).toBeGreaterThan(0);
  expect(setupEnd).toBeGreaterThan(setupStart);
  runInNewContext(source.slice(terminalStart, terminalEnd) + source.slice(setupStart, setupEnd), {
    idleRestart,
    terminalManager,
    workspaceSetupRuntime,
  });
}

function bootstrapFixture() {
  const calls: string[][] = [];
  const workspace = { workspaceId: 'workspace-one', archivedAt: null, pinnedAt: null };
  const setup = { runs: new Map() };
  const state = { active: 0, queued: false, terminals: [] as object[], terminalError: false };
  const routes = new Map<string, Array<(...args: any[]) => any>>();
  const source = patchedBootstrap();
  const start = source.indexOf('    app.post(\n        idleRestartPath,');
  const end = source.indexOf('    // Serve the bundled browser web UI', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  runInNewContext(source.slice(start, end), {
    Map,
    app: {
      post: (path: string, ...handlers: Array<(...args: any[]) => any>) =>
        routes.set(path, handlers),
    },
    express: { json: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    authorizeIdleRestart,
    idleRestartHandler,
    idleRestartPath,
    workspaceArchiveHandler,
    workspaceArchivePath,
    isLoopbackRemoteAddress: (address: string) => address === '127.0.0.1',
    process: { env: { LTCOOK_RUNTIME_USER_TOKEN: 'user-secret' } },
    config: { onLifecycleIntent: () => {} },
    workspaceRegistry: { get: async () => workspace },
    workspaceSetupRuntime: setup,
    terminalManager: {
      getUnavailableError: () => state.terminalError,
      listDirectories: () => ['/checkout'],
      getTerminals: async () => state.terminals,
    },
    agentManager: { ltcookIdleRestartActiveTurns: () => state.active },
    wsServer: { agentMessages: { hasAnyPending: () => state.queued } },
    archiveWorkspaceByIdExternal: async (workspaceId: string, requestId: string) => {
      calls.push([workspaceId, requestId]);
      return { archivedWorkspaceIds: [workspaceId], removedDirectory: false };
    },
  });
  return { routes, calls, workspace, setup, state };
}

test('The hash-patched bootstrap protects its dedicated route and generates preserving IDs inside the request', async () => {
  const f = bootstrapFixture();
  const [authorize, parse, handle] = f.routes.get(workspaceArchivePath)!;
  for (const [address, token] of [
    ['127.0.0.1', 'Bearer wrong-secret'],
    ['192.0.2.1', 'Bearer user-secret'],
    ['127.0.0.1', undefined],
  ]) {
    const response = responseFixture();
    authorize(
      { socket: { remoteAddress: address }, headers: { authorization: token } },
      response,
      () => {
        throw new Error('Unauthorized request reached archive');
      },
    );
    expect(response.code).toBe(403);
  }
  const response = responseFixture();
  const request = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { authorization: 'Bearer user-secret' },
    body: { workspaceId: 'workspace-one' },
  };
  let authorized = false;
  authorize(request, response, () => {
    authorized = true;
  });
  expect(authorized).toBe(true);
  await new Promise<void>((resolve) => parse(request, response, resolve));
  await handle(request, response);
  expect(response.code).toBe(200);
  expect(response.body).toEqual({
    archived: true,
    workspaceId: 'workspace-one',
    preservedDirectory: true,
  });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.[1]).toMatch(/^ltcook-preserve-workspace-[0-9a-f-]{36}$/);
  const statusResponse = responseFixture();
  f.routes.get(idleRestartPath)![2]!({ body: { operation: 'status' } }, statusResponse);
  expect(statusResponse.body).toEqual({
    status: 'ready',
    workspaceArchive: 'preserve-directory-v1',
  });
});

test.each(['pinned', 'setup', 'terminal', 'active', 'queued', 'unavailable'])(
  'The preserving HTTP archive rejects native %s state without invoking archive',
  async (reason) => {
    const f = bootstrapFixture();
    if (reason === 'pinned') Object.assign(f.workspace, { pinnedAt: '2026-11-26' });
    if (reason === 'setup') f.setup.runs.set('workspace-one', {});
    if (reason === 'terminal') f.state.terminals = [{ workspaceId: 'workspace-one' }];
    if (reason === 'active') f.state.active = 1;
    if (reason === 'queued') f.state.queued = true;
    if (reason === 'unavailable') f.state.terminalError = true;
    const response = responseFixture();
    await f.routes.get(workspaceArchivePath)![2]!(
      { body: { workspaceId: 'workspace-one' } },
      response,
    );
    expect(response.code).toBe(reason === 'unavailable' ? 500 : 409);
    expect(f.calls).toEqual([]);
  },
);

test('The archive route rejects caller-controlled IDs and leaves already archived workspaces alone', async () => {
  const f = bootstrapFixture();
  const handler = f.routes.get(workspaceArchivePath)![2]!;
  const invalid = responseFixture();
  await handler({ body: { workspaceId: 'workspace-one', requestId: 'manual-archive' } }, invalid);
  expect(invalid.code).toBe(400);
  Object.assign(f.workspace, { archivedAt: '2026-11-26' });
  const archived = responseFixture();
  await handler({ body: { workspaceId: 'workspace-one' } }, archived);
  expect(archived.body).toEqual({
    archived: false,
    workspaceId: 'workspace-one',
    preservedDirectory: true,
  });
  expect(f.calls).toEqual([]);
});

test('Prompts, terminals, and setup are rejected during the archive mutation boundary', async () => {
  const f = nativeFixture();
  const terminalManager = {
    created: 0,
    async createTerminal() {
      this.created++;
    },
  };
  const setup = new WorkspaceSetupRuntime();
  wrapNativeAdmissions(terminalManager, setup);
  const reachedMutation = Promise.withResolvers<void>();
  const allowMutation = Promise.withResolvers<void>();
  f.dependencies.agentStorage.listByWorkspace = async () => {
    reachedMutation.resolve();
    await allowMutation.promise;
    return [{ id: 'agent-one', archivedAt: null }];
  };
  const handler = workspaceArchiveHandler({
    getWorkspace: f.dependencies.getWorkspace,
    isSetupRunning: () => false,
    listTerminals: async () => [],
    countActiveTurns: () => 0,
    archiveWorkspace: (workspaceId: string, requestId: string) =>
      archiveByScope(f.dependencies, { requestId, scope: { kind: 'workspace', workspaceId } }),
  });
  const response = responseFixture();
  const finished = handler({ body: { workspaceId: 'workspace-one' } }, response);
  await reachedMutation.promise;
  try {
    await expect(sendPromptToAgent({})).rejects.toThrow('reserved');
    await expect(terminalManager.createTerminal()).rejects.toThrow('reserved');
    expect(terminalManager.created).toBe(0);
    expect(() => setup.start('workspace-one', async () => {})).toThrow('reserved');
    expect(setup.runs.size).toBe(0);
    expect(f.workspace.archivedAt).toBeNull();
    const duplicate = responseFixture();
    await handler({ body: { workspaceId: 'workspace-one' } }, duplicate);
    expect(duplicate.code).toBe(409);
  } finally {
    allowMutation.resolve();
    await finished;
  }
  expect(response.code).toBe(200);
  expect(f.workspace.archivedAt).toBeString();
  expect(await idleRestart.run(async () => 'admitted')).toBe('admitted');
  await terminalManager.createTerminal();
  expect(terminalManager.created).toBe(1);
  let setupStarted = false;
  setup.start('workspace-one', async () => {
    setupStarted = true;
  });
  await setup.stop('workspace-one');
  expect(setupStarted).toBe(true);
});

test('A terminal creation already awaiting the worker prevents an archive reservation', async () => {
  const pending = Promise.withResolvers<void>();
  const manager = { createTerminal: () => pending.promise };
  wrapNativeAdmissions(manager, new WorkspaceSetupRuntime());
  const creation = manager.createTerminal();
  try {
    const f = bootstrapFixture();
    const response = responseFixture();
    await f.routes.get(workspaceArchivePath)![2]!(
      { body: { workspaceId: 'workspace-one' } },
      response,
    );
    expect(response.code).toBe(409);
    expect(f.calls).toEqual([]);
  } finally {
    pending.resolve();
    await creation;
  }
  expect(await idleRestart.run(async () => 'admitted')).toBe('admitted');
});

test('Exclusive archive admission has no expiry gap and refuses already admitted work', async () => {
  let now = 0;
  const gate = createIdleRestartGate(() => now);
  const pending = Promise.withResolvers<void>();
  const work = gate.run(() => pending.promise);
  expect(gate.reserveMaintenance(() => 0)).toBeUndefined();
  pending.resolve();
  await work;
  const release = gate.reserveMaintenance(() => 0);
  expect(release).toBeFunction();
  now = 60_000;
  await expect(gate.run(async () => {})).rejects.toThrow('reserved');
  expect(gate.reserveMaintenance(() => 0)).toBeUndefined();
  release!();
  expect(await gate.run(async () => 'admitted')).toBe('admitted');
});

test('An archive error releases its exclusive reservation for the next prompt', async () => {
  const f = bootstrapFixture();
  f.state.terminalError = true;
  const response = responseFixture();
  await f.routes.get(workspaceArchivePath)![2]!(
    { body: { workspaceId: 'workspace-one' } },
    response,
  );
  expect(response.code).toBe(500);
  expect(await idleRestart.run(async () => 'admitted')).toBe('admitted');
});

test('All loader patches match the installed pin and a modified archive source stops hook registration', () => {
  const fixture = temporary();
  const fakeServer = join(fixture, 'node_modules', '@getpaseo', 'server');
  const fakeLoader = join(fixture, 'idle-restart');
  mkdirSync(fakeLoader, { recursive: true });
  for (const file of ['register.mjs', 'gate.mjs', 'patch.mjs']) {
    copyFileSync(new URL(file, patchRoot), join(fakeLoader, file));
  }
  for (const [file, patch] of Object.entries(patches)) {
    const source = readFileSync(new URL(file, serverRoot), 'utf8');
    expect(createHash('sha256').update(source).digest('hex')).toBe(patch.sha256);
    expect(() =>
      patch.apply(source, { gateUrl, registerUrl: new URL('register.mjs', patchRoot).href }),
    ).not.toThrow();
    mkdirSync(dirname(join(fakeServer, file)), { recursive: true });
    writeFileSync(
      join(fakeServer, file),
      source + (file === archiveFile ? '\n// changed source\n' : ''),
    );
  }
  writeFileSync(
    join(fakeServer, 'package.json'),
    JSON.stringify({
      name: '@getpaseo/server',
      version: '0.16.0-beta.2',
      type: 'module',
      exports: './dist/server/server/index.js',
    }),
  );
  writeFileSync(join(fakeServer, 'dist/server/server/index.js'), '');
  const node = process.env.LTCOOK_NODE_EXECUTABLE ?? Bun.which('node');
  expect(node).toBeString();
  const result = spawnSync(
    node!,
    [
      '--import',
      pathToFileURL(join(fakeLoader, 'register.mjs')).href,
      '--eval',
      'process.stdout.write("registered")',
    ],
    { cwd: fixture, encoding: 'utf8', timeout: 10_000 },
  );
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain('registered');
  expect(result.stderr).toContain(
    `Unexpected Paseo source for LTCook idle restart: ${archiveFile}`,
  );
});

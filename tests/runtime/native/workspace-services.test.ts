import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoAgent, PaseoApi, PaseoWorkspace } from '@getpaseo/client';
import {
  PaseoWorkspaceServices,
  seedWorkspaceLabels,
  type PaseoWorkspaceServicesOptions,
  type WorkspaceNativeMutations,
} from '../../../runtime/src/integrations/paseo-workspace-services.js';
import { WORKSPACE_LABELS } from '../../../runtime/src/services/workspace-metadata.js';

const roots: string[] = [];
const activeServices: PaseoWorkspaceServices[] = [];
const signal = new AbortController().signal;
const old = '2026-09-01T10:00:00.000Z';

afterEach(async () => {
  await Promise.allSettled(activeServices.splice(0).map((service) => service.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitUntil(condition: () => boolean, timeout = 1800) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Workspace service condition did not become true.');
    await Bun.sleep(5);
  }
}

function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'ltcook-native-workspaces-'));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_COMMON_DIR: undefined,
    },
  }).trim();
}

function commit(root: string) {
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Fixture',
  );
}

function gitFixture() {
  const root = temporary();
  const repository = join(root, 'repository');
  const checkout = join(root, 'checkout');
  mkdirSync(repository);
  git(repository, 'init', '-q', '-b', 'main');
  mkdirSync(join(repository, 'nested'));
  writeFileSync(join(repository, 'nested', 'tracked.txt'), 'committed\n');
  writeFileSync(join(repository, '.gitignore'), '.cache/\n');
  writeFileSync(join(repository, 'paseo.json'), '{}');
  commit(repository);
  git(repository, 'worktree', 'add', '-q', '-b', 'task', checkout);
  const workspace = {
    workspaceKind: 'worktree',
    projectKind: 'git',
    projectRootPath: repository,
    workspaceDirectory: checkout,
    gitRuntime: { isPaseoOwnedWorktree: true },
  } as PaseoWorkspace;
  return { root, repository, checkout, workspace };
}

function nativeFixture(environment: NodeJS.ProcessEnv = {}) {
  const root = temporary();
  const workspace: PaseoWorkspace = {
    id: 'workspace-one',
    projectId: 'project-one',
    projectDisplayName: 'Project',
    projectRootPath: root,
    workspaceDirectory: root,
    workspaceKind: 'directory',
    projectKind: 'directory',
    name: 'Task',
    title: 'Task',
    createdAt: old,
    lastUserMessageAt: old,
    labels: ['Personal', 'Feature'],
    metadata: {},
    status: 'done',
    statusEnteredAt: old,
    activityAt: old,
    scripts: [],
    gitRuntime: null,
  };
  const agent = {
    id: 'agent-one',
    workspaceId: workspace.id,
    provider: 'codex',
    cwd: root,
    title: 'Task session',
    createdAt: old,
    updatedAt: old,
    lastUserMessageAt: old,
    status: 'idle',
    pendingPermissions: [],
    labels: {},
    archivedAt: null,
  } as PaseoAgent;
  const workspacePages: PaseoWorkspace[][] = [[workspace]];
  const agentPages: PaseoAgent[][] = [[agent]];
  let queued = false;
  let historyAvailable = true;
  let providerRunning = false;
  let terminals: object[] = [];
  let workspaceListener: Parameters<PaseoApi['workspaces']['subscribe']>[0] | undefined;
  const calls: string[] = [];
  const agents = () => agentPages.flat();
  const workspaces = () => workspacePages.flat();
  const page = <T>(pages: T[][], cursor?: string) => {
    const index = cursor ? Number(cursor) : 0;
    return {
      entries: pages[index] ?? [],
      pageInfo: { nextCursor: index + 1 < pages.length ? String(index + 1) : null },
    };
  };
  const api = {
    workspaces: {
      subscribe: (handler: NonNullable<typeof workspaceListener>) => {
        calls.push('listener:subscribe');
        workspaceListener = handler;
        return () => {
          calls.push('listener:unsubscribe');
          workspaceListener = undefined;
        };
      },
      list: async ({
        page: input,
        subscribe,
      }: {
        page: { cursor?: string };
        subscribe?: object;
      }) => {
        calls.push(`workspaces:${input.cursor ?? 'first'}`);
        return {
          ...page(workspacePages, input.cursor),
          ...(subscribe
            ? {
                subscription: {
                  release: async () => {
                    calls.push('feed:release');
                  },
                },
              }
            : {}),
        };
      },
      ref: (id: string) => ({
        refresh: async () => workspaces().find((value) => value.id === id),
        terminals: { list: async () => ({ entries: terminals }) },
        archive: async () => {
          calls.push(`unsafe-archive:${id}`);
          throw new Error('Automatic archive must never use the directory-removing SDK route.');
        },
        setTitle: async (title: string) => {
          workspaces().find((value) => value.id === id)!.title = title;
        },
        setMetadata: async (metadata: Record<string, number>) => {
          const current = workspaces().find((value) => value.id === id)!;
          current.metadata = { ...current.metadata, ...metadata };
        },
      }),
    },
    agents: {
      list: async ({ page: input }: { page: { cursor?: string } }) => {
        calls.push(`agents:${input.cursor ?? 'first'}`);
        const result = page(agentPages, input.cursor);
        return { ...result, entries: result.entries.map((agent) => ({ agent })) };
      },
      ref: (id: string) => ({
        timeline: {
          refetch: async () => {
            calls.push(`timeline:${id}`);
            if (!historyAvailable) throw new Error('History is unavailable.');
            return {
              agent: agents().find((value) => value.id === id),
              epoch: 'epoch-one',
              window: { minSeq: 1, maxSeq: 1 },
              entries: [
                {
                  seqStart: 1,
                  seqEnd: 1,
                  timestamp: old,
                  item: { type: 'user_message', text: 'Fix the login crash.' },
                },
              ],
            };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  const mutations = {
    listWorkspaceLabels: async () => ({ labels: [...WORKSPACE_LABELS] }),
    updateWorkspaceLabel: async () => {},
    setWorkspaceLabel: async (input: {
      workspaceId: string;
      label: { name: string };
      assigned: boolean;
    }) => {
      const current = workspaces().find((value) => value.id === input.workspaceId)!;
      current.labels = current.labels?.filter((name) => name !== input.label.name) ?? [];
      if (input.assigned) current.labels.push(input.label.name);
    },
    updateAgent: async (id: string, update: { name: string }) => {
      const current = agents().find((value) => value.id === id)!;
      current.title = update.name;
      current.updatedAt = new Date().toISOString();
    },
  } as unknown as WorkspaceNativeMutations;
  const options = {
    api,
    mutations,
    stateDirectory: root,
    environment: {
      LTCOOK_RENAMER_ENABLED: 'false',
      LTCOOK_WORKSPACE_ORGANIZER_AUTO_ARCHIVE: 'false',
      ...environment,
    },
    generator: {
      classify: async () => ({ category: 'Bugfix' }),
      rename: async () => ({ agents: [] }),
    },
    isQueued: () => queued,
    listProviderSubagents: async () => (providerRunning ? [{ status: 'running' }] : []),
    archiveWorkspacePreservingFiles: async (id: string) => {
      calls.push(`archive:${id}`);
      return true;
    },
  } as PaseoWorkspaceServicesOptions;
  const services = new PaseoWorkspaceServices(options);
  activeServices.push(services);
  return {
    root,
    workspace,
    agent,
    workspacePages,
    agentPages,
    options,
    calls,
    services,
    emitWorkspaceUpdate: () =>
      workspaceListener?.({} as Parameters<NonNullable<typeof workspaceListener>>[0]),
    setQueued: (value: boolean) => {
      queued = value;
    },
    setTerminals: (value: object[]) => {
      terminals = value;
    },
    setHistoryAvailable: (value: boolean) => {
      historyAvailable = value;
    },
    setProviderRunning: (value: boolean) => {
      providerRunning = value;
    },
  };
}

test('Default label seeding creates a private catalog and leaves existing definitions unchanged', async () => {
  const root = temporary();
  const catalog = join(root, 'projects', 'workspace-labels.json');
  await seedWorkspaceLabels(root);
  expect(JSON.parse(readFileSync(catalog, 'utf8'))).toEqual(WORKSPACE_LABELS);
  if (process.platform !== 'win32') expect(statSync(catalog).mode & 0o777).toBe(0o600);
  const original = JSON.stringify([{ name: 'Personal', color: 'teal' }]);
  writeFileSync(catalog, original);
  await seedWorkspaceLabels(root);
  expect(readFileSync(catalog, 'utf8')).toBe(original);
});

test('Missing default labels retry as soon as a usable workspace appears', async () => {
  const f = nativeFixture();
  const catalog: { name: string; color: string }[] = [];
  f.options.mutations.listWorkspaceLabels = (async () => ({
    labels: catalog,
  })) as typeof f.options.mutations.listWorkspaceLabels;
  const assign = f.options.mutations.setWorkspaceLabel.bind(f.options.mutations);
  f.options.mutations.setWorkspaceLabel = async (input, ...rest) => {
    const result = await assign(input, ...rest);
    if (input.assigned && !catalog.some(({ name }) => name === input.label.name))
      catalog.push({ name: input.label.name, color: input.label.color! });
    return result;
  };
  f.workspacePages[0] = [];
  f.agentPages[0] = [];
  await f.services.poll();
  expect(f.services.organizer.status().diagnostic).toBeDefined();
  expect(catalog).toEqual([]);
  f.workspacePages[0] = [f.workspace];
  f.agentPages[0] = [f.agent];
  await f.services.poll();
  expect(catalog).toEqual(WORKSPACE_LABELS);
  expect(f.services.organizer.status().diagnostic).toBeUndefined();
  expect(f.workspace.labels).toEqual(['Personal', 'Bugfix']);
});

test('Workspace subscription starts once and event bursts shorten the periodic wait without starvation', async () => {
  const f = nativeFixture();
  const original = f.options.api.workspaces.list.bind(f.options.api.workspaces);
  let subscriptions = 0;
  f.options.api.workspaces.list = (async (input) => {
    if (input?.subscribe) subscriptions++;
    return original(input);
  }) as typeof f.options.api.workspaces.list;
  f.services.start();
  f.services.start();
  await f.services.poll();
  expect(subscriptions).toBe(1);
  expect(f.calls.filter((value) => value === 'listener:subscribe')).toHaveLength(1);
  const before = f.calls.filter((value) => value === 'workspaces:first').length;
  f.emitWorkspaceUpdate();
  const storm = setInterval(() => f.emitWorkspaceUpdate(), 40);
  try {
    await waitUntil(() => f.calls.filter((value) => value === 'workspaces:first').length > before);
  } finally {
    clearInterval(storm);
  }
  await f.services.close();
  await f.services.close();
  expect(f.calls.filter((value) => value === 'workspaces:first')).toHaveLength(before + 1);
  expect(subscriptions).toBe(1);
  expect(f.calls.filter((value) => value === 'feed:release')).toHaveLength(1);
  expect(f.calls.filter((value) => value === 'listener:unsubscribe')).toHaveLength(1);
  f.services.start();
  f.emitWorkspaceUpdate();
  expect(f.calls.filter((value) => value === 'listener:subscribe')).toHaveLength(1);
});

test('Closing during subscription creation releases the late handle without starting a maintenance poll', async () => {
  const f = nativeFixture();
  const original = f.options.api.workspaces.list.bind(f.options.api.workspaces);
  let finish: (() => void) | undefined;
  f.options.api.workspaces.list = (async (input) => {
    if (!input?.subscribe) return original(input);
    return new Promise((resolve) => {
      finish = () => {
        void original(input).then(resolve);
      };
    });
  }) as typeof f.options.api.workspaces.list;
  f.services.start();
  const polling = f.services.poll();
  await waitUntil(() => finish !== undefined);
  const closing = f.services.close();
  finish!();
  await Promise.all([polling, closing]);
  expect(f.calls.filter((value) => value === 'workspaces:first')).toHaveLength(1);
  expect(f.calls.filter((value) => value === 'feed:release')).toHaveLength(1);
  expect(f.calls.filter((value) => value === 'listener:unsubscribe')).toHaveLength(1);
  expect(f.workspace.labels).toEqual(['Personal', 'Feature']);
});

test('A failed subscription retries on the next poll without duplicating the local listener', async () => {
  const f = nativeFixture();
  const original = f.options.api.workspaces.list.bind(f.options.api.workspaces);
  let attempts = 0;
  f.options.api.workspaces.list = (async (input) => {
    if (input?.subscribe && ++attempts === 1) throw new Error('Daemon is reconnecting.');
    return original(input);
  }) as typeof f.options.api.workspaces.list;
  f.services.start();
  await f.services.poll();
  expect(f.services.status().diagnostic).toContain('inventory');
  await f.services.poll();
  expect(attempts).toBe(2);
  expect(f.services.status().diagnostic).toBeUndefined();
  expect(f.calls.filter((value) => value === 'listener:subscribe')).toHaveLength(1);
  await f.services.close();
  expect(f.calls.filter((value) => value === 'feed:release')).toHaveLength(1);
});

test('Workspace events arriving during an active poll cause one follow-up after the poll finishes', async () => {
  const f = nativeFixture();
  let finish: (() => void) | undefined;
  f.options.generator!.classify = async () =>
    new Promise((resolve) => {
      finish = () => resolve({ category: 'Bugfix' });
    });
  f.services.start();
  const polling = f.services.poll();
  await waitUntil(() => finish !== undefined);
  const before = f.calls.filter((value) => value === 'workspaces:first').length;
  f.emitWorkspaceUpdate();
  await Bun.sleep(1030);
  expect(f.calls.filter((value) => value === 'workspaces:first')).toHaveLength(before);
  finish!();
  await polling;
  await waitUntil(
    () => f.calls.filter((value) => value === 'workspaces:first').length > before,
    500,
  );
  await f.services.close();
  expect(f.calls.filter((value) => value === 'workspaces:first')).toHaveLength(before + 1);
  expect(f.calls.filter((value) => value === 'feed:release')).toHaveLength(1);
});

test('Automatic archive is paused without the negotiated directory-preserving capability', async () => {
  const f = nativeFixture({ LTCOOK_WORKSPACE_ORGANIZER_AUTO_ARCHIVE: 'true' });
  const before = (await f.services.read(f.workspace.id, signal))!;
  f.options.archiveWorkspacePreservingFiles = undefined;
  const withoutCapability = (await f.services.read(f.workspace.id, signal))!;
  expect(withoutCapability.archiveSafe).toBe(false);
  expect(await f.services.archive(before, signal)).toBe(false);
  await f.services.poll();
  expect(f.services.status().diagnostic).toContain('directory-preserving archive');
  expect(f.calls).not.toContain(`archive:${f.workspace.id}`);
  expect(f.calls).not.toContain(`unsafe-archive:${f.workspace.id}`);
  await f.services.close();
});

test('Dirty owned worktrees use only the preserving callback and retain files saved at the archive boundary', async () => {
  const gitState = gitFixture();
  const f = nativeFixture();
  Object.assign(f.workspace, gitState.workspace);
  const tracked = join(gitState.checkout, 'nested', 'tracked.txt');
  const untracked = join(gitState.checkout, 'new.txt');
  const ignored = join(gitState.checkout, '.cache', 'work.txt');
  const late = join(gitState.checkout, 'late-save.txt');
  writeFileSync(tracked, 'Uncommitted tracked work\n');
  writeFileSync(untracked, 'Untracked work\n');
  mkdirSync(join(gitState.checkout, '.cache'));
  writeFileSync(ignored, 'Ignored work\n');
  writeFileSync(
    join(gitState.checkout, 'paseo.json'),
    JSON.stringify({ worktree: { teardown: ['touch archive-side-effect'] } }),
  );
  const before = (await f.services.read(f.workspace.id, signal))!;
  expect(before.archiveSafe).toBe(true);
  f.options.archiveWorkspacePreservingFiles = async (id, receivedSignal) => {
    expect(receivedSignal).toBe(signal);
    f.calls.push(`archive:${id}`);
    writeFileSync(late, 'Saved after the final activity check\n');
    return true;
  };
  expect(await f.services.archive(before, signal)).toBe(true);
  expect(f.calls).toContain(`archive:${f.workspace.id}`);
  expect(f.calls).not.toContain(`unsafe-archive:${f.workspace.id}`);
  expect(readFileSync(tracked, 'utf8')).toBe('Uncommitted tracked work\n');
  expect(readFileSync(untracked, 'utf8')).toBe('Untracked work\n');
  expect(readFileSync(ignored, 'utf8')).toBe('Ignored work\n');
  expect(readFileSync(late, 'utf8')).toBe('Saved after the final activity check\n');
  expect(existsSync(join(gitState.checkout, 'archive-side-effect'))).toBe(false);
  await f.services.close();
});

test.each(['rejected', 'failed'])(
  'A %s preserving archive can retry without falling back to directory-removing archive',
  async (result) => {
    const f = nativeFixture();
    const before = (await f.services.read(f.workspace.id, signal))!;
    let calls = 0;
    f.options.archiveWorkspacePreservingFiles = async () => {
      calls++;
      if (calls === 1) {
        if (result === 'failed') throw new Error('Preserving archive is unavailable.');
        return false;
      }
      return true;
    };
    if (result === 'failed')
      await expect(f.services.archive(before, signal)).rejects.toThrow('Preserving archive');
    else expect(await f.services.archive(before, signal)).toBe(false);
    expect((await f.services.read(f.workspace.id, signal))?.archived).toBe(false);
    expect(await f.services.archive(before, signal)).toBe(true);
    expect(calls).toBe(2);
    expect(f.calls).not.toContain(`unsafe-archive:${f.workspace.id}`);
    await f.services.close();
  },
);

test('Native snapshot version ignores title, label, and UI activity changes while tracking human use', async () => {
  const f = nativeFixture();
  const before = (await f.services.read(f.workspace.id, signal))!;
  f.workspace.title = 'Renamed workspace';
  f.workspace.labels = ['Research'];
  f.agent.title = 'Renamed agent';
  f.agent.updatedAt = new Date().toISOString();
  const renamed = (await f.services.read(f.workspace.id, signal))!;
  expect(renamed.contentVersion).toBe(before.contentVersion);
  expect(renamed.activityAt).toBe(before.activityAt);
  await f.services.recordActivity(f.workspace.id);
  const touched = (await f.services.read(f.workspace.id, signal))!;
  expect(touched.contentVersion).toBe(before.contentVersion);
  expect(touched.activityAt).toBeGreaterThan(before.activityAt!);
  expect(JSON.stringify(f.services.status())).not.toContain(f.root);
  await f.services.close();
});

test('Native inventories visit all workspace and agent pages before applying organization', async () => {
  const f = nativeFixture();
  const second = { ...f.workspace, id: 'workspace-two', labels: ['Personal'] };
  f.workspacePages.push([second]);
  f.agentPages.push([{ ...f.agent, id: 'agent-two', workspaceId: second.id }]);
  await f.services.poll();
  expect(f.calls).toContain('workspaces:1');
  expect(f.calls).toContain('agents:1');
  expect(second.labels).toEqual(['Personal', 'Bugfix']);
  expect(f.workspace.labels).toEqual(['Personal', 'Bugfix']);
  await f.services.close();
});

test.each(['workspaces', 'agents'] as const)(
  'Native %s pagination rejects a repeated cursor before any workspace writes',
  async (resource) => {
    const f = nativeFixture();
    const actions = f.options.api[resource];
    const original = actions.list.bind(actions);
    let requested = 0;
    actions.list = (async (input: Parameters<typeof original>[0]) => {
      requested++;
      const page = await original(input);
      return { ...page, pageInfo: { ...page.pageInfo, nextCursor: '0' } };
    }) as typeof actions.list;
    await f.services.poll();
    expect(requested).toBe(2);
    expect(f.workspace.labels).toEqual(['Personal', 'Feature']);
    expect(f.services.status().diagnostic).toContain('inventory');
    expect(JSON.stringify(f.services.status())).not.toContain(f.root);
    await f.services.close();
  },
);

test('A nested working directory detects consecutive edits with the same Git status', async () => {
  const gitState = gitFixture();
  const f = nativeFixture();
  Object.assign(f.workspace, gitState.workspace, {
    workspaceDirectory: join(gitState.checkout, 'nested'),
  });
  const file = join(gitState.checkout, 'nested', 'tracked.txt');
  writeFileSync(file, 'First edit\n');
  utimesSync(file, 1_900_000_000, 1_900_000_000);
  const first = (await f.services.read(f.workspace.id, signal))!;
  writeFileSync(file, 'Other edit\n');
  utimesSync(file, 1_900_000_001, 1_900_000_001);
  const second = (await f.services.read(f.workspace.id, signal))!;
  expect(first.complete).toBe(true);
  expect(second.complete).toBe(true);
  expect(second.contentVersion).not.toBe(first.contentVersion);
  await f.services.close();
});

test.each([
  'running',
  'background',
  'input',
  'permission',
  'queued',
  'terminal',
  'provider',
  'provider-unavailable',
])('Native archive rechecks %s protection immediately before mutation', async (guard) => {
  const f = nativeFixture();
  const before = (await f.services.read(f.workspace.id, signal))!;
  expect(before.archiveSafe).toBe(true);
  if (guard === 'running') f.agent.status = 'running';
  if (guard === 'background') f.agent.backgroundWork = { count: 1 };
  if (guard === 'input') f.workspace.status = 'needs_input';
  if (guard === 'permission') f.agent.attentionReason = 'permission';
  if (guard === 'queued') f.setQueued(true);
  if (guard === 'terminal') f.setTerminals([{ id: 'terminal-one' }]);
  if (guard === 'provider') f.setProviderRunning(true);
  if (guard === 'provider-unavailable') f.agent.providerUnavailable = true;
  expect(await f.services.archive(before, signal)).toBe(false);
  expect(f.calls).not.toContain(`archive:${f.workspace.id}`);
  await f.services.close();
});

test('Native archive requires provider subagent inventory and retains the workspace on lookup failure', async () => {
  const f = nativeFixture();
  const before = (await f.services.read(f.workspace.id, signal))!;
  f.options.listProviderSubagents = undefined;
  expect(await f.services.archive(before, signal)).toBe(false);
  f.options.listProviderSubagents = async () => {
    throw new Error('Provider is unavailable.');
  };
  await expect(f.services.archive(before, signal)).rejects.toThrow('Provider is unavailable');
  expect(f.calls).not.toContain(`archive:${f.workspace.id}`);
  await f.services.close();
});

test('Unreadable conversation evidence prevents archive and exposes no workspace path in status', async () => {
  const f = nativeFixture();
  f.setHistoryAvailable(false);
  const snapshot = (await f.services.read(f.workspace.id, signal))!;
  expect(snapshot.complete).toBe(false);
  expect(snapshot.archiveSafe).toBe(false);
  expect(JSON.stringify(f.services.status())).not.toContain(f.root);
  await f.services.close();
});

import { expect, test } from 'bun:test';
import { memoryDispatchId } from '../../../runtime/src/integrations/paseo-memory.js';
import {
  agentTitleMetadata,
  createWorkspaceNaming,
  manualWorkspaceTitle,
  workspaceCreationMetadata,
  workspaceNamingMetadata,
  workspacePreference,
  withoutNamingMetadata,
} from '../../../paseo-patches/idle-restart/workspace-naming.mjs';
import type { WorkspaceNamingJob } from '../../../runtime/src/services/workspace-metadata.js';

const provenanceSecret = 'fixture-runtime-token';

function fixture(explicitTitle?: string) {
  let workspace = {
    title: explicitTitle ?? 'Default workspace',
    metadata: workspaceCreationMetadata({}, explicitTitle) ?? {},
    archivedAt: null,
  };
  const records = new Map<
    string,
    { workspaceId: string; title?: string; metadata?: object; lastUserMessageAt?: string }
  >();
  const updated: string[] = [];
  const dependencies = {
    registry: {
      async get() {
        return workspace;
      },
      async update(_id: string, change: (record: typeof workspace) => typeof workspace) {
        workspace = change(workspace);
        return workspace;
      },
    },
    agentStorage: {
      async listAll() {
        return [...records].map(([id, record]) => ({ id, ...record }));
      },
      async get(id: string) {
        return records.get(id);
      },
    },
    agentManager: {
      async runLifecycleMutation(_id: string, update: () => Promise<void>) {
        await update();
      },
      async updateAgentMetadataUnlocked(id: string, updates: { title: string; metadata?: object }) {
        const existing = records.get(id)!;
        records.set(id, {
          ...existing,
          title: updates.title,
          metadata: {
            ...existing.metadata,
            ...agentTitleMetadata(updates),
          },
        });
        updated.push(updates.title);
      },
    },
    async notify() {},
    logger: {
      warn(error: unknown) {
        throw error;
      },
    },
    environment: { LTCOOK_RUNTIME_USER_TOKEN: provenanceSecret },
  };
  const make = () => createWorkspaceNaming(dependencies);
  let naming = make();
  async function call<T>(body: object): Promise<T> {
    const reply = Promise.withResolvers<T>();
    await naming.handle({ body }, { json: reply.resolve }, reply.reject);
    return reply.promise;
  }
  return {
    get workspace() {
      return workspace;
    },
    records,
    updated,
    restart() {
      naming = make();
    },
    async prompt(
      id: string,
      text = 'Repair the login form',
      human = true,
      clientMessageId?: string,
      accepted = true,
    ) {
      if (!records.has(id)) records.set(id, { workspaceId: 'workspace-one' });
      naming.recordPrompt(
        { id, workspaceId: 'workspace-one', config: {}, metadata: records.get(id)?.metadata },
        [{ type: human ? 'user_message' : 'tool_call', text }],
        clientMessageId,
        accepted,
      );
      await naming.serialize('workspace-one', async () => {});
    },
    async setPreference(enabled: boolean) {
      await naming.serialize('workspace-one', () =>
        dependencies.registry.update('workspace-one', (record) => ({
          ...record,
          metadata: workspacePreference(record.metadata, enabled),
        })),
      );
    },
    async renameWorkspace(title: string) {
      await naming.serialize('workspace-one', () =>
        dependencies.registry.update('workspace-one', (record) =>
          manualWorkspaceTitle(record, title, 'today'),
        ),
      );
    },
    async renameTab(id: string, title: string) {
      await dependencies.agentManager.updateAgentMetadataUnlocked(id, { title });
    },
    async pending() {
      return (
        await call<{ jobs: WorkspaceNamingJob[] }>({
          operation: 'pending',
          workspaceId: 'workspace-one',
        })
      ).jobs;
    },
    async apply(job: WorkspaceNamingJob) {
      return (
        await call<{ applied: boolean }>({
          operation: 'apply',
          id: job.id,
          agentId: job.agentId,
          workspaceId: job.workspaceId,
          workspaceTitle: 'Suggested workspace',
          agentTitle: 'Suggested tab',
        })
      ).applied;
    },
  };
}

test('First accepted user prompts persist independently for workspaces and tabs', async () => {
  const f = fixture();
  await f.prompt('one', 'Automated reminder', false);
  await f.prompt('one', 'Team work order', true, memoryDispatchId(provenanceSecret, 'one'));
  expect(await f.pending()).toEqual([]);
  await f.prompt('one');
  await f.prompt('one', 'Later prompt');
  expect(JSON.stringify(workspaceNamingMetadata(f.workspace.metadata))).not.toContain('login form');
  expect(withoutNamingMetadata({ ...f.workspace.metadata, 'plugin.color': 'blue' })).toEqual({
    'plugin.color': 'blue',
  });
  f.restart();
  const [first] = await f.pending();
  expect(first).toMatchObject({
    agentId: 'one',
    nameWorkspace: true,
    nameTab: true,
    prompt: 'Repair the login form',
  });
  expect(await f.apply(first!)).toBe(true);
  expect(await f.apply(first!)).toBe(false);
  await f.prompt('two');
  expect(await f.pending()).toEqual([
    expect.objectContaining({ agentId: 'two', nameWorkspace: false, nameTab: true }),
  ]);
  expect(f.updated).toEqual(['Suggested tab']);
});

test.each(['rejected', 'runtime'] as const)(
  'A first accepted user prompt can still name a workspace and tab after %s traffic and restart',
  async (kind) => {
    const f = fixture();
    const id = 'one';
    const earlier = kind === 'runtime' ? memoryDispatchId(provenanceSecret, id) : undefined;
    await f.prompt(id, 'Earlier traffic', true, earlier, kind !== 'rejected');
    f.records.get(id)!.lastUserMessageAt = '2027-05-01T12:00:00.000Z';
    expect(await f.pending()).toEqual([]);
    expect(workspaceNamingMetadata(f.workspace.metadata)['ltcook.namingPending']).toBe(false);
    await f.setPreference(false);
    f.restart();
    await f.setPreference(true);
    await f.prompt(id);
    expect(await f.pending()).toEqual([
      expect.objectContaining({
        agentId: id,
        nameWorkspace: true,
        nameTab: true,
        prompt: 'Repair the login form',
      }),
    ]);
  },
);

test('History from before first-prompt naming preserves used titles while a new tab can name itself', async () => {
  const f = fixture();
  f.records.set('used', {
    workspaceId: 'workspace-one',
    title: 'Already named',
    lastUserMessageAt: '2027-05-01T12:00:00.000Z',
  });
  f.restart();
  await f.prompt('used', 'Later prompt');
  expect(await f.pending()).toEqual([]);
  expect(f.records.get('used')?.title).toBe('Already named');
  await f.prompt('new');
  expect(await f.pending()).toEqual([
    expect.objectContaining({ agentId: 'new', nameWorkspace: false, nameTab: true }),
  ]);
});

test('An explicit title at workspace creation protects the workspace and leaves tab naming active', async () => {
  const f = fixture('Chosen workspace title');
  await f.prompt('one');
  const [tab] = await f.pending();
  expect(tab).toMatchObject({ nameWorkspace: false, nameTab: true });
  expect(await f.apply(tab!)).toBe(true);
  expect(f.workspace.title).toBe('Chosen workspace title');
  expect(f.records.get('one')?.title).toBe('Suggested tab');
});

test('Manual workspace renames cancel pending writes even after re-enabling', async () => {
  const f = fixture();
  await f.prompt('one');
  const [inFlight] = await f.pending();
  await f.renameWorkspace('My workspace');
  expect(workspaceNamingMetadata(f.workspace.metadata)['ltcook.autoRename']).toBe(false);
  await f.prompt('two');
  await f.setPreference(true);
  expect(await f.apply(inFlight!)).toBe(false);
  await f.prompt('two');
  expect(await f.pending()).toEqual([]);
  await f.prompt('three');
  const [newTab] = await f.pending();
  expect(newTab).toMatchObject({ agentId: 'three', nameWorkspace: false, nameTab: true });
  expect(await f.apply(newTab!)).toBe(true);
  expect(f.workspace.title).toBe('My workspace');
});

test('A manual tab name wins over a pending title without disabling workspace naming', async () => {
  const f = fixture();
  await f.prompt('one');
  const [inFlight] = await f.pending();
  await f.renameTab('one', 'My tab');
  expect(await f.apply(inFlight!)).toBe(true);
  expect(f.records.get('one')?.title).toBe('My tab');
  expect(f.workspace.title).toBe('Suggested workspace');
});

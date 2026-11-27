import { expect, test } from 'bun:test';
import {
  agentTitleMetadata,
  createWorkspaceNaming,
  manualWorkspaceTitle,
  workspaceNamingMetadata,
  workspacePreference,
} from '../../../paseo-patches/idle-restart/workspace-naming.mjs';
import type { WorkspaceNamingJob } from '../../../runtime/src/services/workspace-metadata.js';

function fixture() {
  let workspace = { title: 'Default workspace', metadata: {}, archivedAt: null };
  const records = new Map<string, { workspaceId: string; title?: string; metadata?: object }>();
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
    environment: {},
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
    async prompt(id: string, text = 'Repair the login form', human = true) {
      if (!records.has(id)) records.set(id, { workspaceId: 'workspace-one' });
      naming.recordPrompt(
        { id, workspaceId: 'workspace-one', config: {}, metadata: records.get(id)?.metadata },
        [{ type: human ? 'user_message' : 'tool_call', text }],
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
  expect(await f.pending()).toEqual([]);
  await f.prompt('one');
  await f.prompt('one', 'Later prompt');
  expect(JSON.stringify(workspaceNamingMetadata(f.workspace.metadata))).not.toContain('login form');
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

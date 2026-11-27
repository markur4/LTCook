import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceInferenceError } from '../../../runtime/src/services/inference-recovery.js';
import {
  WORKSPACE_LABELS,
  boundedWorkspaceTitle,
  type WorkspaceMetadataGenerator,
  type WorkspaceMetadataHost,
  type WorkspaceMetadataSnapshot,
  type WorkspaceNamingJob,
  type WorkspaceNamingTitles,
} from '../../../runtime/src/services/workspace-metadata.js';
import {
  WORKSPACE_ARCHIVE_AFTER_MS,
  WORKSPACE_CLASSIFICATION_INTERVAL_MS,
  WorkspaceOrganizer,
} from '../../../runtime/src/services/workspace-organizer.js';
import {
  AGENT_TAB_TITLE_LIMIT,
  WORKSPACE_TITLE_LIMIT,
  Renamer,
} from '../../../runtime/src/services/renamer.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ltcook-workspace-services-'));
  roots.push(root);
  let now = 1_800_000_000_000;
  const snapshot: WorkspaceMetadataSnapshot = {
    id: 'workspace-one',
    title: 'Existing workspace',
    labels: ['My label', 'Feature'],
    createdAt: now - WORKSPACE_ARCHIVE_AFTER_MS * 3,
    activityAt: now - WORKSPACE_ARCHIVE_AFTER_MS * 2,
    contentVersion: 'content-1',
    context: 'Repair the login crash.',
    archived: false,
    pinned: false,
    busy: false,
    awaitingInput: false,
    archiveSafe: true,
    agents: [
      {
        id: 'agent-one',
        title: 'Existing agent',
        contentVersion: 'agent-content-1',
        context: 'Repair the login crash.',
        archived: false,
      },
    ],
  };
  const writes: string[] = [];
  const inferred: string[] = [];
  const failures: unknown[] = [];
  const host: WorkspaceMetadataHost = {
    async read() {
      return structuredClone(snapshot);
    },
    async ensureLabels(labels) {
      expect(labels).toEqual(WORKSPACE_LABELS);
      writes.push('catalog');
    },
    async setCategory(_expected, category) {
      writes.push(`label:${category}`);
      snapshot.labels = snapshot.labels.filter(
        (name) => !WORKSPACE_LABELS.some((value) => value.name === name),
      );
      snapshot.labels.push(category);
      return true;
    },
    async archive() {
      writes.push('archive');
      snapshot.archived = true;
      return true;
    },
  };
  const generator: WorkspaceMetadataGenerator = {
    async classify() {
      inferred.push('classify');
      return { category: 'Bugfix' };
    },
    async rename() {
      return { agents: [] };
    },
  };
  const options = {
    host,
    generator,
    now: () => now,
    onError: (error: unknown) => failures.push(error),
  };
  return {
    root,
    snapshot,
    host,
    generator,
    writes,
    inferred,
    failures,
    options,
    organizer: () =>
      new WorkspaceOrganizer({ ...options, stateFile: join(root, 'organizer.json') }),
    advance: (ms: number) => (now += ms),
    now: () => now,
    snapshots: () => [structuredClone(snapshot)],
    signal: new AbortController().signal,
  };
}

test('Organizer classifies intent initially and changed content after twelve hours across restart', async () => {
  const f = fixture();
  const organizer = f.organizer();
  await organizer.tick(f.snapshots(), f.signal);
  expect(f.snapshot.labels).toEqual(['My label', 'Bugfix']);
  expect(f.inferred).toEqual(['classify']);
  f.snapshot.title = 'A manual title';
  f.snapshot.labels.push('Another label');
  f.advance(WORKSPACE_CLASSIFICATION_INTERVAL_MS);
  await organizer.tick(f.snapshots(), f.signal);
  expect(f.inferred).toEqual(['classify']);
  f.snapshot.contentVersion = 'content-2';
  f.snapshot.activityAt = f.now();
  await organizer.tick(f.snapshots(), f.signal);
  expect(f.inferred).toEqual(['classify', 'classify']);
  f.snapshot.contentVersion = 'content-3';
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(f.inferred).toHaveLength(2);
  f.advance(WORKSPACE_CLASSIFICATION_INTERVAL_MS);
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(f.inferred).toHaveLength(3);
  expect(f.snapshot.labels).toContain('Another label');
});

test('Organizer seeds the catalog without inventing intent for an empty workspace', async () => {
  const f = fixture();
  f.snapshot.context = '';
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(f.writes).toEqual(['catalog']);
  expect(f.inferred).toHaveLength(0);
  f.snapshot.context = 'Investigate intermittent errors';
  f.snapshot.contentVersion = 'content-2';
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(f.inferred).toEqual(['classify']);
});

test('Organizer gives an old inventory fourteen days and maintenance changes do not extend it', async () => {
  const f = fixture();
  const organizer = f.organizer();
  await organizer.tick(f.snapshots(), f.signal);
  f.advance(WORKSPACE_ARCHIVE_AFTER_MS - 1);
  f.snapshot.title = 'Auto renamed';
  await organizer.tick(f.snapshots(), f.signal);
  expect(f.writes).not.toContain('archive');
  f.advance(1);
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(f.writes.filter((value) => value === 'archive')).toHaveLength(1);
  f.snapshot.archived = false;
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(f.writes.filter((value) => value === 'archive')).toHaveLength(1);
});

test('An externally archived workspace gets a fresh fourteen days when it reappears unchanged', async () => {
  const f = fixture();
  const organizer = f.organizer();
  await organizer.tick(f.snapshots(), f.signal);
  f.advance(WORKSPACE_ARCHIVE_AFTER_MS);
  await organizer.tick([], f.signal);
  f.advance(60_000);
  const restored = f.organizer();
  await restored.tick(f.snapshots(), f.signal);
  expect(f.writes).not.toContain('archive');
  f.advance(WORKSPACE_ARCHIVE_AFTER_MS - 1);
  await restored.tick(f.snapshots(), f.signal);
  expect(f.writes).not.toContain('archive');
  f.advance(1);
  await restored.tick(f.snapshots(), f.signal);
  expect(f.writes).toContain('archive');
});

test('Organizer observes the complete inventory without rewriting unchanged state on every poll', async () => {
  const f = fixture();
  const snapshots = Array.from({ length: 100 }, (_, index) => ({
    ...structuredClone(f.snapshot),
    id: `workspace-${index}`,
    context: '',
    agents: [],
  }));
  const organizer = f.organizer();
  await organizer.tick(snapshots, f.signal);
  const file = join(f.root, 'organizer.json');
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).workspaces)).toHaveLength(100);
  utimesSync(file, 1, 1);
  f.advance(60_000);
  await organizer.tick(snapshots, f.signal);
  expect(statSync(file).mtimeMs).toBe(1000);
  snapshots[20]!.activityAt = f.now();
  await organizer.tick(snapshots, f.signal);
  expect(statSync(file).mtimeMs).not.toBe(1000);
  expect(JSON.parse(readFileSync(file, 'utf8')).workspaces['workspace-20'].lastMeaningfulAt).toBe(
    f.now(),
  );
});

test.each(['pinned', 'busy', 'awaitingInput', 'incomplete', 'unsafe'])(
  'Organizer preserves a fourteen-day-old workspace when %s',
  async (guard) => {
    const f = fixture();
    const organizer = f.organizer();
    await organizer.tick(f.snapshots(), f.signal);
    f.advance(WORKSPACE_ARCHIVE_AFTER_MS);
    if (guard === 'pinned') f.snapshot.pinned = true;
    if (guard === 'busy') f.snapshot.busy = true;
    if (guard === 'awaitingInput') f.snapshot.awaitingInput = true;
    if (guard === 'incomplete') f.snapshot.complete = false;
    if (guard === 'unsafe') f.snapshot.archiveSafe = false;
    await organizer.tick(f.snapshots(), f.signal);
    expect(f.writes).not.toContain('archive');
  },
);

test('Organizer rechecks human activity before archive and honors adapter preservation rejection', async () => {
  const f = fixture();
  const organizer = f.organizer();
  await organizer.tick(f.snapshots(), f.signal);
  f.advance(WORKSPACE_ARCHIVE_AFTER_MS);
  const stale = f.snapshots();
  f.snapshot.activityAt = f.now();
  await organizer.tick(stale, f.signal);
  expect(f.writes).not.toContain('archive');
  f.advance(WORKSPACE_ARCHIVE_AFTER_MS);
  let checked = 0;
  f.host.archive = async () => {
    checked++;
    return false;
  };
  await organizer.tick(f.snapshots(), f.signal);
  expect(checked).toBe(1);
  expect(f.snapshot.archived).toBe(false);
});

test('Organizer treats content changes as activity when native timestamps lag and supports archive pause', async () => {
  const f = fixture();
  let autoArchive = true;
  const organizer = new WorkspaceOrganizer({
    ...f.options,
    stateFile: join(f.root, 'organizer.json'),
    autoArchive: () => autoArchive,
  });
  await organizer.tick(f.snapshots(), f.signal);
  f.advance(WORKSPACE_ARCHIVE_AFTER_MS);
  f.snapshot.contentVersion = 'new-content-with-old-native-time';
  await organizer.tick(f.snapshots(), f.signal);
  expect(f.writes).not.toContain('archive');
  f.advance(WORKSPACE_ARCHIVE_AFTER_MS);
  autoArchive = false;
  await organizer.tick(f.snapshots(), f.signal);
  expect(f.writes).not.toContain('archive');
  autoArchive = true;
  await organizer.tick(f.snapshots(), f.signal);
  expect(f.writes).toContain('archive');
});

test('Organizer rejects stale or invalid classification and persists its retry deadline', async () => {
  const f = fixture();
  let calls = 0;
  f.generator.classify = async () => {
    calls++;
    f.snapshot.contentVersion = 'content-2';
    return { category: 'Research' };
  };
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(f.writes).not.toContain('label:Research');
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(calls).toBe(1);
  f.advance(WORKSPACE_CLASSIFICATION_INTERVAL_MS);
  f.generator.classify = async () => ({ category: 'Delete files' });
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(f.failures).toHaveLength(1);
  expect(f.snapshot.labels).toEqual(['My label', 'Feature']);
});

test('First classification conflict gets one delayed idle retry without shifting the twelve-hour deadline', async () => {
  const f = fixture();
  const startedAt = f.now();
  let calls = 0;
  f.generator.classify = async () => {
    calls++;
    if (calls === 1) {
      f.snapshot.contentVersion = 'streamed-content';
      f.snapshot.busy = true;
    }
    return { category: 'Bugfix' };
  };
  await f.organizer().tick(f.snapshots(), f.signal);
  f.snapshot.busy = false;
  f.advance(59_999);
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(calls).toBe(1);
  f.advance(1);
  f.snapshot.busy = true;
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(calls).toBe(1);
  f.snapshot.busy = false;
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(calls).toBe(2);
  expect(f.snapshot.labels).toEqual(['My label', 'Bugfix']);
  f.snapshot.contentVersion = 'later-content';
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(calls).toBe(2);
  f.advance(startedAt + WORKSPACE_CLASSIFICATION_INTERVAL_MS - f.now());
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(calls).toBe(3);
});

test('A second initial content race exhausts the early retry even across restart', async () => {
  const f = fixture();
  const startedAt = f.now();
  let calls = 0;
  f.generator.classify = async () => {
    calls++;
    if (calls <= 2) f.snapshot.contentVersion = `streamed-${calls}`;
    return { category: 'Research' };
  };
  await f.organizer().tick(f.snapshots(), f.signal);
  f.advance(60_000);
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(calls).toBe(2);
  f.advance(60_000);
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(calls).toBe(2);
  f.advance(startedAt + WORKSPACE_CLASSIFICATION_INTERVAL_MS - f.now());
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(calls).toBe(3);
  expect(f.snapshot.labels).toEqual(['My label', 'Research']);
});

test('Initial inference failures keep the ordinary twelve-hour backoff', async () => {
  const f = fixture();
  let calls = 0;
  f.generator.classify = async () => {
    calls++;
    throw new Error('Provider authentication failed.');
  };
  await f.organizer().tick(f.snapshots(), f.signal);
  f.advance(60_000);
  f.snapshot.contentVersion = 'new-content';
  await f.organizer().tick(f.snapshots(), f.signal);
  expect(calls).toBe(1);
  expect(f.snapshot.labels).toEqual(['My label', 'Feature']);
});

function namingFixture() {
  const job: WorkspaceNamingJob = {
    workspaceId: 'workspace-one',
    agentId: 'agent-one',
    id: 'job-one',
    prompt: 'Repair the login crash.\nAdditional notes',
    nameWorkspace: true,
    nameTab: true,
    workspaceTitle: 'Existing workspace',
    agentTitle: 'Existing agent',
  };
  const jobs = [job];
  const writes: WorkspaceNamingTitles[] = [];
  const generator: WorkspaceMetadataGenerator = {
    async classify() {
      return { category: 'Bugfix' };
    },
    async rename({ agentId, nameWorkspace }) {
      return {
        ...(nameWorkspace ? { workspaceTitle: 'Fix login crash' } : {}),
        agents: [{ id: agentId, title: 'Login crash' }],
      };
    },
  };
  const renamer = new Renamer({
    enabled: true,
    generator,
    host: {
      async pending() {
        return [...jobs];
      },
      async apply(job, titles) {
        jobs.splice(jobs.indexOf(job), 1);
        writes.push(titles);
        return true;
      },
    },
  });
  return { job, jobs, writes, generator, renamer, signal: new AbortController().signal };
}

test('Renamer names the first prompt and names a later tab without a workspace cooldown', async () => {
  const f = namingFixture();
  await f.renamer.visit(f.job.workspaceId, f.signal);
  f.jobs.push({ ...f.job, id: 'job-two', agentId: 'agent-two', nameWorkspace: false });
  await f.renamer.visit(f.job.workspaceId, f.signal);
  expect(f.writes).toEqual([
    { workspaceTitle: 'Fix login crash', agentTitle: 'Login crash' },
    { agentTitle: 'Login crash' },
  ]);
});

test('Renamer limits displayed characters without splitting graphemes', async () => {
  const f = namingFixture();
  const emoji = '👨‍👩‍👧‍👦';
  f.generator.rename = async () => ({
    workspaceTitle: `${emoji.repeat(21)} trailing`,
    agents: [{ id: f.job.agentId, title: '  Investigate\nlogin crash  ' }],
  });
  await f.renamer.visit(f.job.workspaceId, f.signal);
  expect(f.writes).toEqual([
    { workspaceTitle: emoji.repeat(WORKSPACE_TITLE_LIMIT), agentTitle: 'Investigate log' },
  ]);
  expect(boundedWorkspaceTitle('e\u0301'.repeat(16), AGENT_TAB_TITLE_LIMIT)).toBe(
    'e\u0301'.repeat(15),
  );
});

test('Renamer falls back to the first prompt when a proposal names an unexpected tab', async () => {
  const f = namingFixture();
  f.generator.rename = async () => ({
    workspaceTitle: 'Unrelated title',
    agents: [{ id: 'someone-elses-agent', title: 'Overwrite' }],
  });
  await f.renamer.visit(f.job.workspaceId, f.signal);
  expect(f.writes).toEqual([
    { workspaceTitle: 'Repair the login cra', agentTitle: 'Repair the logi' },
  ]);
  expect(f.renamer.status().diagnostic).toContain('fallback');
});

test('Renamer coalesces repeated notifications and never writes after cancellation', async () => {
  const f = namingFixture();
  const abort = new AbortController();
  let calls = 0;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<unknown>();
  f.generator.rename = async () => {
    calls++;
    entered.resolve();
    return release.promise;
  };
  const first = f.renamer.visit(f.job.workspaceId, abort.signal);
  expect(f.renamer.visit(f.job.workspaceId, abort.signal)).toBe(first);
  await entered.promise;
  expect(calls).toBe(1);
  abort.abort();
  release.resolve({ workspaceTitle: 'Stopped', agents: [] });
  await first;
  expect(f.writes).toEqual([]);
});

test('Unsupported service state fails unchanged instead of resetting archive clocks silently', () => {
  const f = fixture();
  const file = join(f.root, 'organizer.json');
  const original = '{"version":999,"workspaces":{}}';
  writeFileSync(file, original);
  expect(() => f.organizer()).toThrow('Reset its state file');
  expect(readFileSync(file, 'utf8')).toBe(original);
});

test('Organizer preserves classification failure while archive and label sync succeed', async () => {
  const f = fixture();
  let available = false;
  f.generator.validate = async () => {
    if (!available)
      throw new ServiceInferenceError('configuration', 'Fix LTCOOK_MODEL_SMOL in AppRC.');
    return 'configured';
  };
  const organizer = f.organizer();
  await organizer.tick(f.snapshots(), f.signal);
  expect(f.inferred).toEqual([]);
  expect(organizer.status().diagnostics).toContainEqual({
    operation: 'classification',
    message: 'Fix LTCOOK_MODEL_SMOL in AppRC.',
    nextCheckAt: f.now() + 60_000,
  });
  f.advance(WORKSPACE_ARCHIVE_AFTER_MS);
  await organizer.tick(f.snapshots(), f.signal);
  expect(f.writes).toEqual(['catalog', 'catalog', 'archive']);
  expect(organizer.status().diagnostic).toContain('LTCOOK_MODEL_SMOL');

  available = true;
  const restarted = f.organizer();
  expect(restarted.status().diagnostic).toContain('LTCOOK_MODEL_SMOL');
  f.snapshot.archived = false;
  await restarted.tick(f.snapshots(), f.signal);
  expect(f.inferred).toEqual(['classify']);
  expect(restarted.status().diagnostic).toBeUndefined();
  expect(f.snapshot.labels).toContain('Bugfix');
});

test('Classification backs off across restart and unchanged labels do not count as a change', async () => {
  const f = fixture();
  let attempts = 0;
  f.generator.classify = async () => {
    if (++attempts <= 2) throw new ServiceInferenceError('transient', 'The provider is busy.');
    return { category: 'Feature' };
  };
  await f.organizer().tick(f.snapshots(), f.signal);
  const restarted = f.organizer();
  expect(restarted.status().diagnostic).toBe('The provider is busy.');
  f.advance(59_999);
  await restarted.tick(f.snapshots(), f.signal);
  expect(attempts).toBe(1);
  f.advance(1);
  await restarted.tick(f.snapshots(), f.signal);
  expect(attempts).toBe(2);
  f.advance(119_999);
  await restarted.tick(f.snapshots(), f.signal);
  expect(attempts).toBe(2);
  f.advance(1);
  await restarted.tick(f.snapshots(), f.signal);
  expect(attempts).toBe(3);
  expect(restarted.status()).toMatchObject({ processed: 0, lastSuccessAt: null });
  expect(restarted.status().diagnostic).toBeUndefined();
  expect(f.writes.filter((value) => value.startsWith('label:'))).toEqual([]);
});

test('Renamer falls back on provider failure and exposes the correction', async () => {
  const f = namingFixture();
  f.generator.rename = async () => {
    throw new ServiceInferenceError('authentication', 'Sign in again.');
  };
  await f.renamer.visit(f.job.workspaceId, f.signal);
  expect(f.writes).toHaveLength(1);
  expect(f.renamer.status().diagnostic).toBe('Sign in again.');
});

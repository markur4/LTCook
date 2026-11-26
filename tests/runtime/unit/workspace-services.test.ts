import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_LABELS,
  boundedWorkspaceTitle,
  type WorkspaceMetadataGenerator,
  type WorkspaceMetadataHost,
  type WorkspaceMetadataSnapshot,
} from '../../../runtime/src/services/workspace-metadata.js';
import {
  WORKSPACE_ARCHIVE_AFTER_MS,
  WORKSPACE_CLASSIFICATION_INTERVAL_MS,
  WorkspaceOrganizer,
} from '../../../runtime/src/services/workspace-organizer.js';
import {
  AGENT_TAB_TITLE_LIMIT,
  WORKSPACE_RENAME_INTERVAL_MS,
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
    async renameWorkspace(_expected, title) {
      writes.push(`workspace:${title}`);
      snapshot.title = title;
      return true;
    },
    async renameAgent(_expected, id, title) {
      writes.push(`agent:${id}:${title}`);
      snapshot.agents.find((agent) => agent.id === id)!.title = title;
      return true;
    },
  };
  const generator: WorkspaceMetadataGenerator = {
    async classify() {
      inferred.push('classify');
      return { category: 'Bugfix' };
    },
    async rename(_snapshot, selection) {
      inferred.push('rename');
      return {
        ...(selection.workspace ? { workspaceTitle: 'Fix login crash' } : {}),
        agents: selection.agentIds.map((id) => ({ id, title: 'Login crash' })),
      };
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
    renamer: (settings: { renameWorkspaces?: () => boolean; renameTabs?: () => boolean } = {}) =>
      new Renamer({ ...options, ...settings, stateFile: join(root, 'renamer.json') }),
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

test('Renamer enforces displayed-character limits and ignores unchanged content and metadata', async () => {
  const f = fixture();
  const emoji = '👨‍👩‍👧‍👦';
  f.generator.rename = async (_snapshot, selection) => {
    f.inferred.push('rename');
    return {
      ...(selection.workspace ? { workspaceTitle: `${emoji.repeat(21)} trailing` } : {}),
      agents: selection.agentIds.map((id) => ({ id, title: '  Investigate\nlogin crash  ' })),
    };
  };
  const renamer = f.renamer();
  await renamer.tick(f.snapshots(), f.signal);
  expect(f.snapshot.title).toBe(emoji.repeat(WORKSPACE_TITLE_LIMIT));
  expect(f.snapshot.agents[0]!.title).toBe('Investigate log');
  expect(boundedWorkspaceTitle('e\u0301'.repeat(16), AGENT_TAB_TITLE_LIMIT)).toBe(
    'e\u0301'.repeat(15),
  );
  f.snapshot.labels = ['Research'];
  f.advance(WORKSPACE_RENAME_INTERVAL_MS);
  await f.renamer().tick(f.snapshots(), f.signal);
  expect(f.inferred).toEqual(['rename']);
});

test('Renamer lets workspace names be paused independently and catches up only after its deadline', async () => {
  const f = fixture();
  let renameWorkspaces = false;
  const renamer = f.renamer({ renameWorkspaces: () => renameWorkspaces });
  await renamer.tick(f.snapshots(), f.signal);
  expect(f.snapshot.title).toBe('Existing workspace');
  expect(f.snapshot.agents[0]!.title).toBe('Login crash');
  renameWorkspaces = true;
  await renamer.tick(f.snapshots(), f.signal);
  expect(f.snapshot.title).toBe('Existing workspace');
  f.advance(WORKSPACE_RENAME_INTERVAL_MS);
  await renamer.tick(f.snapshots(), f.signal);
  expect(f.snapshot.title).toBe('Fix login crash');
  expect(f.writes.filter((value) => value.startsWith('agent:'))).toHaveLength(1);
});

test('Renamer rejects invented targets without changing any titles or immediately retrying', async () => {
  const f = fixture();
  let calls = 0;
  f.generator.rename = async () => {
    calls++;
    return {
      workspaceTitle: 'Untrusted result',
      agents: [{ id: 'someone-elses-agent', title: 'Overwrite' }],
    };
  };
  await f.renamer().tick(f.snapshots(), f.signal);
  expect(f.writes).toEqual([]);
  expect(f.snapshot.title).toBe('Existing workspace');
  expect(f.failures).toHaveLength(1);
  await f.renamer().tick(f.snapshots(), f.signal);
  expect(calls).toBe(1);
});

test('Renamer discards results after content changes and preserves a concurrent manual title', async () => {
  const f = fixture();
  f.generator.rename = async () => {
    f.snapshot.contentVersion = 'new-content';
    return { workspaceTitle: 'Old task', agents: [{ id: 'agent-one', title: 'Old task' }] };
  };
  await f.renamer().tick(f.snapshots(), f.signal);
  expect(f.writes).toEqual([]);
  f.advance(WORKSPACE_RENAME_INTERVAL_MS);
  f.generator.rename = async () => {
    f.snapshot.title = 'User name';
    f.snapshot.agents[0]!.title = 'User agent name';
    return { workspaceTitle: 'Auto name', agents: [{ id: 'agent-one', title: 'Auto name' }] };
  };
  await f.renamer().tick(f.snapshots(), f.signal);
  expect(f.writes).toEqual([]);
  expect(f.snapshot.title).toBe('User name');
});

test('Concurrent ticks share one attempt and cancellation prevents native writes', async () => {
  const f = fixture();
  const abort = new AbortController();
  let release!: (value: unknown) => void;
  let calls = 0;
  f.generator.rename = async () => {
    calls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const renamer = f.renamer();
  const first = renamer.tick(f.snapshots(), abort.signal);
  const second = renamer.tick(f.snapshots(), abort.signal);
  expect(first).toBe(second);
  expect(calls).toBe(1);
  abort.abort();
  release({ workspaceTitle: 'Stopped', agents: [{ id: 'agent-one', title: 'Stopped' }] });
  await expect(first).rejects.toThrow();
  expect(f.writes).toEqual([]);
  await f.renamer().tick(f.snapshots(), f.signal);
  expect(calls).toBe(1);
});

test('Unsupported service state fails unchanged instead of resetting archive clocks silently', () => {
  const f = fixture();
  const file = join(f.root, 'organizer.json');
  const original = '{"version":999,"workspaces":{}}';
  writeFileSync(file, original);
  expect(() => f.organizer()).toThrow('Reset its state file');
  expect(readFileSync(file, 'utf8')).toBe(original);
});

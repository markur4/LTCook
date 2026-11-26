import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { clearTimeout, setTimeout } from 'node:timers';
import type { PaseoAgent, PaseoApi, PaseoWorkspace } from '@getpaseo/client';
import type { createHostClient } from '@getpaseo/client/node';
import type { ProviderSubagentDescriptorPayload } from '@getpaseo/protocol/messages';
import { z } from 'zod';
import { readMemoryMessages } from '../paseo-plugin/server/memory-source.js';
import { isWithin } from '../path-containment.js';
import { WorkspaceOrganizer } from '../services/workspace-organizer.js';
import { Renamer } from '../services/renamer.js';
import { createWorkspaceMetadataGenerator } from '../services/workspace-metadata-inference.js';
import {
  WORKSPACE_LABELS,
  sameWorkspaceContent,
  type WorkspaceMetadataGenerator,
  type WorkspaceMetadataHost,
  type WorkspaceMetadataSnapshot,
} from '../services/workspace-metadata.js';

const exec = promisify(execFile);
const humanActivityKey = 'ltcook.workspaceLastHumanActivityAt';
const pollInterval = 60_000;
const categoryKey = (name: string) => name.trim().toLocaleLowerCase('en-US');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const at = (value: string | null | undefined) => (value ? Date.parse(value) || 0 : 0);

export type WorkspaceNativeMutations = Pick<
  ReturnType<typeof createHostClient>,
  'listWorkspaceLabels' | 'setWorkspaceLabel' | 'updateWorkspaceLabel' | 'updateAgent'
>;
type WorkspaceSubscription = NonNullable<
  Awaited<ReturnType<PaseoApi['workspaces']['list']>>['subscription']
>;

/** Only called before an absent daemon is launched. Never replaces an existing catalog. */
export async function seedWorkspaceLabels(home: string): Promise<void> {
  const directory = path.join(home, 'projects');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      path.join(directory, 'workspace-labels.json'),
      JSON.stringify(WORKSPACE_LABELS),
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
}

async function git(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  const result = await exec('git', ['--no-optional-locks', '-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 512 * 1024,
    windowsHide: true,
    signal,
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_COMMON_DIR: undefined,
    },
  });
  return result.stdout;
}

async function workingRevision(workspace: PaseoWorkspace, signal: AbortSignal): Promise<string> {
  const cwd = workspace.workspaceDirectory ?? workspace.projectRootPath;
  if (workspace.projectKind !== 'git') return '';
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'], signal)).trim();
  const [head, status] = await Promise.all([
    git(root, ['rev-parse', '--verify', 'HEAD'], signal).catch(() => ''),
    git(
      root,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
      signal,
    ),
  ]);
  const files = status.split('\0').filter(Boolean);
  if (files.length > 2000)
    throw new Error('Workspace file inventory is too large for automatic maintenance.');
  const versions: unknown[] = [];
  for (const record of files) {
    const relative = record.slice(3);
    if (!relative) continue;
    const file = path.resolve(root, relative);
    if (!isWithin(root, file, true)) continue;
    const stat = await lstat(file).catch(() => undefined);
    versions.push([relative, stat?.mtimeMs, stat?.ctimeMs, stat?.size]);
  }
  return hash([head, status, versions]);
}

export interface PaseoWorkspaceServicesOptions {
  api: PaseoApi;
  mutations: WorkspaceNativeMutations;
  stateDirectory: string;
  environment?: NodeJS.ProcessEnv;
  generator?: WorkspaceMetadataGenerator;
  archiveWorkspacePreservingFiles?: (workspaceId: string, signal?: AbortSignal) => Promise<boolean>;
  listProviderSubagents?: (agentId: string) => Promise<ProviderSubagentDescriptorPayload[]>;
  /** Runtime assignments may be queued while the native agent still reports idle. */
  isQueued?: (agents: PaseoAgent[]) => boolean;
  onError?: (service: string, error: unknown, workspaceId?: string) => void;
}

/** One host-local adapter and polling lifetime; the two Services keep independent policy/state. */
export class PaseoWorkspaceServices implements WorkspaceMetadataHost {
  readonly organizer: WorkspaceOrganizer;
  readonly renamer: Renamer;
  private readonly abort = new AbortController();
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt?: number;
  private nextPollAt?: number;
  private pending?: Promise<void>;
  private unsubscribe?: () => void;
  private workspaceSubscription?: WorkspaceSubscription;
  private closing?: Promise<void>;
  private readonly touches = new Map<string, number>();
  private readonly timelineCache = new Map<
    string,
    { stamp: string; version: string; context: string; activityAt: number }
  >();
  private archiveBlocked = new Map<string, string>();
  private diagnostic?: string;
  private readonly settings: {
    organizer: boolean;
    autoArchive: boolean;
    renamer: boolean;
    workspaces: boolean;
    tabs: boolean;
  };

  constructor(private readonly options: PaseoWorkspaceServicesOptions) {
    const env = options.environment ?? process.env;
    const enabled = (key: string) => z.enum(['true', 'false']).parse(env[key] ?? 'true') === 'true';
    this.settings = {
      organizer: enabled('LTCOOK_WORKSPACE_ORGANIZER_ENABLED'),
      autoArchive: enabled('LTCOOK_WORKSPACE_ORGANIZER_AUTO_ARCHIVE'),
      renamer: enabled('LTCOOK_RENAMER_ENABLED'),
      workspaces: enabled('LTCOOK_RENAMER_WORKSPACES'),
      tabs: enabled('LTCOOK_RENAMER_TABS'),
    };
    const common = {
      host: this,
      generator: options.generator ?? createWorkspaceMetadataGenerator(env),
    };
    this.organizer = new WorkspaceOrganizer({
      ...common,
      stateFile: path.join(options.stateDirectory, 'workspace-organizer.json'),
      enabled: () => this.settings.organizer,
      autoArchive: () => this.settings.autoArchive,
      onError: (error, id) => options.onError?.('Workspace Organizer', error, id),
    });
    this.renamer = new Renamer({
      ...common,
      stateFile: path.join(options.stateDirectory, 'renamer.json'),
      enabled: () => this.settings.renamer,
      renameWorkspaces: () => this.settings.workspaces,
      renameTabs: () => this.settings.tabs,
      onError: (error, id) => options.onError?.('Renamer', error, id),
    });
  }

  status() {
    return {
      organizer: this.organizer.status(),
      renamer: this.renamer.status(),
      autoArchive: this.settings.autoArchive,
      renameWorkspaces: this.settings.workspaces,
      renameTabs: this.settings.tabs,
      archiveBlocked: [...this.archiveBlocked].map(([workspaceId, reason]) => ({
        workspaceId,
        reason,
      })),
      ...(this.diagnostic ? { diagnostic: this.diagnostic } : {}),
    };
  }

  start(): void {
    if (this.started || this.abort.signal.aborted) return;
    this.started = true;
    this.unsubscribe = this.options.api.workspaces.subscribe(() => this.schedule(1000));
    this.schedule(0);
  }

  private schedule(delay = pollInterval): void {
    if (!this.started || this.abort.signal.aborted) return;
    const due = Date.now() + delay;
    if (this.pending) {
      this.nextPollAt = Math.min(this.nextPollAt ?? due, due);
      return;
    }
    // Keep the earliest deadline: events shorten a periodic wait without indefinitely debouncing.
    if (this.timer && this.timerAt! <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = due;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = undefined;
      void this.poll();
    }, delay);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = undefined;
    this.nextPollAt = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.closing = (async () => {
      // A subscription request already in flight must finish before its owned handle is released.
      await this.pending;
      const subscription = this.workspaceSubscription;
      this.workspaceSubscription = undefined;
      await subscription?.release();
    })();
    return this.closing;
  }

  async recordActivity(workspaceId: string): Promise<void> {
    this.abort.signal.throwIfAborted();
    const workspace = this.options.api.workspaces.ref(workspaceId);
    if (!(await workspace.refresh())) throw new Error('Workspace is unavailable.');
    const timestamp = Date.now();
    this.touches.set(workspaceId, timestamp);
    await workspace.setMetadata({ [humanActivityKey]: timestamp });
  }

  poll(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.abort.signal.aborted) return Promise.resolve();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = undefined;
    this.pending = this.pollOnce()
      .catch((error: unknown) => {
        if (this.abort.signal.aborted) return;
        this.diagnostic = 'Workspace Services could not read the native workspace inventory.';
        this.options.onError?.('Workspace Services', error);
      })
      .finally(() => {
        this.pending = undefined;
        const next = this.nextPollAt;
        this.nextPollAt = undefined;
        this.schedule(next === undefined ? pollInterval : Math.max(0, next - Date.now()));
      });
    return this.pending;
  }

  private async pollOnce(): Promise<void> {
    if (!this.settings.organizer && !this.settings.renamer) return;
    const signal = this.abort.signal;
    if (this.started && !this.workspaceSubscription) {
      const observed = await this.options.api.workspaces.list({
        filter: { includeBackground: true },
        page: { limit: 200 },
        subscribe: {},
      });
      if (!observed.subscription)
        throw new Error('The daemon did not establish a workspace subscription.');
      this.workspaceSubscription = observed.subscription;
    }
    signal.throwIfAborted();
    const [workspaces, agents] = await Promise.all([this.workspaces(signal), this.agents(signal)]);
    const snapshots: WorkspaceMetadataSnapshot[] = [];
    this.archiveBlocked.clear();
    for (const workspace of workspaces) {
      signal.throwIfAborted();
      if (workspace.internal) continue;
      snapshots.push(await this.snapshot(workspace, agents, signal));
    }
    this.diagnostic =
      this.settings.autoArchive && !this.options.archiveWorkspacePreservingFiles
        ? 'Automatic archive is paused: restart LTCook to enable directory-preserving archive.'
        : undefined;
    await this.organizer.tick(snapshots, signal);
    await this.renamer.tick(snapshots, signal);
    const ids = new Set(agents.map(({ id }) => id));
    for (const id of this.timelineCache.keys()) if (!ids.has(id)) this.timelineCache.delete(id);
  }

  private async workspaces(signal: AbortSignal): Promise<PaseoWorkspace[]> {
    const result: PaseoWorkspace[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await this.options.api.workspaces.list({
        filter: { includeBackground: true },
        page: { limit: 200, cursor },
      });
      result.push(...page.entries);
      cursor = page.pageInfo.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error('Workspace inventory repeated its cursor.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return result;
  }

  private async agents(signal: AbortSignal): Promise<PaseoAgent[]> {
    const result: PaseoAgent[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await this.options.api.agents.list({
        filter: { includeArchived: false, includeInternal: true, includeBackground: true },
        page: { limit: 200, cursor },
        signal,
      });
      result.push(...page.entries.map(({ agent }) => agent));
      cursor = page.pageInfo.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error('Agent inventory repeated its cursor.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return result;
  }

  async read(id: string, signal: AbortSignal): Promise<WorkspaceMetadataSnapshot | undefined> {
    const [workspace, agents] = await Promise.all([
      this.options.api.workspaces.ref(id).refresh(),
      this.agents(signal),
    ]);
    signal.throwIfAborted();
    return workspace && !workspace.internal ? this.snapshot(workspace, agents, signal) : undefined;
  }

  private async snapshot(
    workspace: PaseoWorkspace,
    all: PaseoAgent[],
    signal: AbortSignal,
  ): Promise<WorkspaceMetadataSnapshot> {
    const agents = all
      .filter((agent) => agent.workspaceId === workspace.id && !agent.archivedAt)
      .sort((a, b) => a.id.localeCompare(b.id));
    let complete = agents.every((agent) => !agent.providerUnavailable);
    const humanAt = workspace.metadata?.[humanActivityKey];
    let activityAt = Math.max(
      this.touches.get(workspace.id) ?? 0,
      typeof humanAt === 'number' && Number.isFinite(humanAt) ? humanAt : 0,
      at(workspace.lastUserMessageAt),
    );
    const metadata: WorkspaceMetadataSnapshot['agents'] = [];
    for (const agent of agents) {
      signal.throwIfAborted();
      try {
        const stamp = hash([
          agent.updatedAt,
          agent.lastUserMessageAt,
          agent.status,
          agent.activeTurn,
          agent.attentionTimestamp,
        ]);
        let cached = this.timelineCache.get(agent.id);
        if (!cached || cached.stamp !== stamp) {
          const page = await this.options.api.agents.ref(agent.id).timeline.refetch({
            direction: 'tail',
            projection: 'canonical',
            limit: 48,
          });
          if (page.error || !page.agent || page.reset || page.staleCursor || page.gap)
            throw new Error('Conversation history is incomplete.');
          const messages = readMemoryMessages(page.entries, () => 'user', true);
          cached = {
            stamp,
            version: hash([page.epoch, messages]),
            context: messages
              .filter(({ author }) => author !== 'runtime')
              .map(({ author, text }) => `${author}: ${text.slice(0, 4000)}`)
              .join('\n')
              .slice(-12_000),
            activityAt: Math.max(
              at(agent.lastUserMessageAt),
              ...messages.map(({ timestamp }) => at(timestamp)),
            ),
          };
          this.timelineCache.set(agent.id, cached);
        }
        activityAt = Math.max(activityAt, cached.activityAt);
        if (!agent.internal)
          metadata.push({
            id: agent.id,
            title: agent.title ?? '',
            contentVersion: cached.version,
            context: cached.context,
            archived: false,
          });
      } catch {
        signal.throwIfAborted();
        complete = false;
      }
    }
    let files = '';
    try {
      files = await workingRevision(workspace, signal);
    } catch {
      signal.throwIfAborted();
      complete = false;
    }
    const busy =
      workspace.status === 'running' ||
      workspace.setupStatus === 'running' ||
      workspace.scripts.some(({ lifecycle }) => lifecycle === 'running') ||
      agents.some(
        (agent) =>
          ['initializing', 'running'].includes(agent.status) ||
          Boolean(agent.activeTurn) ||
          (agent.backgroundWork?.count ?? 0) > 0,
      ) ||
      (this.options.isQueued?.(agents) ?? false);
    const awaitingInput =
      workspace.status === 'needs_input' ||
      workspace.setupStatus === 'blocked' ||
      agents.some(
        (agent) => agent.pendingPermissions.length > 0 || agent.attentionReason === 'permission',
      );
    // History exposes archived conversations; keep empty workspaces until native recovery can find them.
    let archiveSafe =
      Boolean(this.options.archiveWorkspacePreservingFiles) &&
      complete &&
      agents.length > 0 &&
      !busy &&
      !awaitingInput;
    if (archiveSafe) {
      const terminals = await this.options.api.workspaces
        .ref(workspace.id)
        .terminals.list()
        .catch(() => undefined);
      archiveSafe = terminals !== undefined && terminals.entries.length === 0;
    }
    if (!archiveSafe && !busy && !awaitingInput)
      this.archiveBlocked.set(
        workspace.id,
        'Preserved while archive capability, history, or open terminals need attention.',
      );
    return {
      id: workspace.id,
      title: workspace.title ?? workspace.name,
      labels: workspace.labels ?? [],
      createdAt: at(workspace.createdAt),
      activityAt,
      contentVersion: hash([files, metadata.map(({ id, contentVersion }) => [id, contentVersion])]),
      context: metadata
        .map(({ context }) => context)
        .join('\n')
        .slice(-16_000),
      archived: Boolean(workspace.archivingAt),
      pinned: Boolean(workspace.pinnedAt),
      busy,
      awaitingInput,
      complete,
      archiveSafe,
      agents: metadata,
    };
  }

  async ensureLabels(labels: typeof WORKSPACE_LABELS, signal: AbortSignal): Promise<void> {
    const catalog = await this.options.mutations.listWorkspaceLabels();
    let seedWorkspace: PaseoWorkspace | undefined;
    for (const label of labels) {
      signal.throwIfAborted();
      const existing = catalog.labels.find(
        ({ name }) => categoryKey(name) === categoryKey(label.name),
      );
      if (existing) {
        if (existing.name !== label.name || existing.color !== label.color) {
          await this.options.mutations.updateWorkspaceLabel({
            name: existing.name,
            newName: label.name,
            color: label.color,
          });
        }
        continue;
      }
      seedWorkspace ??= (await this.workspaces(signal)).find(
        ({ internal, archivingAt }) => !internal && !archivingAt,
      );
      if (!seedWorkspace)
        throw new Error('Default workspace labels are waiting for a usable workspace.');
      const alreadyAssigned = (seedWorkspace.labels ?? []).some(
        (name) => categoryKey(name) === categoryKey(label.name),
      );
      // Native creation requires one assignment; removal keeps the reusable catalog definition.
      await this.options.mutations.setWorkspaceLabel({
        workspaceId: seedWorkspace.id,
        label,
        assigned: true,
      });
      if (!alreadyAssigned) {
        await this.options.mutations.setWorkspaceLabel({
          workspaceId: seedWorkspace.id,
          label,
          assigned: false,
        });
      }
    }
  }

  async setCategory(
    expected: WorkspaceMetadataSnapshot,
    category: (typeof WORKSPACE_LABELS)[number]['name'],
    signal: AbortSignal,
  ): Promise<boolean> {
    const current = await this.read(expected.id, signal);
    if (!sameWorkspaceContent(expected, current)) return false;
    const label = WORKSPACE_LABELS.find(({ name }) => name === category)!;
    for (const old of current.labels) {
      if (
        categoryKey(old) === categoryKey(category) ||
        !WORKSPACE_LABELS.some(({ name }) => categoryKey(name) === categoryKey(old))
      )
        continue;
      signal.throwIfAborted();
      await this.options.mutations.setWorkspaceLabel({
        workspaceId: current.id,
        label: { name: old, color: label.color },
        assigned: false,
      });
    }
    signal.throwIfAborted();
    await this.options.mutations.setWorkspaceLabel({
      workspaceId: current.id,
      label,
      assigned: true,
    });
    return true;
  }

  async archive(expected: WorkspaceMetadataSnapshot, signal: AbortSignal): Promise<boolean> {
    if (!this.options.listProviderSubagents || !this.options.archiveWorkspacePreservingFiles)
      return false;
    for (const agent of expected.agents) {
      const subagents = await this.options.listProviderSubagents(agent.id);
      signal.throwIfAborted();
      if (subagents.some(({ status }) => status === 'running')) return false;
    }
    const current = await this.read(expected.id, signal);
    if (
      !sameWorkspaceContent(expected, current) ||
      !current.archiveSafe ||
      current.pinned ||
      current.busy ||
      current.awaitingInput ||
      (current.activityAt ?? 0) > (expected.activityAt ?? 0) ||
      (this.touches.get(expected.id) ?? 0) > (expected.activityAt ?? 0)
    )
      return false;
    signal.throwIfAborted();
    return this.options.archiveWorkspacePreservingFiles(expected.id, signal);
  }

  async renameWorkspace(
    expected: WorkspaceMetadataSnapshot,
    title: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const current = await this.read(expected.id, signal);
    if (!sameWorkspaceContent(expected, current) || current.title !== expected.title) return false;
    signal.throwIfAborted();
    await this.options.api.workspaces.ref(expected.id).setTitle(title);
    return true;
  }

  async renameAgent(
    expected: WorkspaceMetadataSnapshot,
    id: string,
    title: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const current = await this.read(expected.id, signal);
    if (!sameWorkspaceContent(expected, current)) return false;
    const before = expected.agents.find((agent) => agent.id === id);
    const after = current.agents.find((agent) => agent.id === id);
    if (
      !before ||
      !after ||
      before.contentVersion !== after.contentVersion ||
      before.title !== after.title
    )
      return false;
    signal.throwIfAborted();
    await this.options.mutations.updateAgent(id, { name: title });
    return true;
  }
}

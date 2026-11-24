import path from 'node:path';
import type { PaseoAgent, PaseoAgentHandle, PaseoApi } from '@getpaseo/client';
import type { ActivitySnapshot, AgentActivity, SkillLoad, ToolCall } from '../shared/activity';

type Timeline = Awaited<ReturnType<PaseoAgentHandle['timeline']['refetch']>>;
type TimelineItem = Timeline['entries'][number]['item'];
type AgentEvents = Pick<AgentActivity, 'tools' | 'skills'> & {
  epoch?: string;
  generation: number;
  toolsPartial: boolean;
};
type Services = Pick<ActivitySnapshot, 'rag' | 'memory'> & {
  providerSubagents: AgentActivity[];
  task?: string;
};
type RegisteredSkill = { name: string; path: string };

export function observedTimestamp(value: string): number {
  return time(value);
}

const recentLimit = 32;
const timelinePageSize = 160;
const activeTurnPageLimit = 8;
const parentLabel = 'paseo.parent-agent-id';
let revision = 0;

function time(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function status(agent: PaseoAgent): AgentActivity['status'] {
  if (agent.providerUnavailable) return 'unknown';
  if (agent.pendingPermissions.length) return 'waiting';
  if (agent.attentionReason === 'finished' || agent.status === 'closed') return 'finished';
  if (agent.status === 'error') return 'failed';
  return agent.status === 'initializing' ? 'waiting' : agent.status;
}

function codexSkillRead(command: string, output?: string): string | undefined {
  // > Codex reports file reads as shell calls. Require a direct read and the returned front matter.
  const reader =
    /^(?:cat|head(?:[ \t]+(?:-n[ \t]*|-)\d+)?|sed[ \t]+-n[ \t]+(['"]?)\d+(?:,\d+)?p\1)[ \t]+(?:--[ \t]+)?(.+)$/;
  const operand = reader.exec(command.trim())?.[2];
  if (!operand || !output) return undefined;
  const token = /^(?:"([^"]+)"|'([^']+)'|([^\s<>&|;$*?]+))$/.exec(operand);
  const file = token?.[1] ?? token?.[2] ?? token?.[3];
  if (!file || path.basename(file) !== 'SKILL.md') return undefined;
  const header = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    output.slice(0, 4096),
  )?.[1];
  return header ? /^name:[ \t]*(['"]?)([\w.-]+)\1[ \t]*(?:#.*)?$/m.exec(header)?.[2] : undefined;
}

export function nativeActivity(agent: PaseoAgent, events?: AgentEvents): AgentActivity {
  const updatedAt = time(agent.updatedAt);
  const usedTokens = agent.lastUsage?.contextWindowUsedTokens;
  const budgetTokens = agent.lastUsage?.contextWindowMaxTokens;
  const context =
    typeof usedTokens === 'number' &&
    Number.isSafeInteger(usedTokens) &&
    usedTokens >= 0 &&
    typeof budgetTokens === 'number' &&
    Number.isSafeInteger(budgetTokens) &&
    budgetTokens > 0
      ? { usedTokens, budgetTokens, observedAt: updatedAt }
      : null;
  return {
    id: agent.id,
    name: agent.title || agent.labels['ltcook.member'] || agent.provider,
    worktree: agent.cwd
      ? {
          id: agent.workspaceId ?? agent.cwd,
          name: path.basename(agent.cwd) || agent.cwd,
          path: agent.cwd,
        }
      : null,
    status: status(agent),
    updatedAt,
    context,
    tools: events?.tools ?? null,
    skills: events?.skills ?? null,
    canOpenConversation: true,
  };
}

class AgentTimeline {
  private epoch?: string;
  private timelineGeneration = 0;
  private loaded = false;
  private toolsPartial = false;
  private readonly calls = new Map<string, { seq: number; call: ToolCall }>();
  private readonly loadedSkills = new Map<string, SkillLoad>();
  private readonly skills = new Map<string, string>();
  private readonly skillFiles = new Map<string, string>();
  private skillFilesKnown = false;
  private skillsKnown = false;
  private pending?: Promise<void>;
  private refetchRequired = true;
  private readonly stop: ReturnType<PaseoAgentHandle['timeline']['subscribe']>;
  subscriptionFailed = false;

  constructor(
    private readonly agent: PaseoAgentHandle,
    private readonly signal: AbortSignal,
    private readonly provider: PaseoAgent['provider'],
  ) {
    this.stop = agent.timeline.subscribe((update) => {
      const { event } = update;
      switch (event.type) {
        case 'timeline':
          if ('seq' in update && typeof update.seq === 'number') {
            if (update.epoch) {
              if (this.epoch && update.epoch !== this.epoch) this.reset(update.epoch);
              this.epoch = update.epoch;
            }
            this.accept(event.item, update.seq, time(update.timestamp));
            this.prune();
          }
          break;
        case 'replacement':
          this.reset(event.epoch);
          break;
        case 'subscription_restored':
          this.reset(undefined);
          break;
        case 'error':
          this.subscriptionFailed = true;
          this.reset(this.epoch);
          break;
        case 'turn_completed':
        case 'turn_canceled':
        case 'turn_failed':
          this.refetchRequired = true;
          break;
      }
    });
    void this.stop.ready.catch(() => {});
  }

  close(): void {
    this.stop();
  }

  get generation(): number {
    return this.timelineGeneration;
  }

  read(activeTurn: PaseoAgent['activeTurn']): Promise<AgentEvents> {
    if (this.refetchRequired && !this.signal.aborted) {
      this.pending ??= this.refetch(activeTurn).finally(() => {
        this.pending = undefined;
      });
    }
    return (this.pending ?? Promise.resolve()).then(() => ({
      tools: this.loaded ? [...this.calls.values()].map(({ call }) => call) : null,
      skills: this.skillsKnown || this.skillFilesKnown ? [...this.loadedSkills.values()] : null,
      epoch: this.epoch,
      generation: this.timelineGeneration,
      toolsPartial: this.toolsPartial,
    }));
  }

  private reset(epoch: string | undefined): void {
    if (this.epoch && this.epoch !== epoch) {
      this.skills.clear();
      this.skillFiles.clear();
      this.skillsKnown = false;
      this.skillFilesKnown = false;
    }
    this.epoch = epoch;
    this.timelineGeneration++;
    this.calls.clear();
    this.loadedSkills.clear();
    this.loaded = false;
    this.toolsPartial = false;
    this.refetchRequired = true;
  }

  private async refetch(activeTurn: PaseoAgent['activeTurn']): Promise<void> {
    this.refetchRequired = false;
    try {
      await this.stop.ready.catch(() => {});
      if (this.signal.aborted || this.subscriptionFailed) return;
      const generation = this.timelineGeneration;
      const tail = await this.agent.timeline.refetch({
        direction: 'tail',
        projection: 'canonical',
        limit: timelinePageSize,
      });
      if (this.signal.aborted || generation !== this.timelineGeneration) return;
      if (tail.error) throw new Error('Timeline unavailable.');
      const turn = tail.agent ? tail.agent.activeTurn : activeTurn;
      const startedAt = turn?.startedAt ? time(turn.startedAt) : 0;
      const olderTools: Timeline['entries'][] = [];
      let page = tail;
      let toolsPartial = tail.gap;
      while (turn && page.hasOlder) {
        const earliest = page.entries[0];
        if (
          earliest &&
          startedAt &&
          earliest.turnId !== turn.turnId &&
          time(earliest.timestamp) < startedAt
        ) {
          break;
        }
        const cursor = page.startCursor;
        if (!cursor || olderTools.length >= activeTurnPageLimit) {
          toolsPartial = true;
          break;
        }
        const older = await this.agent.timeline
          .refetch({
            direction: 'before',
            cursor,
            projection: 'canonical',
            limit: timelinePageSize,
          })
          .catch(() => undefined);
        if (this.signal.aborted || generation !== this.timelineGeneration) return;
        if (
          !older ||
          older.error ||
          older.epoch !== tail.epoch ||
          older.reset ||
          older.staleCursor ||
          older.gap ||
          (older.startCursor && older.startCursor.seq >= cursor.seq)
        ) {
          toolsPartial = true;
          break;
        }
        // > Keep tool lifecycle events from the active-turn lookback, without copying its transcript.
        olderTools.push(older.entries.filter(({ item }) => item.type === 'tool_call'));
        page = older;
      }
      if (this.epoch && this.epoch !== tail.epoch) this.reset(tail.epoch);
      this.epoch = tail.epoch;
      for (const entries of [...olderTools.reverse(), tail.entries]) {
        for (const entry of entries) this.accept(entry.item, entry.seqEnd, time(entry.timestamp));
      }
      this.loaded = true;
      this.toolsPartial = toolsPartial;
      this.prune();
    } catch {
      this.refetchRequired = true;
    }
  }

  async registerSkills(
    agent: PaseoAgent,
    files: () => Promise<RegisteredSkill[] | undefined>,
  ): Promise<void> {
    if (this.signal.aborted) return;
    const generation = this.timelineGeneration;
    if (this.provider !== 'codex' && !this.skillFilesKnown) {
      const resolved = await files().catch(() => undefined);
      if (this.signal.aborted || generation !== this.timelineGeneration) return;
      if (resolved) {
        for (const skill of resolved) this.skillFiles.set(path.normalize(skill.path), skill.name);
        this.skillFilesKnown = true;
        this.refetchRequired = true;
      }
    }
    if (
      this.skillsKnown ||
      agent.providerUnavailable ||
      (this.provider === 'codex' ? agent.status === 'initializing' : !agent.activeTurn)
    )
      return;
    try {
      const commands = await this.agent.commands();
      if (commands.error || this.signal.aborted || generation !== this.timelineGeneration) return;
      for (const command of commands.commands) {
        if (command.kind === 'skill')
          this.skills.set(command.name.replace(/^\/?skill:/, ''), command.description);
      }
      this.skillsKnown = true;
      this.refetchRequired = true;
    } catch {
      // > The provider may only report commands once its session is open.
    }
  }

  private accept(item: TimelineItem, seq: number, timestamp: number): void {
    if (item.type === 'user_message') {
      const skill = /^<skill name="([^"]+)" location="([^"]+)">\n/.exec(item.text);
      if (skill) {
        const [, name, location] = skill;
        if (
          name &&
          location &&
          (this.skillFiles.get(path.normalize(location)) === name || this.skills.has(name))
        )
          this.loadSkill(name, timestamp);
      }
      return;
    }
    if (item.type !== 'tool_call') return;
    if (item.status === 'completed' && item.detail.type === 'read') {
      const cwd = this.agent.cwd;
      const candidate = item.detail.filePath;
      const location = path.isAbsolute(candidate)
        ? path.normalize(candidate)
        : cwd
          ? path.resolve(cwd, candidate)
          : undefined;
      const name = location && this.skillFiles.get(location);
      if (name) this.loadSkill(name, timestamp);
    }
    if (
      this.provider === 'codex' &&
      item.status === 'completed' &&
      item.detail.type === 'shell' &&
      (item.detail.exitCode == null || item.detail.exitCode === 0)
    ) {
      const name = codexSkillRead(item.detail.command, item.detail.output);
      if (name && this.skills.has(name)) this.loadSkill(name, timestamp);
    }
    const prior = this.calls.get(item.callId);
    if (prior && prior.seq >= seq) {
      if (seq < prior.seq && item.status === 'running' && timestamp < prior.call.startedAt) {
        prior.call.startedAt = timestamp;
        if (prior.call.finishedAt !== undefined)
          prior.call.durationMs = Math.max(0, prior.call.finishedAt - timestamp);
      }
      return;
    }
    const startedAt = prior?.call.startedAt ?? timestamp;
    const state =
      item.status === 'completed'
        ? 'success'
        : item.status === 'canceled'
          ? 'cancelled'
          : item.status;
    const durationMs =
      prior?.call.status === 'running'
        ? Math.max(0, timestamp - startedAt)
        : prior?.call.durationMs;
    this.calls.set(item.callId, {
      seq,
      call: {
        id: item.callId,
        name: item.name,
        startedAt,
        status: state,
        ...(state !== 'running'
          ? {
              finishedAt: timestamp,
              ...(durationMs === undefined ? {} : { durationMs }),
            }
          : {}),
      },
    });
  }

  private loadSkill(name: string, timestamp: number): void {
    if ((this.loadedSkills.get(name)?.loadedAt ?? -1) > timestamp) return;
    const description = this.skills.get(name);
    this.loadedSkills.set(name, {
      id: name,
      name,
      loadedAt: timestamp,
      ...(description ? { description } : {}),
    });
  }

  private prune(): void {
    const finished = [...this.calls.entries()].filter(([, { call }]) => call.status !== 'running');
    finished.sort((left, right) => right[1].seq - left[1].seq);
    for (const [id] of finished.slice(recentLimit)) this.calls.delete(id);
  }
}

export async function observeActivity(
  paseo: PaseoApi,
  agentId: string,
  signal: AbortSignal,
  push: (value: ActivitySnapshot) => Promise<void>,
  services: (agent: PaseoAgent, signal: AbortSignal, epoch?: string) => Promise<Services>,
  registeredSkills: (
    agent: PaseoAgent,
    signal: AbortSignal,
  ) => Promise<RegisteredSkill[] | undefined>,
): Promise<void> {
  const observations = new Map<string, AgentTimeline>();
  const close = () => {
    for (const observation of observations.values()) observation.close();
    observations.clear();
  };
  signal.addEventListener('abort', close, { once: true });
  const selected = paseo.agents.ref(agentId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async (): Promise<void> => {
    if (signal.aborted) return;
    const entry = await selected.refresh();
    if (!entry || entry.agent.archivedAt)
      throw new Error('The Activity conversation is unavailable.');
    if (signal.aborted) return;
    const list = await paseo.agents.list({
      filter: { labels: { [parentLabel]: agentId } },
      signal,
    });
    const direct = list.entries
      .map(({ agent }) => agent)
      .filter((agent) => agent.labels[parentLabel] === agentId && !agent.archivedAt);
    const visible = [entry.agent, ...direct];
    for (const [id, observation] of observations) {
      if (visible.some((agent) => agent.id === id)) continue;
      observation.close();
      observations.delete(id);
    }
    if (signal.aborted) return;
    const snapshots = visible.map(async (agent) => {
      let observation = observations.get(agent.id);
      if (!observation || observation.subscriptionFailed) {
        observation?.close();
        observation = new AgentTimeline(paseo.agents.ref(agent), signal, agent.provider);
        observations.set(agent.id, observation);
      }
      if (['pi', 'ltcook', 'codex'].includes(agent.provider))
        await observation.registerSkills(agent, () => registeredSkills(agent, signal));
      const events = await observation.read(agent.activeTurn);
      return { activity: nativeActivity(agent, events), events };
    });
    const [selectedSnapshot, ...children] = snapshots;
    const [items, state] = await Promise.all([
      Promise.all(children),
      selectedSnapshot!.then(({ events }) =>
        signal.aborted ? undefined : services(entry.agent, signal, events.epoch),
      ),
    ]);
    const selectedActivity = await selectedSnapshot!;
    if (
      signal.aborted ||
      !state ||
      observations.get(agentId)?.generation !== selectedActivity.events.generation
    ) {
      return;
    }
    const { providerSubagents, task, ...servicesState } = state;
    await push({
      selectedAgentId: agentId,
      revision: ++revision,
      capturedAt: Date.now(),
      agent: { ...selectedActivity.activity, ...(task ? { task } : {}) },
      subagents: [
        ...items.map(({ activity }) => activity),
        ...providerSubagents.filter((child) => !visible.some((agent) => agent.id === child.id)),
      ],
      ...servicesState,
      activityScopeLabel: [selectedActivity, ...items].some(({ events }) => events.toolsPartial)
        ? 'Recent conversation activity · Some running tools may be missing'
        : 'Recent conversation activity',
    });
  };

  try {
    while (!signal.aborted) {
      await refresh();
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        };
        signal.addEventListener('abort', done, { once: true });
        timer = setTimeout(done, 1500);
      });
    }
  } finally {
    signal.removeEventListener('abort', close);
    close();
  }
}

import path from 'node:path';
import type { PaseoAgent, PaseoAgentHandle, PaseoApi } from '@getpaseo/client';
import type { ActivitySnapshot, AgentActivity, SkillLoad, ToolCall } from '../shared/activity';

type Timeline = Awaited<ReturnType<PaseoAgentHandle['timeline']['refetch']>>;
type TimelineItem = Timeline['entries'][number]['item'];
type AgentEvents = Pick<AgentActivity, 'tools' | 'skills'>;
type Services = Pick<ActivitySnapshot, 'rag' | 'memory'> & {
  providerSubagents: AgentActivity[];
  task?: string;
};
type RegisteredSkill = { name: string; path: string };

export function observedTimestamp(value: string): number {
  return time(value);
}

const recentLimit = 32;
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
  private loaded = false;
  private readonly calls = new Map<string, { seq: number; call: ToolCall }>();
  private readonly loadedSkills = new Map<string, SkillLoad>();
  private readonly skills = new Map<string, string>();
  private readonly skillFiles = new Map<string, string>();
  private skillFilesKnown = false;
  private skillsKnown = false;
  private pending?: Promise<void>;
  private refetchRequired = true;
  private readonly stop: ReturnType<PaseoAgentHandle['timeline']['subscribe']>;

  constructor(
    private readonly agent: PaseoAgentHandle,
    private readonly signal: AbortSignal,
  ) {
    this.stop = agent.timeline.subscribe((update) => {
      const { event } = update;
      switch (event.type) {
        case 'timeline':
          if ('seq' in update && typeof update.seq === 'number') {
            if (update.epoch && this.epoch && update.epoch !== this.epoch) {
              this.reset(update.epoch);
              this.refetchRequired = true;
            }
            this.accept(event.item, update.seq, time(update.timestamp));
          }
          break;
        case 'replacement':
          this.reset(event.epoch);
          this.refetchRequired = true;
          break;
        case 'subscription_restored':
          this.calls.clear();
          this.loadedSkills.clear();
          this.loaded = false;
          this.refetchRequired = true;
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

  read(): Promise<AgentEvents> {
    if (this.refetchRequired && !this.signal.aborted) {
      this.pending ??= this.refetch().finally(() => {
        this.pending = undefined;
      });
    }
    return (this.pending ?? Promise.resolve()).then(() => ({
      tools: this.loaded ? [...this.calls.values()].map(({ call }) => call) : null,
      skills: this.skillsKnown || this.skillFilesKnown ? [...this.loadedSkills.values()] : null,
    }));
  }

  private reset(epoch: string): void {
    this.epoch = epoch;
    this.calls.clear();
    this.loadedSkills.clear();
    this.loaded = false;
  }

  private async refetch(): Promise<void> {
    this.refetchRequired = false;
    try {
      await this.stop.ready.catch(() => {});
      if (this.signal.aborted) return;
      const page = await this.agent.timeline.refetch({
        direction: 'tail',
        projection: 'canonical',
        limit: 160,
      });
      if (this.signal.aborted) return;
      if (page.error) throw new Error('Timeline unavailable.');
      if (this.epoch && this.epoch !== page.epoch) this.reset(page.epoch);
      this.epoch = page.epoch;
      for (const entry of page.entries)
        this.accept(entry.item, entry.seqEnd, time(entry.timestamp));
      this.loaded = true;
      this.prune();
    } catch {
      this.refetchRequired = true;
    }
  }

  async registerSkills(files: () => Promise<RegisteredSkill[] | undefined>): Promise<void> {
    if (this.signal.aborted) return;
    if (!this.skillFilesKnown) {
      const resolved = await files().catch(() => undefined);
      if (resolved) {
        for (const skill of resolved) this.skillFiles.set(path.normalize(skill.path), skill.name);
        this.skillFilesKnown = true;
        this.refetchRequired = true;
      }
    }
    if (this.skillsKnown || this.signal.aborted || !this.agent.activeTurn) return;
    try {
      const commands = await this.agent.commands();
      if (commands.error || this.signal.aborted) return;
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
      const name = /^<skill name="([^"]+)" location="[^"]+">\n/.exec(item.text)?.[1];
      if (name !== undefined && this.skills.has(name)) this.loadSkill(name, timestamp);
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
    const prior = this.calls.get(item.callId);
    if (prior && prior.seq > seq) return;
    const startedAt = prior?.call.startedAt ?? timestamp;
    const state =
      item.status === 'completed'
        ? 'success'
        : item.status === 'canceled'
          ? 'cancelled'
          : item.status;
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
              ...(prior?.call.status === 'running'
                ? { durationMs: Math.max(0, timestamp - startedAt) }
                : {}),
            }
          : {}),
      },
    });
    this.prune();
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
  services: (agent: PaseoAgent, signal: AbortSignal) => Promise<Services>,
  registeredSkills: (agent: PaseoAgent) => Promise<RegisteredSkill[] | undefined>,
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
    const [items, state] = await Promise.all([
      Promise.all(
        visible.map(async (agent) => {
          let observation = observations.get(agent.id);
          if (!observation) {
            observation = new AgentTimeline(paseo.agents.ref(agent), signal);
            observations.set(agent.id, observation);
          }
          if (agent.provider === 'pi' || agent.provider === 'ltcook')
            await observation.registerSkills(() => registeredSkills(agent));
          return nativeActivity(agent, await observation.read());
        }),
      ),
      services(entry.agent, signal),
    ]);
    const { providerSubagents, task, ...servicesState } = state;
    if (!signal.aborted) {
      await push({
        selectedAgentId: agentId,
        revision: ++revision,
        capturedAt: Date.now(),
        agent: { ...items[0]!, ...(task ? { task } : {}) },
        subagents: [
          ...items.slice(1),
          ...providerSubagents.filter((child) => !visible.some((agent) => agent.id === child.id)),
        ],
        ...servicesState,
        activityScopeLabel: 'Recent conversation activity',
      });
    }
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

import { z } from 'zod';
import {
  RenameProposalSchema,
  boundedWorkspaceTitle,
  readMetadataState,
  sameWorkspaceContent,
  writeMetadataState,
  type WorkspaceMetadataSnapshot,
  type WorkspaceServiceOptions,
  type WorkspaceServiceStatus,
} from './workspace-metadata.js';

export const WORKSPACE_RENAME_INTERVAL_MS = 30 * 60 * 1000;
export const WORKSPACE_TITLE_LIMIT = 20;
export const AGENT_TAB_TITLE_LIMIT = 15;

const renamerState = z.strictObject({
  version: z.literal(1),
  workspaces: z.record(
    z.string(),
    z.strictObject({
      nextRenameAt: z.number().finite().nonnegative(),
      workspaceVersion: z.string().optional(),
      agents: z.record(z.string(), z.string()),
    }),
  ),
});
type RenamerState = z.infer<typeof renamerState>;

export interface RenamerOptions extends WorkspaceServiceOptions {
  renameWorkspaces?: () => boolean;
  renameTabs?: () => boolean;
}

export class Renamer {
  private readonly state: RenamerState;
  private pending: Promise<void> | undefined;
  private details: Omit<WorkspaceServiceStatus, 'enabled' | 'running'> = {
    lastRunAt: null,
    lastSuccessAt: null,
    processed: 0,
  };

  constructor(private readonly options: RenamerOptions) {
    this.state = readMetadataState(options.stateFile, renamerState, {
      version: 1,
      workspaces: {},
    });
  }

  status(): WorkspaceServiceStatus {
    return {
      ...this.details,
      enabled: this.options.enabled?.() ?? true,
      running: this.pending !== undefined,
    };
  }

  tick(snapshots: WorkspaceMetadataSnapshot[], signal: AbortSignal): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.run(snapshots, signal).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private save(): void {
    writeMetadataState(this.options.stateFile, this.state);
  }

  private async run(snapshots: WorkspaceMetadataSnapshot[], signal: AbortSignal): Promise<void> {
    if (!(this.options.enabled?.() ?? true)) return;
    signal.throwIfAborted();
    this.details.lastRunAt = this.now();
    delete this.details.diagnostic;
    for (const snapshot of snapshots) {
      signal.throwIfAborted();
      if (snapshot.archived || snapshot.complete === false) continue;
      const entry = (this.state.workspaces[snapshot.id] ??= { nextRenameAt: 0, agents: {} });
      if (this.now() < entry.nextRenameAt) continue;
      const workspace =
        (this.options.renameWorkspaces?.() ?? true) &&
        snapshot.context.trim().length > 0 &&
        entry.workspaceVersion !== snapshot.contentVersion;
      const agents =
        (this.options.renameTabs?.() ?? true)
          ? snapshot.agents.filter(
              (agent) =>
                !agent.archived &&
                agent.context.trim().length > 0 &&
                entry.agents[agent.id] !== agent.contentVersion,
            )
          : [];
      if (!workspace && agents.length === 0) continue;
      // Attempt clocks survive failure and process restart. No model poll loop on unchanged work.
      entry.nextRenameAt = this.now() + WORKSPACE_RENAME_INTERVAL_MS;
      this.save();
      try {
        const proposal = RenameProposalSchema.parse(
          await this.options.generator.rename(
            snapshot,
            { workspace, agentIds: agents.map(({ id }) => id) },
            signal,
          ),
        );
        signal.throwIfAborted();
        const requested = new Set(agents.map(({ id }) => id));
        const received = new Set(proposal.agents.map(({ id }) => id));
        if (
          received.size !== proposal.agents.length ||
          received.size !== requested.size ||
          proposal.agents.some(({ id }) => !requested.has(id)) ||
          (proposal.workspaceTitle !== undefined) !== workspace
        )
          throw new Error('Renamer received titles for a different set of targets.');
        const workspaceTitle =
          proposal.workspaceTitle === undefined
            ? undefined
            : boundedWorkspaceTitle(proposal.workspaceTitle, WORKSPACE_TITLE_LIMIT);
        const titles = proposal.agents.map(({ id, title }) => ({
          id,
          title: boundedWorkspaceTitle(title, AGENT_TAB_TITLE_LIMIT),
        }));
        if (workspaceTitle === '' || titles.some(({ title }) => !title))
          throw new Error('Renamer received an empty title.');
        let current = await this.options.host.read(snapshot.id, signal);
        signal.throwIfAborted();
        if (!(this.options.enabled?.() ?? true)) return;
        if (!sameWorkspaceContent(snapshot, current)) continue;
        if (
          workspaceTitle &&
          current.title === snapshot.title &&
          (this.options.renameWorkspaces?.() ?? true) &&
          (current.title === workspaceTitle ||
            (await this.options.host.renameWorkspace(current, workspaceTitle, signal)))
        ) {
          signal.throwIfAborted();
          entry.workspaceVersion = snapshot.contentVersion;
          this.details.processed++;
          this.details.lastSuccessAt = this.now();
          this.save();
        }
        for (const { id, title } of titles) {
          signal.throwIfAborted();
          if (!(this.options.enabled?.() ?? true)) return;
          if (!(this.options.renameTabs?.() ?? true)) break;
          current = await this.options.host.read(snapshot.id, signal);
          signal.throwIfAborted();
          if (!sameWorkspaceContent(snapshot, current)) break;
          const before = agents.find((agent) => agent.id === id)!;
          const agent = current.agents.find((value) => value.id === id && !value.archived);
          if (
            !agent ||
            agent.contentVersion !== before.contentVersion ||
            agent.title !== before.title
          )
            continue;
          if (
            agent.title === title ||
            (await this.options.host.renameAgent(current, id, title, signal))
          ) {
            signal.throwIfAborted();
            entry.agents[id] = agent.contentVersion;
            this.details.processed++;
            this.details.lastSuccessAt = this.now();
            this.save();
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        this.details.diagnostic = 'Renamer could not finish its latest update.';
        this.options.onError?.(error, snapshot.id);
      }
    }
  }
}

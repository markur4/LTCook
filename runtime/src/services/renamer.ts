import { ServiceInferenceError } from './inference-recovery.js';
import {
  boundedWorkspaceTitle,
  RenameProposalSchema,
  type WorkspaceMetadataGenerator,
  type WorkspaceNamingHost,
  type WorkspaceNamingJob,
  type WorkspaceNamingTitles,
  type WorkspaceServiceStatus,
} from './workspace-metadata.js';

export const WORKSPACE_TITLE_LIMIT = 20;
export const AGENT_TAB_TITLE_LIMIT = 15;

interface RenamerOptions {
  host?: WorkspaceNamingHost;
  generator: WorkspaceMetadataGenerator;
  enabled: boolean;
  settingsDiagnostic?: string;
  now?: () => number;
  onError?: (error: unknown, workspaceId: string) => void;
}

export class Renamer {
  private readonly active = new Map<string, Promise<void>>();
  private readonly signaled = new Set<string>();
  private details: Omit<WorkspaceServiceStatus, 'enabled' | 'running'> = {
    lastRunAt: null,
    lastSuccessAt: null,
    processed: 0,
  };

  constructor(private readonly options: RenamerOptions) {}

  status(): WorkspaceServiceStatus {
    const diagnostic =
      this.options.settingsDiagnostic ??
      (this.options.enabled && !this.options.host
        ? 'Restart LTCook to enable first-prompt naming on the managed Paseo host.'
        : this.details.diagnostic);
    return {
      ...this.details,
      enabled: this.options.enabled && Boolean(this.options.host),
      running: this.active.size > 0,
      diagnostic,
      ...(diagnostic
        ? {
            diagnostics: [
              {
                operation: this.options.settingsDiagnostic ? 'settings' : 'rename',
                message: diagnostic,
              },
            ],
          }
        : {}),
    };
  }

  async wait(): Promise<void> {
    await Promise.all(this.active.values());
  }

  visit(workspaceId: string, projectName: string, signal: AbortSignal): Promise<void> {
    const host = this.options.host;
    if (!this.options.enabled || !host || signal.aborted) return Promise.resolve();
    const active = this.active.get(workspaceId);
    if (active) {
      this.signaled.add(workspaceId);
      return active;
    }
    const work = this.run(host, workspaceId, projectName, signal)
      .catch((error: unknown) => {
        if (!signal.aborted) {
          this.details.diagnostic = 'Renamer could not update titles on this Paseo host.';
          this.options.onError?.(error, workspaceId);
        }
      })
      .finally(() => {
        this.active.delete(workspaceId);
        this.signaled.delete(workspaceId);
      });
    this.active.set(workspaceId, work);
    return work;
  }

  private async run(
    host: WorkspaceNamingHost,
    workspaceId: string,
    projectName: string,
    signal: AbortSignal,
  ) {
    const now = this.options.now ?? Date.now;
    do {
      this.signaled.delete(workspaceId);
      for (const job of await host.pending(workspaceId, signal)) {
        signal.throwIfAborted();
        this.details.lastRunAt = now();
        const titles = await this.titles(job, projectName, signal);
        signal.throwIfAborted();
        if (await host.apply(job, titles, signal)) {
          this.details.lastSuccessAt = now();
          this.details.processed++;
        }
      }
    } while (this.signaled.has(workspaceId) && !signal.aborted);
  }

  private async titles(
    job: WorkspaceNamingJob,
    projectName: string,
    signal: AbortSignal,
  ): Promise<WorkspaceNamingTitles> {
    const limit = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
    let proposal: ReturnType<typeof RenameProposalSchema.parse> | undefined;
    try {
      proposal = RenameProposalSchema.parse(
        await this.options.generator.rename({ ...job, projectName }, limit),
      );
      limit.throwIfAborted();
      if (proposal.agents.length > 1 || proposal.agents.some(({ id }) => id !== job.agentId))
        throw new Error('Renamer received a title for an unexpected target.');
      this.details.diagnostic = undefined;
    } catch (error) {
      signal.throwIfAborted();
      proposal = undefined;
      this.details.diagnostic =
        error instanceof ServiceInferenceError
          ? error.message
          : 'Renamer used a first-prompt fallback.';
    }
    const fallback = (limit: number, defaultTitle: string) =>
      boundedWorkspaceTitle((job.prompt.split(/\r?\n/u)[0] ?? '').trim(), limit) || defaultTitle;
    return {
      ...(job.nameWorkspace
        ? {
            workspaceTitle:
              boundedWorkspaceTitle(proposal?.workspaceTitle ?? '', WORKSPACE_TITLE_LIMIT) ||
              fallback(WORKSPACE_TITLE_LIMIT, 'New workspace'),
          }
        : {}),
      ...(job.nameTab
        ? {
            agentTitle:
              boundedWorkspaceTitle(proposal?.agents[0]?.title ?? '', AGENT_TAB_TITLE_LIMIT) ||
              fallback(AGENT_TAB_TITLE_LIMIT, 'New session'),
          }
        : {}),
    };
  }
}

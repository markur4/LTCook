import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { DiagnosticEvent } from '../diagnostics/telemetry.js';
import type { RepositoryWorkspace } from '../repository/workspace.js';

export interface IndexJobStatus {
  activity: 'idle' | 'queued' | 'indexing' | 'retrying' | 'paused' | 'error';
  diagnostic: string | null;
  retryAt?: string;
}

export const REPOSITORY_INDEX_TIMEOUT_MS = 15 * 60_000;
const STALLED = 'Repository indexing exceeded its progress deadline.';

export interface RepositoryIndexDiagnostic {
  code: `repository-index.${'completed' | 'retrying' | 'failed' | 'blocked' | 'cancelled' | 'stalled'}`;
  severity: 'info' | 'warn' | 'error';
  outcome: 'success' | 'failure' | 'cancelled' | 'blocked' | 'incomplete';
  operationId: string;
  workspaceId: string;
  elapsedMs: number;
  message: string;
  cause?: unknown;
  retryAt?: string;
}

export function repositoryIndexDiagnosticEvent({
  workspaceId,
  elapsedMs,
  retryAt,
  ...event
}: RepositoryIndexDiagnostic): DiagnosticEvent {
  return {
    ...event,
    component: 'repository-index',
    correlationId: event.operationId,
    context: { workspaceId, elapsedMs, retryAt },
  };
}

export class RepositoryIndexError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    cause?: unknown,
    readonly outcome: 'failure' | 'blocked' = 'failure',
  ) {
    super(message, { cause });
  }
}

interface Job {
  workspaceId: string;
  authorizations: Set<{ workspace: RepositoryWorkspace }>;
  dueAt: number;
  lastStartedAt: number;
  failures: number;
  failure?: RepositoryIndexError;
  followUp: boolean;
}

interface ActiveJob {
  job: Job;
  controller: AbortController;
  done: Promise<void>;
  deadlineExceeded: boolean;
}

interface RepositoryIndexOptions {
  reconcileMs?: number;
  retryInitialMs?: number;
  retryMaximumMs?: number;
  progressDeadlineMs?: number;
  onDiagnostic?: (diagnostic: RepositoryIndexDiagnostic) => void | Promise<void>;
}

function workspaceKey(workspace: RepositoryWorkspace): string {
  return JSON.stringify([workspace.root, workspace.identity]);
}

const noAuthorization = (cause?: unknown) =>
  new RepositoryIndexError(
    'The worktree authorization expired. Reopen the workspace.',
    false,
    cause,
    'blocked',
  );

/** Schedules reconciliation for worktrees authorized by the current runtime. */
export class RepositoryIndexService {
  private readonly jobs = new Map<string, Job>();
  private readonly reconcileMs: number;
  private readonly retryInitialMs: number;
  private readonly retryMaximumMs: number;
  private readonly progressDeadlineMs: number;
  private readonly onDiagnostic: RepositoryIndexOptions['onDiagnostic'];
  private enabled = true;
  private closed = false;
  private active?: ActiveJob;
  private timer?: { controller: AbortController; dueAt: number };

  constructor(
    private readonly reconcile: (
      workspace: RepositoryWorkspace,
      signal: AbortSignal,
    ) => Promise<'unchanged' | void>,
    {
      reconcileMs = 15_000,
      retryInitialMs = 1_000,
      retryMaximumMs = 60_000,
      progressDeadlineMs = REPOSITORY_INDEX_TIMEOUT_MS,
      onDiagnostic,
    }: RepositoryIndexOptions = {},
  ) {
    this.reconcileMs = reconcileMs;
    this.retryInitialMs = retryInitialMs;
    this.retryMaximumMs = retryMaximumMs;
    this.progressDeadlineMs = progressDeadlineMs;
    this.onDiagnostic = onDiagnostic;
  }

  activate(workspace: RepositoryWorkspace): () => void {
    if (this.closed) return () => {};
    const key = workspaceKey(workspace);
    let job = this.jobs.get(key);
    if (!job) {
      job = {
        workspaceId: createHash('sha256')
          .update(JSON.stringify([workspace.root, workspace.cacheIdentity]))
          .digest('hex'),
        authorizations: new Set(),
        dueAt: Date.now(),
        lastStartedAt: 0,
        failures: 0,
        followUp: false,
      };
      this.jobs.set(key, job);
    }
    const authorization = { workspace };
    job.authorizations.add(authorization);
    this.schedule();

    return () => {
      if (!job.authorizations.delete(authorization) || job.authorizations.size) return;
      this.jobs.delete(key);
      if (this.active?.job === job) this.active.controller.abort(noAuthorization());
      this.schedule();
    };
  }

  /** Advance an authorized worktree's next check, coalescing repeated requests. */
  request(workspace: RepositoryWorkspace): void {
    const job = this.jobs.get(workspaceKey(workspace));
    if (!job || !this.enabled || job.failure) return;
    const now = Date.now();
    const earliest = job.lastStartedAt + Math.min(this.reconcileMs, 2_000);
    if (now < earliest) return;
    job.dueAt = Math.min(job.dueAt, now);
    this.schedule();
  }

  status(workspace: RepositoryWorkspace): IndexJobStatus {
    if (!this.enabled) return { activity: 'paused', diagnostic: null };
    const job = this.jobs.get(workspaceKey(workspace));
    if (!job) return { activity: 'idle', diagnostic: null };
    if (this.active?.job === job && !this.active.controller.signal.aborted)
      return { activity: 'indexing', diagnostic: this.active.deadlineExceeded ? STALLED : null };
    if (job.failure) {
      const diagnostic = job.failure.message;
      return job.failure.retryable
        ? { activity: 'retrying', diagnostic, retryAt: new Date(job.dueAt).toISOString() }
        : { activity: 'error', diagnostic };
    }
    return { activity: job.dueAt <= Date.now() ? 'queued' : 'idle', diagnostic: null };
  }

  isEnabled(): boolean {
    return this.enabled && !this.closed;
  }

  setEnabled(enabled: boolean): void {
    if (this.closed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) {
      const now = Date.now();
      for (const job of this.jobs.values()) {
        job.dueAt = now;
        job.failure = undefined;
        job.failures = 0;
        job.followUp = false;
      }
    } else {
      this.active?.controller.abort(
        new RepositoryIndexError('Repository indexing is paused.', true),
      );
    }
    this.schedule();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.jobs.clear();
    this.schedule();
    const active = this.active;
    active?.controller.abort(
      new RepositoryIndexError('LTCook is stopping repository indexing.', true),
    );
    await active?.done;
  }

  private schedule(): void {
    let dueAt = Infinity;
    if (this.enabled && !this.closed && !this.active) {
      for (const job of this.jobs.values()) dueAt = Math.min(dueAt, job.dueAt);
    }
    if (this.timer?.dueAt === dueAt) return;
    this.timer?.controller.abort();
    this.timer = undefined;
    if (!Number.isFinite(dueAt)) return;
    const timer = { controller: new AbortController(), dueAt };
    this.timer = timer;
    void delay(Math.max(0, dueAt - Date.now()), undefined, {
      signal: timer.controller.signal,
      ref: false,
    }).then(
      () => {
        if (this.timer !== timer) return;
        this.timer = undefined;
        this.startNext();
      },
      () => {},
    );
  }

  private startNext(): void {
    if (!this.enabled || this.closed || this.active) return;
    const now = Date.now();
    let next: Job | undefined;
    for (const job of this.jobs.values()) {
      if (job.dueAt <= now && (!next || job.dueAt < next.dueAt)) next = job;
    }
    if (!next) {
      this.schedule();
      return;
    }
    const controller = new AbortController();
    this.active = {
      job: next,
      controller,
      deadlineExceeded: false,
      done: this.run(next, controller.signal, now),
    };
  }

  private async authorizedWorkspace(job: Job, signal: AbortSignal) {
    const authorize = async () => {
      signal.throwIfAborted();
      let cause: unknown;
      for (const authorization of job.authorizations) {
        try {
          await authorization.workspace.assertUnchanged();
        } catch (error) {
          cause = error;
          continue;
        }
        signal.throwIfAborted();
        if (job.authorizations.has(authorization)) return authorization.workspace;
      }
      throw noAuthorization(cause);
    };
    const workspace = await authorize();
    return {
      ...workspace,
      async assertUnchanged() {
        await authorize();
      },
    };
  }

  private async run(job: Job, signal: AbortSignal, startedAt: number): Promise<void> {
    job.lastStartedAt = startedAt;
    const scheduledRecheck = startedAt + this.reconcileMs;
    job.dueAt = scheduledRecheck;
    const operationId = randomUUID();
    const started = performance.now();
    const report = (
      event: Omit<RepositoryIndexDiagnostic, 'operationId' | 'workspaceId' | 'elapsedMs'>,
    ) => {
      void this.reportDiagnostic({
        ...event,
        operationId,
        workspaceId: job.workspaceId,
        elapsedMs: Math.round(performance.now() - started),
      });
    };
    const deadline = new AbortController();
    void delay(this.progressDeadlineMs, undefined, { signal: deadline.signal, ref: false }).then(
      () => {
        if (signal.aborted || this.active?.job !== job) return;
        this.active.deadlineExceeded = true;
        report({
          code: 'repository-index.stalled',
          severity: 'error',
          outcome: 'incomplete',
          message: STALLED,
        });
      },
      () => {},
    );
    const cancelled = () => {
      deadline.abort();
      report({
        code: 'repository-index.cancelled',
        severity: 'info',
        outcome: 'cancelled',
        message:
          signal.reason instanceof RepositoryIndexError
            ? signal.reason.message
            : 'Repository indexing was cancelled.',
      });
    };
    signal.addEventListener('abort', cancelled, { once: true });
    try {
      const workspace = await this.authorizedWorkspace(job, signal);
      const result = await this.reconcile(workspace, signal);
      if (signal.aborted) return;
      const recovered = job.failure !== undefined || this.active?.deadlineExceeded;
      job.failure = undefined;
      job.failures = 0;
      const finishedAt = Date.now();
      // > Periodically reconcile from disk because filesystem events can be lost.
      // > A long run or a request during it earns one coalesced follow-up, then
      // > the normal interval applies again even if the follow-up is also long.
      job.followUp =
        !job.followUp && (job.dueAt < scheduledRecheck || finishedAt >= scheduledRecheck);
      job.dueAt = job.followUp ? finishedAt : finishedAt + this.reconcileMs;
      if (result !== 'unchanged' || recovered) {
        report({
          code: 'repository-index.completed',
          severity: 'info',
          outcome: 'success',
          message: 'Repository index reconciliation completed.',
        });
      }
    } catch (error) {
      if (signal.aborted) return;
      job.failure =
        error instanceof RepositoryIndexError
          ? error
          : new RepositoryIndexError(
              'Could not refresh the repository index. Check worktree access and AppRC cache space.',
              true,
              error,
            );
      job.failures = Math.min(job.failures + 1, 30);
      job.dueAt = job.failure.retryable
        ? Date.now() + Math.min(this.retryInitialMs * 2 ** (job.failures - 1), this.retryMaximumMs)
        : Infinity;
      const { message, cause, outcome, retryable } = job.failure;
      const blocked = outcome === 'blocked';
      report({
        code: blocked
          ? 'repository-index.blocked'
          : retryable
            ? 'repository-index.retrying'
            : 'repository-index.failed',
        severity: blocked ? 'info' : retryable ? 'warn' : 'error',
        outcome,
        message,
        cause,
        retryAt: retryable ? new Date(job.dueAt).toISOString() : undefined,
      });
    } finally {
      deadline.abort();
      signal.removeEventListener('abort', cancelled);
      this.active = undefined;
      this.schedule();
    }
  }

  private async reportDiagnostic(diagnostic: RepositoryIndexDiagnostic): Promise<void> {
    try {
      await this.onDiagnostic?.(diagnostic);
    } catch {
      // > An unavailable log sink must not disrupt reconciliation.
    }
  }
}

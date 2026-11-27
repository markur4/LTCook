import { z } from 'zod';
import { ServiceInferenceError } from './inference-recovery.js';
import {
  ClassificationSchema,
  WORKSPACE_LABELS,
  WorkspaceInferenceRecovery,
  readMetadataState,
  sameWorkspaceContent,
  workspaceInferenceState,
  writeMetadataState,
  type WorkspaceMetadataSnapshot,
  type WorkspaceServiceDiagnostic,
  type WorkspaceServiceOptions,
  type WorkspaceServiceStatus,
} from './workspace-metadata.js';

export const WORKSPACE_CLASSIFICATION_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const WORKSPACE_ARCHIVE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const initialClassificationRetryDelay = 60_000;

const timestamp = z.number().finite().nonnegative();
const workspaceState = z.strictObject({
  firstObservedAt: timestamp,
  lastMeaningfulAt: timestamp,
  observedVersion: z.string(),
  classifiedVersion: z.string().optional(),
  nextClassificationAt: timestamp,
  initialRetryAt: timestamp.optional(),
  archived: z.boolean(),
});
const organizerState = z.strictObject({
  version: z.literal(1),
  workspaces: z.record(z.string(), workspaceState),
  inference: workspaceInferenceState.optional(),
  labelsFailed: z.boolean().optional(),
  archivesFailed: z.array(z.string()).optional(),
});
type OrganizerState = z.infer<typeof organizerState>;

export interface WorkspaceOrganizerOptions extends WorkspaceServiceOptions {
  autoArchive?: () => boolean;
  archiveDiagnostic?: () => string | undefined;
}

export class WorkspaceOrganizer {
  private readonly state: OrganizerState;
  private readonly inference: WorkspaceInferenceRecovery;
  private readonly archiveFailures: Set<string>;
  private pending: Promise<void> | undefined;
  private nextCatalogAt = 0;
  private details: Omit<WorkspaceServiceStatus, 'enabled' | 'running'> = {
    lastRunAt: null,
    lastSuccessAt: null,
    processed: 0,
  };

  constructor(private readonly options: WorkspaceOrganizerOptions) {
    this.state = readMetadataState(options.stateFile, organizerState, {
      version: 1,
      workspaces: {},
    });
    this.inference = new WorkspaceInferenceRecovery(
      options,
      'classification',
      'Workspace Organizer could not apply classification. Check the selected model and native workspace labels.',
      (this.state.inference ??= { failures: {} }),
      () => this.save(),
    );
    this.archiveFailures = new Set(this.state.archivesFailed);
  }

  status(): WorkspaceServiceStatus {
    const diagnostics: WorkspaceServiceDiagnostic[] = [];
    if (this.options.settingsDiagnostic)
      diagnostics.push({ operation: 'settings', message: this.options.settingsDiagnostic });
    const classification = this.inference.diagnostic();
    if (classification) diagnostics.push(classification);
    if (this.state.labelsFailed)
      diagnostics.push({
        operation: 'labels',
        message:
          'Workspace Organizer could not synchronize labels. Check Paseo or open an active workspace.',
      });
    const archive =
      this.options.archiveDiagnostic?.() ??
      (this.archiveFailures.size > 0
        ? 'Workspace Organizer could not archive a workspace. Check Paseo before its next check.'
        : undefined);
    if (archive) diagnostics.push({ operation: 'archive', message: archive });
    return {
      ...this.details,
      ...(diagnostics.length ? { diagnostics, diagnostic: diagnostics[0]!.message } : {}),
      enabled: this.options.enabled?.() ?? true,
      running: this.pending !== undefined,
    };
  }

  /** Supply the complete active workspace inventory, never a filtered or partial page. */
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
    if (this.archiveFailures.size > 0) this.state.archivesFailed = [...this.archiveFailures];
    else delete this.state.archivesFailed;
    writeMetadataState(this.options.stateFile, this.state);
  }

  private observe(snapshot: WorkspaceMetadataSnapshot) {
    const now = this.now();
    const known = this.state.workspaces[snapshot.id];
    const before = known && {
      lastMeaningfulAt: known.lastMeaningfulAt,
      observedVersion: known.observedVersion,
      archived: known.archived,
    };
    const entry = known ?? {
      firstObservedAt: now,
      // Existing native records have no complete history of human reading/focus.
      lastMeaningfulAt: now,
      observedVersion: snapshot.contentVersion,
      nextClassificationAt: 0,
      archived: false,
    };
    if (entry.archived && !snapshot.archived) {
      entry.lastMeaningfulAt = now;
      entry.archived = false;
    }
    const activityAt = Number.isFinite(snapshot.activityAt)
      ? Math.min(now, Math.max(0, snapshot.activityAt!))
      : undefined;
    entry.lastMeaningfulAt = Math.max(entry.lastMeaningfulAt, activityAt ?? 0);
    if (snapshot.complete !== false && entry.observedVersion !== snapshot.contentVersion) {
      // A newly observed revision is activity even when native timestamps lag behind it.
      entry.lastMeaningfulAt = now;
      entry.observedVersion = snapshot.contentVersion;
    }
    if (snapshot.archived) entry.archived = true;
    this.state.workspaces[snapshot.id] = entry;
    return {
      entry,
      changed:
        !before ||
        before.lastMeaningfulAt !== entry.lastMeaningfulAt ||
        before.observedVersion !== entry.observedVersion ||
        before.archived !== entry.archived,
    };
  }

  private observeInventory(snapshots: WorkspaceMetadataSnapshot[]): void {
    let changed = false;
    const present = new Set<string>();
    for (const snapshot of snapshots) {
      present.add(snapshot.id);
      if (this.observe(snapshot).changed) changed = true;
    }
    for (const [id, entry] of Object.entries(this.state.workspaces)) {
      if (!present.has(id) && !entry.archived) {
        entry.archived = true;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private classificationConflict(
    expected: WorkspaceMetadataSnapshot,
    current: WorkspaceMetadataSnapshot | undefined,
    firstAttempt: boolean,
  ): void {
    if (!current || current.id !== expected.id) return;
    const observed = this.observe(current);
    if (
      firstAttempt &&
      !current.archived &&
      current.complete !== false &&
      current.contentVersion !== expected.contentVersion &&
      this.now() + initialClassificationRetryDelay < observed.entry.nextClassificationAt
    ) {
      // Only the very first valid-but-stale classification gets one early retry.
      observed.entry.initialRetryAt = this.now() + initialClassificationRetryDelay;
      observed.changed = true;
    }
    if (observed.changed) this.save();
  }

  private eligible(snapshot: WorkspaceMetadataSnapshot, lastMeaningfulAt: number): boolean {
    return (
      (this.options.autoArchive?.() ?? true) &&
      !snapshot.archived &&
      snapshot.complete !== false &&
      !snapshot.pinned &&
      !snapshot.busy &&
      !snapshot.awaitingInput &&
      snapshot.archiveSafe &&
      this.now() - lastMeaningfulAt >= WORKSPACE_ARCHIVE_AFTER_MS
    );
  }

  private async run(snapshots: WorkspaceMetadataSnapshot[], signal: AbortSignal): Promise<void> {
    if (!(this.options.enabled?.() ?? true)) return;
    signal.throwIfAborted();
    this.details.lastRunAt = this.now();
    this.observeInventory(snapshots);
    const inferenceReady = this.options.generator.validate
      ? await this.inference.ready(signal)
      : true;
    if (this.now() >= this.nextCatalogAt) {
      try {
        await this.options.host.ensureLabels(WORKSPACE_LABELS, signal);
        signal.throwIfAborted();
        this.nextCatalogAt = this.now() + WORKSPACE_CLASSIFICATION_INTERVAL_MS;
        if (this.state.labelsFailed) {
          delete this.state.labelsFailed;
          this.save();
        }
      } catch {
        signal.throwIfAborted();
        if (!this.state.labelsFailed) {
          this.state.labelsFailed = true;
          this.save();
          this.options.onError?.(new Error('Workspace label synchronization failed.'));
        }
      }
    }
    for (const snapshot of snapshots) {
      signal.throwIfAborted();
      const entry = this.state.workspaces[snapshot.id]!;
      if (snapshot.archived || snapshot.complete === false) continue;
      try {
        if (this.eligible(snapshot, entry.lastMeaningfulAt)) {
          const current = await this.options.host.read(snapshot.id, signal);
          signal.throwIfAborted();
          if (!(this.options.enabled?.() ?? true)) return;
          if (!current) continue;
          const observed = this.observe(current);
          if (observed.changed) this.save();
          const latest = observed.entry;
          if (
            sameWorkspaceContent(snapshot, current) &&
            this.eligible(current, latest.lastMeaningfulAt) &&
            (await this.options.host.archive(current, signal))
          ) {
            signal.throwIfAborted();
            latest.archived = true;
            this.archiveFailures.delete(snapshot.id);
            this.details.processed++;
            this.details.lastSuccessAt = this.now();
            this.save();
            continue;
          }
        }
      } catch {
        signal.throwIfAborted();
        if (!this.archiveFailures.has(snapshot.id)) {
          this.archiveFailures.add(snapshot.id);
          this.save();
          this.options.onError?.(new Error('Automatic archive failed.'), snapshot.id);
        }
      }
      if (
        !inferenceReady ||
        this.state.labelsFailed ||
        !this.inference.permits(snapshot.id) ||
        !snapshot.context.trim() ||
        entry.classifiedVersion === snapshot.contentVersion
      )
        continue;
      const previousDeadline = entry.nextClassificationAt;
      const previousEarlyRetry = entry.initialRetryAt;
      try {
        const earlyRetry =
          entry.initialRetryAt !== undefined && this.now() < entry.nextClassificationAt;
        if (earlyRetry) {
          if (this.now() < entry.initialRetryAt! || snapshot.busy || snapshot.awaitingInput)
            continue;
        } else if (this.now() < entry.nextClassificationAt) continue;
        const firstAttempt = entry.nextClassificationAt === 0;
        // Record the attempt before inference so restarts and invalid replies do not cause loops.
        if (!earlyRetry)
          entry.nextClassificationAt = this.now() + WORKSPACE_CLASSIFICATION_INTERVAL_MS;
        delete entry.initialRetryAt;
        this.save();
        const proposal = ClassificationSchema.parse(
          await this.options.generator.classify(snapshot, signal),
        );
        signal.throwIfAborted();
        const current = await this.options.host.read(snapshot.id, signal);
        signal.throwIfAborted();
        if (!(this.options.enabled?.() ?? true)) return;
        if (!sameWorkspaceContent(snapshot, current)) {
          this.classificationConflict(snapshot, current, firstAttempt);
          continue;
        }
        const owned = current.labels.filter((name) =>
          WORKSPACE_LABELS.some((label) => label.name === name),
        );
        const unchanged = owned.length === 1 && owned[0] === proposal.category;
        if (
          unchanged ||
          (await this.options.host.setCategory(current, proposal.category, signal))
        ) {
          signal.throwIfAborted();
          entry.classifiedVersion = snapshot.contentVersion;
          this.inference.succeeded(snapshot.id);
          if (!unchanged) {
            this.details.processed++;
            this.details.lastSuccessAt = this.now();
          }
          this.save();
        } else if (firstAttempt) {
          const changed = await this.options.host.read(snapshot.id, signal);
          signal.throwIfAborted();
          this.classificationConflict(snapshot, changed, firstAttempt);
        }
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ServiceInferenceError) {
          entry.nextClassificationAt = previousDeadline;
          if (previousEarlyRetry !== undefined) entry.initialRetryAt = previousEarlyRetry;
        }
        this.inference.failed(snapshot.id, error, entry.nextClassificationAt);
      }
    }
  }
}

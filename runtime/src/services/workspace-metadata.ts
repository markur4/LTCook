import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ServiceInferenceError } from './inference-recovery.js';

export const WORKSPACE_LABELS = [
  { name: 'Feature', color: 'blue' },
  { name: 'Bugfix', color: 'red' },
  { name: 'CSC', color: 'amber' },
  { name: 'Research', color: 'violet' },
] as const;

export const WorkspaceCategorySchema = z.enum(['Feature', 'Bugfix', 'CSC', 'Research']);
export type WorkspaceCategory = z.infer<typeof WorkspaceCategorySchema>;

export interface WorkspaceAgentMetadata {
  id: string;
  title: string;
  /** Native conversation revision; title changes must not change this value. */
  contentVersion: string;
  context: string;
  archived: boolean;
}

export interface WorkspaceMetadataSnapshot {
  id: string;
  title: string;
  labels: string[];
  createdAt: number;
  /** Human interaction, messages, completed work, or working-file changes, in milliseconds. */
  activityAt?: number;
  /** Meaningful content only: exclude label/title writes, refreshes, and UI focus. */
  contentVersion: string;
  context: string;
  archived: boolean;
  pinned: boolean;
  busy: boolean;
  awaitingInput: boolean;
  /** False when the inventory or activity evidence is incomplete. */
  complete?: boolean;
  /** The adapter has established that native archive will preserve working files. */
  archiveSafe: boolean;
  agents: WorkspaceAgentMetadata[];
}

export interface WorkspaceMetadataHost {
  read(id: string, signal: AbortSignal): Promise<WorkspaceMetadataSnapshot | undefined>;
  ensureLabels(labels: typeof WORKSPACE_LABELS, signal: AbortSignal): Promise<void>;
  /** Replace only LTCook's category label; preserve all unrelated labels. */
  setCategory(
    expected: WorkspaceMetadataSnapshot,
    category: WorkspaceCategory,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Recheck activity, agent state, and filesystem preservation immediately before archive. */
  archive(expected: WorkspaceMetadataSnapshot, signal: AbortSignal): Promise<boolean>;
}

export const WorkspaceNamingJobSchema = z.strictObject({
  id: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(256),
  prompt: z.string().max(2500),
  nameWorkspace: z.boolean(),
  nameTab: z.boolean(),
  workspaceTitle: z.string(),
  agentTitle: z.string(),
});
export type WorkspaceNamingJob = z.infer<typeof WorkspaceNamingJobSchema>;

export interface WorkspaceNamingTitles {
  workspaceTitle?: string;
  agentTitle?: string;
}

export interface WorkspaceNamingHost {
  pending(workspaceId: string, signal: AbortSignal): Promise<WorkspaceNamingJob[]>;
  apply(
    job: WorkspaceNamingJob,
    titles: WorkspaceNamingTitles,
    signal: AbortSignal,
  ): Promise<boolean>;
}

/** Only proposes data. Native writes remain guarded by the daemon. */
export interface WorkspaceMetadataGenerator {
  validate?(signal: AbortSignal): Promise<string>;
  classify(snapshot: WorkspaceMetadataSnapshot, signal: AbortSignal): Promise<unknown>;
  rename(job: WorkspaceNamingJob & { projectName: string }, signal: AbortSignal): Promise<unknown>;
}

export const ClassificationSchema = z.strictObject({ category: WorkspaceCategorySchema });
export const RenameProposalSchema = z.strictObject({
  workspaceTitle: z.string().min(1).max(500).optional(),
  agents: z.array(z.strictObject({ id: z.string().min(1), title: z.string().min(1).max(500) })),
});

export type WorkspaceServiceDiagnostic = {
  operation: 'classification' | 'rename' | 'labels' | 'archive' | 'settings';
  message: string;
  nextCheckAt?: number;
};

export interface WorkspaceServiceStatus {
  enabled: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  processed: number;
  diagnostic?: string;
  diagnostics?: WorkspaceServiceDiagnostic[];
}

export interface WorkspaceServiceOptions {
  stateFile: string;
  host: WorkspaceMetadataHost;
  generator: WorkspaceMetadataGenerator;
  enabled?: () => boolean;
  settingsDiagnostic?: string;
  now?: () => number;
  onError?: (error: unknown, workspaceId?: string) => void;
}

export function readMetadataState<T>(file: string, schema: z.ZodType<T>, initial: T): T {
  try {
    return schema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return initial;
    throw new Error(
      'Workspace service state is invalid or unsupported. Reset its state file before restarting LTCook.',
      { cause: error },
    );
  }
}

export function writeMetadataState(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function sameWorkspaceContent(
  expected: WorkspaceMetadataSnapshot,
  current: WorkspaceMetadataSnapshot | undefined,
): current is WorkspaceMetadataSnapshot {
  return Boolean(
    current &&
    current.id === expected.id &&
    !current.archived &&
    current.complete !== false &&
    current.contentVersion === expected.contentVersion,
  );
}

/** Count displayed Unicode characters without cutting an emoji or combining sequence in half. */
export function boundedWorkspaceTitle(value: string, limit: number): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(clean))
    .slice(0, limit)
    .map(({ segment }) => segment)
    .join('')
    .trim();
}

export const workspaceInferenceState = z.strictObject({
  validationFailure: z.string().optional(),
  failures: z.record(
    z.string(),
    z.strictObject({
      message: z.string(),
      retryAt: z.number().int().nonnegative().optional(),
      attempts: z.number().int().positive(),
    }),
  ),
});
type WorkspaceInferenceState = z.infer<typeof workspaceInferenceState>;

const revalidationInterval = 60_000;
const initialRetry = 60_000;
const maximumRetry = 30 * 60_000;

/** Keep provider readiness and workspace-specific operation failures visible between polls. */
export class WorkspaceInferenceRecovery {
  private revision?: string;
  private nextValidationAt = 0;
  private blocked?: { revision?: string; failedValidation: boolean };

  constructor(
    private readonly options: WorkspaceServiceOptions,
    private readonly operation: 'classification' | 'rename',
    private readonly fallback: string,
    private readonly state: WorkspaceInferenceState,
    private readonly save: () => void,
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async ready(signal: AbortSignal): Promise<boolean> {
    const validate = this.options.generator.validate;
    if (!validate) return true;
    if (this.revision !== undefined && !this.blocked) return true;
    if (this.now() < this.nextValidationAt) return false;
    this.nextValidationAt = this.now() + revalidationInterval;
    try {
      const revision = await validate(signal);
      signal.throwIfAborted();
      if (this.blocked && !this.blocked.failedValidation && this.blocked.revision === revision)
        return false;
      this.revision = revision;
      this.blocked = undefined;
      if (this.state.validationFailure !== undefined) {
        delete this.state.validationFailure;
        this.save();
      }
      return true;
    } catch (error) {
      signal.throwIfAborted();
      const safe =
        error instanceof ServiceInferenceError
          ? error
          : new ServiceInferenceError('transient', 'The configured provider could not be checked.');
      this.blocked = { revision: this.revision, failedValidation: true };
      if (this.state.validationFailure !== safe.message) {
        this.state.validationFailure = safe.message;
        this.options.onError?.(safe);
        this.save();
      }
      return false;
    }
  }

  permits(id: string): boolean {
    return !this.blocked && this.now() >= (this.state.failures[id]?.retryAt ?? 0);
  }

  failed(id: string, error: unknown, regularCheckAt: number): void {
    const attempts = (this.state.failures[id]?.attempts ?? 0) + 1;
    const issue = error instanceof ServiceInferenceError ? error : undefined;
    if (issue && issue.kind !== 'transient' && this.options.generator.validate) {
      this.blocked = { revision: issue.revision ?? this.revision, failedValidation: false };
      this.nextValidationAt = this.now() + revalidationInterval;
      this.state.validationFailure = issue.message;
    }
    const retryAt = this.blocked
      ? undefined
      : issue
        ? this.now() + Math.min(maximumRetry, initialRetry * 2 ** Math.min(attempts - 1, 5))
        : regularCheckAt;
    this.state.failures[id] = { message: issue?.message ?? this.fallback, retryAt, attempts };
    this.save();
    this.options.onError?.(issue ?? new Error(this.fallback), id);
  }

  succeeded(id: string): boolean {
    if (!Object.hasOwn(this.state.failures, id)) return false;
    delete this.state.failures[id];
    return true;
  }

  diagnostic(): WorkspaceServiceDiagnostic | undefined {
    if (this.state.validationFailure)
      return {
        operation: this.operation,
        message: this.state.validationFailure,
        ...(this.nextValidationAt === 0 ? {} : { nextCheckAt: this.nextValidationAt }),
      };
    const failure = Object.values(this.state.failures).sort(
      (first, second) => (first.retryAt ?? 0) - (second.retryAt ?? 0),
    )[0];
    if (failure)
      return {
        operation: this.operation,
        message: failure.message,
        ...(failure.retryAt === undefined ? {} : { nextCheckAt: failure.retryAt }),
      };
  }
}

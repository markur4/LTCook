import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

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
  renameWorkspace(
    expected: WorkspaceMetadataSnapshot,
    title: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  renameAgent(
    expected: WorkspaceMetadataSnapshot,
    agentId: string,
    title: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}

export interface RenameSelection {
  workspace: boolean;
  agentIds: string[];
}

/** Only proposes data. Scheduling, validation, native writes, and archive remain runtime-owned. */
export interface WorkspaceMetadataGenerator {
  classify(snapshot: WorkspaceMetadataSnapshot, signal: AbortSignal): Promise<unknown>;
  rename(
    snapshot: WorkspaceMetadataSnapshot,
    selection: RenameSelection,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export const ClassificationSchema = z.strictObject({ category: WorkspaceCategorySchema });
export const RenameProposalSchema = z.strictObject({
  workspaceTitle: z.string().min(1).max(500).optional(),
  agents: z.array(z.strictObject({ id: z.string().min(1), title: z.string().min(1).max(500) })),
});

export interface WorkspaceServiceStatus {
  enabled: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  processed: number;
  diagnostic?: string;
}

export interface WorkspaceServiceOptions {
  stateFile: string;
  host: WorkspaceMetadataHost;
  generator: WorkspaceMetadataGenerator;
  enabled?: () => boolean;
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

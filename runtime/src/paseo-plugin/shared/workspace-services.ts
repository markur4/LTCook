import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const serviceStatus = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  lastRunAt: timestamp.nullable(),
  lastSuccessAt: timestamp.nullable(),
  processed: z.number().int().nonnegative(),
  diagnostic: z.string().optional(),
  diagnostics: z
    .array(
      z.object({
        operation: z.enum(['classification', 'rename', 'labels', 'archive', 'settings']),
        message: z.string(),
        nextCheckAt: timestamp.optional(),
      }),
    )
    .optional(),
});

export const WorkspaceServicesStatusSchema = z.object({
  organizer: serviceStatus,
  renamer: serviceStatus,
  autoArchive: z.boolean(),
  renameWorkspaces: z.boolean(),
  renameTabs: z.boolean(),
  archiveBlocked: z.array(z.object({ workspaceId: z.string().min(1), reason: z.string() })),
  diagnostic: z.string().optional(),
});

export const workspaceActivityRpc = defineRpc({
  name: 'ltcook.workspace.activity',
  input: z.strictObject({ workspaceId: z.string().min(1) }),
  output: z.object({ recorded: z.literal(true) }),
});

export const workspaceServicesRpc = defineRpc({
  name: 'ltcook.workspace.services',
  input: z.strictObject({}),
  output: WorkspaceServicesStatusSchema,
});

export type WorkspaceServicesStatus = z.infer<typeof WorkspaceServicesStatusSchema>;

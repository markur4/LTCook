import { z } from 'zod';

export const TeamCatalogEntrySchema = z.object({
  selection: z.string(),
  teamId: z.string(),
  name: z.string(),
  description: z.string(),
  origin: z.enum(['bundled', 'registered']).optional(),
  status: z.enum(['installed', 'available', 'invalid']),
  reason: z.string().optional(),
  leader: z.object({ key: z.string(), name: z.string() }),
  persistentMembers: z.number().int().nonnegative(),
  temporaryMembers: z.number().int().nonnegative(),
});

export const TeamCatalogRequestSchema = z.object({});
export const TeamCatalogResponseSchema = z.object({ teams: z.array(TeamCatalogEntrySchema) });
export type TeamCatalogEntry = z.infer<typeof TeamCatalogEntrySchema>;

export const SessionListRequestSchema = z.object({
  workspaceRoot: z.string().min(1),
  teamSelection: z.string().optional(),
});

export const SessionListEntrySchema = z.object({
  sessionId: z.string().min(1),
  teamId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  leaderAgentId: z.string().min(1),
  createdAt: z.string(),
  title: z.string().nullable().optional(),
  status: z.string().optional(),
  lastActivityAt: z.string().nullable().optional(),
});

export const SessionListResponseSchema = z.object({ sessions: z.array(SessionListEntrySchema) });
export type SessionListEntry = z.infer<typeof SessionListEntrySchema>;

export const SessionOpenRequestSchema = z.object({
  workspaceRoot: z.string().min(1),
  teamSelection: z.string().min(1),
  leaderAgentId: z.string().min(1).optional(),
  newSession: z.boolean().optional(),
});
export type SessionOpenRequest = z.infer<typeof SessionOpenRequestSchema>;

export const SessionOpenResponseSchema = z.object({
  sessionId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  leaderAgentId: z.string().min(1),
});
export type SessionOpenResponse = z.infer<typeof SessionOpenResponseSchema>;

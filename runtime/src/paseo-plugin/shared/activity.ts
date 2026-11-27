import { defineRpc, defineSubscription } from '@getpaseo/plugin';
import { z } from 'zod';

const id = z.string().min(1);
const count = z.number().int().nonnegative();
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);

const contextUsage = z.object({
  usedTokens: count,
  budgetTokens: count.positive(),
  observedAt: timestamp,
  estimated: z.boolean().optional(),
});
const worktree = z.object({
  id,
  name: z.string(),
  path: z.string(),
});
export const ActivityAnchorSchema = z.object({
  epoch: id,
  position: count,
  kind: z.enum(['message', 'tool']),
  id,
  at: timestamp,
  turnId: id.optional(),
});

const toolCall = z.object({
  id,
  name: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  durationMs: z.number().nonnegative().optional(),
  status: z.enum(['running', 'success', 'failed', 'cancelled', 'unknown']),
  target: ActivityAnchorSchema.optional(),
  skillId: id.optional(),
  skillDocumentAvailable: z.boolean().optional(),
});
const skillLoad = z.object({
  id,
  name: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
  loadedAt: timestamp,
  occurrences: z.array(ActivityAnchorSchema).default([]),
  documentAvailable: z.boolean().optional(),
});
const agentActivity = z.object({
  id,
  name: z.string(),
  task: z.string().optional(),
  worktree: worktree.nullable(),
  status: z.enum(['running', 'finished', 'idle', 'waiting', 'failed', 'unknown']),
  updatedAt: timestamp,
  context: contextUsage.nullable(),
  tools: z.array(toolCall).nullable(),
  skills: z.array(skillLoad).nullable(),
  canOpenConversation: z.boolean(),
});
export const RagIndexActivitySchema = z.enum([
  'idle',
  'queued',
  'indexing',
  'updating',
  'paused',
  'retrying',
  'error',
  'unknown',
]);

const ragStatus = z.object({
  indexingEnabled: z.boolean().nullable(),
  worktree: worktree.nullable(),
  provider: z.string(),
  availability: z.enum(['ready', 'not-ready', 'unavailable', 'unknown']),
  activity: RagIndexActivitySchema,
  diagnostic: z.string().optional(),
  publishedAt: z.string().optional(),
  retryAt: z.string().optional(),
});
const handoff = z.object({
  at: timestamp,
  bytes: count,
  sourceName: z.string().nullable(),
  aab: count,
});

export const ActivitySnapshotSchema = z.object({
  selectedAgentId: id,
  revision: count,
  capturedAt: timestamp,
  agent: agentActivity,
  subagents: z.array(agentActivity).nullable(),
  rag: ragStatus,
  lastHandoff: handoff.nullable(),
  activityScopeLabel: z.string(),
});

export const activitySubscription = defineSubscription({
  name: 'ltcook.activity',
  input: z.object({ agentId: id }),
  event: ActivitySnapshotSchema,
});

export const activityToggleRpc = defineRpc({
  name: 'ltcook.activity.toggle',
  input: z.strictObject({ feature: z.literal('rag-index'), enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean() }),
});

export const TURN_SKILLS_TIMELINE_KIND = 'turn-skills';
export const TurnSkillsTimelineSchema = z.object({ skills: z.array(skillLoad).min(1) });

export const activitySkillDocumentRpc = defineRpc({
  name: 'ltcook.activity.skill-document',
  input: z.object({
    agentId: id,
    skillId: id,
    occurrence: ActivityAnchorSchema.optional(),
    view: z.enum(['preview', 'full']),
  }),
  output: z.object({ name: id, markdown: z.string() }),
});

export type ActivitySnapshot = z.infer<typeof ActivitySnapshotSchema>;
export type AgentActivity = z.infer<typeof agentActivity>;
export type ContextUsage = z.infer<typeof contextUsage>;
export type RagStatus = z.infer<typeof ragStatus>;
export type ActivityAnchor = z.infer<typeof ActivityAnchorSchema>;
export type ToolCall = z.infer<typeof toolCall>;
export type SkillLoad = z.infer<typeof skillLoad>;

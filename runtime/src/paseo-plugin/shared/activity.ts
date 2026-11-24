import { defineSubscription } from '@getpaseo/plugin';
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
const toolCall = z.object({
  id,
  name: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  durationMs: z.number().nonnegative().optional(),
  status: z.enum(['running', 'success', 'failed', 'cancelled', 'unknown']),
});
const skillLoad = z.object({
  id,
  name: z.string(),
  description: z.string().optional(),
  preview: z.string().optional(),
  loadedAt: timestamp,
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
const ragStatus = z.object({
  worktree: worktree.nullable(),
  provider: z.string(),
  availability: z.enum(['ready', 'not-ready', 'unavailable', 'unknown']),
  activity: z.enum(['idle', 'checking', 'indexing', 'updating', 'interrupted', 'error', 'unknown']),
  diagnostic: z.string().optional(),
});
const memoryCount = z.object({ inContext: count.nullable(), stored: count.nullable() });
const sessionMemoryStatus = z.object({
  scopeLabel: z.string(),
  sourceLabel: z.string().optional(),
  recipientLabel: z.string().optional(),
  lastDelivery: z
    .object({
      at: timestamp,
      bytes: count,
      uamp: count,
      aab: count,
    })
    .optional(),
  context: contextUsage.nullable(),
  contextStage: z.enum(['assembled', 'delivered', 'unknown']),
  summarization: z.enum([
    'summarizing',
    'queued',
    'up-to-date',
    'below-threshold',
    'failed',
    'disabled',
    'unknown',
  ]),
  lastSummaryAt: timestamp.nullable(),
  pendingUamp: count.nullable(),
  pendingAab: count.nullable(),
  uamp: memoryCount,
  aab: memoryCount,
  diagnostic: z.string().optional(),
});

export const ActivitySnapshotSchema = z.object({
  selectedAgentId: id,
  revision: count,
  capturedAt: timestamp,
  agent: agentActivity,
  subagents: z.array(agentActivity).nullable(),
  rag: ragStatus,
  memory: sessionMemoryStatus,
  activityScopeLabel: z.string(),
});

export const activitySubscription = defineSubscription({
  name: 'ltcook.activity',
  input: z.object({ agentId: id }),
  event: ActivitySnapshotSchema,
});

export type ActivitySnapshot = z.infer<typeof ActivitySnapshotSchema>;
export type AgentActivity = z.infer<typeof agentActivity>;
export type ContextUsage = z.infer<typeof contextUsage>;
export type RagStatus = z.infer<typeof ragStatus>;
export type SessionMemoryStatus = z.infer<typeof sessionMemoryStatus>;
export type ToolCall = z.infer<typeof toolCall>;
export type SkillLoad = z.infer<typeof skillLoad>;

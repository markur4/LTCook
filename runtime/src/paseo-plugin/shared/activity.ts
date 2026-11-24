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
export const MemoryUnitCountsSchema = z.object({ uamp: count, aab: count });
const sessionMemoryStatus = z.object({
  cpuOnly: z.boolean().nullable(),
  lastHandoff: z
    .object({
      at: timestamp,
      bytes: count,
      sourceName: z.string().nullable(),
      summaries: MemoryUnitCountsSchema,
    })
    .nullable(),
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
  stored: MemoryUnitCountsSchema.nullable(),
  pending: MemoryUnitCountsSchema.nullable(),
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

const memoryDevice = z.object({ cpuOnly: z.boolean() });
export const memoryDeviceRpc = defineRpc({
  name: 'ltcook.activity.memory-device',
  input: memoryDevice,
  output: memoryDevice,
});

const summaryCursor = z.object({ epoch: id, position: count, id });
export const storedSummariesRpc = defineRpc({
  name: 'ltcook.activity.stored-summaries',
  input: z.object({ agentId: id, before: summaryCursor.optional() }),
  output: z.object({
    summaries: z.array(
      z.object({
        id,
        type: z.enum(['UAMP', 'AAB']),
        createdAt: z.string(),
        parts: z.array(z.object({ text: z.string(), sources: z.array(count) })),
      }),
    ),
    next: summaryCursor.nullable(),
  }),
});

export type StoredSummariesPage = z.infer<typeof storedSummariesRpc.output>;
export type ActivitySnapshot = z.infer<typeof ActivitySnapshotSchema>;
export type AgentActivity = z.infer<typeof agentActivity>;
export type ContextUsage = z.infer<typeof contextUsage>;
export type RagStatus = z.infer<typeof ragStatus>;
export type MemoryUnitCounts = z.infer<typeof MemoryUnitCountsSchema>;
export type SessionMemoryStatus = z.infer<typeof sessionMemoryStatus>;
export type ToolCall = z.infer<typeof toolCall>;
export type SkillLoad = z.infer<typeof skillLoad>;

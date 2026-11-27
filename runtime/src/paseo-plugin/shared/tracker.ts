import { defineRpc, defineSubscription } from '@getpaseo/plugin';
import { z } from 'zod';

const id = z.string().min(1);
const selection = z.strictObject({ agentId: id });
const cursor = {
  epoch: id,
  seq: z.number().int().nonnegative(),
};
const source = z.object({
  ...cursor,
  messageId: id.optional(),
  author: z.enum(['user', 'agent']).optional(),
  timestamp: z.string().optional(),
  attachmentIds: z.array(id).optional(),
});
export const trackerFields = {
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(8000),
};
export const trackedItemText = z.string().trim().min(1).max(12000);
const modification = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('add'), ...trackerFields }),
  z.strictObject({ type: z.literal('edit'), id, ...trackerFields }),
  z.strictObject({ type: z.literal('enable'), id, enabled: z.boolean() }),
  z.strictObject({ type: z.literal('remove'), id }),
  z.strictObject({ type: z.literal('pause'), paused: z.boolean() }),
  z.strictObject({ type: z.literal('retry'), trackerId: id, source: z.strictObject(cursor) }),
  z.strictObject({ type: z.literal('skip'), trackerId: id, source: z.strictObject(cursor) }),
  z.strictObject({
    type: z.literal('item'),
    trackerId: id,
    itemId: id,
    text: trackedItemText.nullable(),
  }),
]);

export const TrackerSnapshotSchema = z.object({
  paused: z.boolean(),
  historyUnavailable: z.boolean(),
  startsAfter: z.number().int().nonnegative().nullable(),
  mode: z.enum(['hosted', 'local']),
  trackers: z.array(
    z.object({
      id,
      name: z.string(),
      instructions: z.string(),
      enabled: z.boolean(),
      items: z.array(
        z.object({
          id,
          text: z.string(),
          manual: z.boolean(),
          sources: z.array(source),
          evidenceUnavailable: z.boolean(),
        }),
      ),
    }),
  ),
  events: z.array(
    z.object({
      source,
      trackers: z.array(
        z.object({
          trackerId: id,
          status: z.enum([
            'pending',
            'changes',
            'no-change',
            'incomplete',
            'failed',
            'paused',
            'skipped',
          ]),
          reason: z
            .enum([
              'budget',
              'source',
              'changed',
              'configuration',
              'authentication',
              'transient',
              'output',
            ])
            .optional(),
          detail: z.string().optional(),
        }),
      ),
    }),
  ),
});

export type TrackerSnapshot = z.infer<typeof TrackerSnapshotSchema>;
export type TrackerModification = z.infer<typeof modification>;
export const trackerSelection = selection;
export const trackerSubscription = defineSubscription({
  name: 'ltcook.tracker.snapshot',
  input: selection,
  event: TrackerSnapshotSchema,
});
export const trackerModifyRpc = defineRpc({
  name: 'ltcook.tracker.modify',
  input: selection.extend({ modification }),
  output: TrackerSnapshotSchema,
});

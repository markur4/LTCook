import { defineSubscription } from '@getpaseo/plugin';
import { z } from 'zod';
import { bugScanActivity } from './activity.js';

export const BUG_HUNTER_AGENT_METADATA = 'ltcook.bughunter';

const id = z.string().min(1).max(1024);
const conversation = z.object({
  id,
  role: z.string(),
  stage: z.enum(['scan', 'fix']),
  archived: z.boolean().optional(),
});

export type BugHunterConversation = z.infer<typeof conversation>;

const finding = bugScanActivity.shape.findings.element.extend({
  expectedBehavior: z.string(),
  mechanism: z.string(),
  acceptanceCriteria: z.array(z.string()),
});

const hunt = bugScanActivity.pick({ fix: true, failure: true }).extend({
  id,
  createdAt: z.number().finite().nonnegative(),
  automatic: z.boolean(),
  status: bugScanActivity.shape.status,
  components: z.array(z.string()),
  findings: z.array(finding),
  conversations: z.array(conversation),
});

export const bugHunterDetailsSchema = z.object({
  available: z.boolean(),
  enabled: z.boolean().optional(),
  hunts: z.array(hunt),
});

export const bugHunterSubscription = defineSubscription({
  name: 'ltcook.bughunter.history',
  input: z.strictObject({ workspaceId: id, huntId: id.optional(), agentId: id.optional() }),
  event: bugHunterDetailsSchema.extend({
    chat: z
      .object({
        agentId: id,
        unavailable: z.boolean().optional(),
        archived: z.boolean().optional(),
        messages: z.array(z.object({ id, role: z.enum(['user', 'assistant']), text: z.string() })),
      })
      .optional(),
  }),
});

export type BugHunterSnapshot = z.infer<typeof bugHunterSubscription.event>;

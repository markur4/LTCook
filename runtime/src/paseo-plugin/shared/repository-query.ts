import { defineSubscription } from '@getpaseo/plugin';
import { z } from 'zod';

export const repositoryQuerySubscription = defineSubscription({
  name: 'ltcook.activity.repository-query',
  input: z.strictObject({
    agentId: z.string().min(1).max(1024),
    workspaceIdentity: z.string().min(1).max(1024),
    request: z.strictObject({
      tool: z.enum(['search', 'locate']),
      input: z.record(z.string(), z.json()),
    }),
  }),
  event: z.object({ text: z.string() }),
});

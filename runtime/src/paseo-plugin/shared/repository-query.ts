import { defineSubscription } from '@getpaseo/plugin';
import { z } from 'zod';

const entityId = z.string().min(1).max(1024);
const query = z.strictObject({
  workspaceIdentity: entityId,
  request: z.strictObject({
    tool: z.enum(['search', 'locate']),
    input: z.record(z.string(), z.json()),
  }),
});

export const repositoryAgentQueryInput = query.extend({ agentId: entityId });
export const repositoryWorkspaceQueryInput = query.extend({ workspaceId: entityId });

export const repositoryQueryWorkspaceSubscription = defineSubscription({
  name: 'ltcook.activity.repository-query-workspace',
  input: z.strictObject({ workspaceId: entityId }),
  event: z.object({ identity: entityId, path: z.string().min(1) }).nullable(),
});

export const repositoryQuerySubscription = defineSubscription({
  name: 'ltcook.activity.repository-query',
  input: z.union([repositoryAgentQueryInput, repositoryWorkspaceQueryInput]),
  event: z.object({ text: z.string() }),
});

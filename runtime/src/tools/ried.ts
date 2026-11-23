import { Type } from 'typebox';
import type { RiedService } from '../repository/discovery.js';
import { riedInputSchema } from '../repository/requests.js';
import { defineTool } from './types.js';

export const riedToolDefinition = {
  name: 'ltcook_ried',
  description:
    'Read workspace inventory, current Git details, a bounded directory map, or a targeted source outline. Only the outline reads source contents for the response.',
  inputSchema: riedInputSchema,
  outputSchema: Type.Object({
    value: Type.Object(
      {
        schemaVersion: Type.Literal(1),
        workspaceRoot: Type.String(),
        capturedAt: Type.String(),
        status: Type.Union([Type.Literal('fresh'), Type.Literal('partial'), Type.Literal('stale')]),
        diagnostics: Type.Array(Type.String()),
      },
      { additionalProperties: true },
    ),
  }),
};

export function createRiedTool(ried: RiedService) {
  return defineTool({
    ...riedToolDefinition,
    async execute(input, context) {
      return {
        value: await ried.get(
          { id: context.agentId, workspaceRoot: context.workspaceRoot },
          input,
          context.workspaceFileAccess,
        ),
      };
    },
  });
}

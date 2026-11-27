import { Type } from 'typebox';
import type { RiedService } from '../repository/discovery.js';
import { riedInputSchema } from '../repository/requests.js';
import { RepositoryDiagnosticSchema, RepositoryFreshnessSchema } from '../repository/results.js';
import { RepositoryFilterReportSchema } from '../repository/filter.js';
import { defineTool } from './types.js';

export const riedToolDefinition = {
  name: 'ltcook_ried',
  description:
    'Read workspace inventory, current Git details, a bounded directory map, or a targeted source outline. On maps, directory outlines, repository or recipe sections, and detailed Git sections, filter supports includePaths and excludePaths with workspace-relative globs.',
  inputSchema: riedInputSchema,
  outputSchema: Type.Object({
    value: Type.Object(
      {
        schemaVersion: Type.Literal(1),
        workspaceRoot: Type.String(),
        provider: Type.String(),
        capturedAt: Type.String(),
        freshness: RepositoryFreshnessSchema,
        partial: Type.Boolean(),
        truncated: Type.Boolean(),
        status: Type.Union([Type.Literal('fresh'), Type.Literal('partial'), Type.Literal('stale')]),
        diagnostics: Type.Array(Type.String()),
        diagnosticDetails: Type.Array(RepositoryDiagnosticSchema),
        filter: Type.Optional(RepositoryFilterReportSchema),
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

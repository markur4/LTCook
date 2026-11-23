import { Type } from 'typebox';
import {
  COLGREP_MAX_RESULTS,
  ColgrepHitSchema,
  createColgrepProvider,
} from '../repository/providers/colgrep.js';
import { defineTool } from './types.js';

export { REPO_SEARCH_TIMEOUT_MS } from '../paseo-plugin/shared/workspace-tools.js';
export const REPO_SEARCH_TOOL_NAME = 'ltcook_repo_search';

export function createRepoSearchTool(provider = createColgrepProvider()) {
  return defineTool({
    name: REPO_SEARCH_TOOL_NAME,
    description: 'Find relevant code in the authorized local workspace using ColGREP.',
    inputSchema: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 1024 }),
        mode: Type.Optional(Type.Union([Type.Literal('hybrid'), Type.Literal('semantic')])),
        pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
        paths: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 12 }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: COLGREP_MAX_RESULTS })),
      },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object({
      status: Type.Union([Type.Literal('ready'), Type.Literal('indexing')]),
      results: Type.Optional(Type.Array(ColgrepHitSchema)),
      hint: Type.Optional(Type.String()),
    }),
    async execute(input, context) {
      if (!context.repositorySearchAccess) {
        throw new Error('Repository search is unavailable for this session.');
      }
      const outcome = await provider.search({ root: context.workspaceRoot }, input, context.signal);
      if (outcome.value.status === 'indexing')
        return { status: 'indexing' as const, hint: outcome.diagnostics[0]?.message };
      return { status: 'ready' as const, results: outcome.value.hits };
    },
  });
}

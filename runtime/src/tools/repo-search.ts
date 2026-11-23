import { Type } from 'typebox';
import { COLGREP_MAX_RESULTS, createColgrepProvider } from '../repository/providers/colgrep.js';
import {
  RepositoryDiagnosticSchema,
  RepositoryFreshnessSchema,
  RepositoryHitSchema,
  RepositoryRetrievalKindSchema,
  RepositoryRetrievalStatusSchema,
} from '../repository/results.js';
import { openRepositoryWorkspace } from '../repository/workspace.js';
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
      status: RepositoryRetrievalStatusSchema,
      results: Type.Optional(Type.Array(RepositoryHitSchema)),
      hint: Type.Optional(Type.String()),
      provider: Type.String(),
      kind: RepositoryRetrievalKindSchema,
      diagnostics: Type.Array(RepositoryDiagnosticSchema),
      freshness: RepositoryFreshnessSchema,
      capturedAt: Type.String(),
      partial: Type.Boolean(),
      truncated: Type.Boolean(),
    }),
    async execute(input, context) {
      if (!context.repositorySearchAccess) {
        throw new Error('Repository search is unavailable for this session.');
      }
      const workspace = await openRepositoryWorkspace(context.workspaceRoot).catch(() => undefined);
      if (workspace?.root !== context.workspaceRoot)
        throw new Error('The authorized workspace is unavailable.');
      const { value, ...metadata } = await provider.search(workspace, input, context.signal);
      const { status, kind, hits } = value;
      return {
        ...metadata,
        kind,
        status,
        ...(status === 'ready' ? { results: hits } : { hint: metadata.diagnostics[0]?.message }),
      };
    },
  });
}

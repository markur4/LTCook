import { Type, type Static } from 'typebox';
import { REPO_SEARCH_TOOL_NAME } from '../paseo-plugin/shared/workspace-tools.js';
import { assertRepositoryPathVisible, isRepositoryPathVisible } from '../repository/filesystem.js';
import { COLGREP_MAX_RESULTS, createColgrepProvider } from '../repository/providers/colgrep.js';
import { createRipgrepProvider } from '../repository/providers/ripgrep.js';
import {
  RepositoryDiagnosticSchema,
  RepositoryFreshnessSchema,
  RepositoryHitSchema,
  RepositoryRetrievalKindSchema,
  RepositoryRetrievalStatusSchema,
} from '../repository/results.js';
import { openRepositoryWorkspace, type RepositoryWorkspace } from '../repository/workspace.js';
import { defineTool, type ToolContext } from './types.js';

export {
  REPO_SEARCH_TIMEOUT_MS,
  REPO_SEARCH_TOOL_NAME,
} from '../paseo-plugin/shared/workspace-tools.js';

export const RepositorySearchPathsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 1024 }),
  { maxItems: 12 },
);

const RepositorySearchInputSchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 1024 }),
    mode: Type.Optional(
      Type.Union([
        Type.Literal('hybrid'),
        Type.Literal('semantic'),
        Type.Literal('exact'),
        Type.Literal('literal'),
        Type.Literal('regex'),
      ]),
    ),
    pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    paths: Type.Optional(RepositorySearchPathsSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: COLGREP_MAX_RESULTS })),
  },
  { additionalProperties: false },
);

export const RepositorySearchOutputSchema = Type.Object({
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
});

export async function openAuthorizedSearchWorkspace(
  context: ToolContext,
): Promise<RepositoryWorkspace> {
  if (!context.repositorySearchAccess)
    throw new Error('Repository search is unavailable for this session.');
  const workspace = await openRepositoryWorkspace(context.workspaceRoot).catch(() => undefined);
  if (workspace?.root !== context.workspaceRoot)
    throw new Error('The authorized workspace is unavailable.');
  return workspace;
}

export function createRepoSearchTool(
  colgrep = createColgrepProvider(),
  ripgrep = createRipgrepProvider(),
) {
  async function search(
    workspace: RepositoryWorkspace,
    input: Static<typeof RepositorySearchInputSchema>,
    signal: AbortSignal,
  ): Promise<Static<typeof RepositorySearchOutputSchema>> {
    signal.throwIfAborted();
    await workspace.assertUnchanged();
    const { mode, pattern, query, paths, limit = 8 } = input;
    const lexical = mode === 'exact' || mode === 'literal' || mode === 'regex';
    if (lexical && pattern !== undefined)
      throw new Error('Use query for lexical search. Pattern is a filter for ranked modes.');
    for (const requested of paths ?? []) {
      const { relative } = await workspace.resolvePath(requested, { allowRoot: true });
      assertRepositoryPathVisible(relative);
    }
    const { value, ...metadata } = await (lexical
      ? ripgrep.search(workspace, { query, mode, paths, limit }, signal)
      : colgrep.search(workspace, { query, mode, pattern, paths, limit }, signal));
    const { status, kind, hits } = value;
    const results = hits.filter(({ path }) => isRepositoryPathVisible(path));
    if (results.length < hits.length) {
      metadata.partial = true;
      metadata.diagnostics = [
        ...metadata.diagnostics,
        {
          source: 'repository',
          code: 'excluded-path',
          message: 'Some matches were excluded from the repository search scope.',
        },
      ];
    }
    return {
      ...metadata,
      kind,
      status,
      ...(status === 'ready' ? { results } : { hint: metadata.diagnostics[0]?.message }),
    };
  }

  return {
    ...defineTool({
      name: REPO_SEARCH_TOOL_NAME,
      description:
        'Search the authorized local workspace. Use exact for whole identifiers, literal for substrings, regex for patterns, and hybrid or semantic for ranked conceptual matches.',
      inputSchema: RepositorySearchInputSchema,
      outputSchema: RepositorySearchOutputSchema,
      async execute(input, context) {
        return search(await openAuthorizedSearchWorkspace(context), input, context.signal);
      },
    }),
    search,
  };
}

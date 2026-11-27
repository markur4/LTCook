import { Type, type Static } from 'typebox';
import { REPO_SEARCH_TOOL_NAME } from './workspace-tools.js';
import { RepositorySourceReader } from '../repository/evidence.js';
import { assertRepositoryPathVisible, isRepositoryPathVisible } from '../repository/filesystem.js';
import { COLGREP_MAX_RESULTS, createColgrepProvider } from '../repository/providers/colgrep.js';
import { createRipgrepProvider, type RipgrepCollection } from '../repository/providers/ripgrep.js';
import {
  RepositoryDiagnosticSchema,
  RepositoryFreshnessSchema,
  RepositoryHitSchema,
  RepositoryRetrievalKindSchema,
  RepositoryRetrievalStatusSchema,
} from '../repository/results.js';
import {
  repositorySearchPriority,
  type RepositorySearchPriority,
} from '../repository/search-priority.js';
import { openRepositoryWorkspace, type RepositoryWorkspace } from '../repository/workspace.js';
import { defineTool, type ToolContext } from './types.js';

export { REPO_SEARCH_TIMEOUT_MS, REPO_SEARCH_TOOL_NAME } from './workspace-tools.js';

export const repositoryEvidenceGuidance =
  ' Cite the exact supporting numbered lines for each claim. Search again only to close a specific evidence gap. A ready, complete empty response means this search found no matches. Partial, unavailable, or indexing results can leave the evidence unresolved.';

export const RepositorySearchPathsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 1024 }),
  { maxItems: 12 },
);

export const RepositorySearchBaseSchema = Type.String({ minLength: 1, maxLength: 512 });

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
    base: Type.Optional(RepositorySearchBaseSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: COLGREP_MAX_RESULTS })),
  },
  { additionalProperties: false },
);

export const RepositorySearchOutputSchema = Type.Object({
  status: RepositoryRetrievalStatusSchema,
  base: Type.Optional(Type.Object({ reference: Type.String(), commit: Type.String() })),
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
  const workspace =
    context.repositoryWorkspace ??
    (await openRepositoryWorkspace(context.workspaceRoot).catch(() => undefined));
  if (workspace?.root !== context.workspaceRoot)
    throw new Error('The authorized workspace is unavailable.');
  if (context.repositoryWorkspace) await workspace.assertUnchanged();
  return workspace;
}

function fallbackPattern(query: string, pattern: string | undefined): string | undefined {
  if (pattern) return pattern;
  const words = query.match(/[\p{L}\p{N}_]{3,}/gu);
  return words ? [...new Set(words)].slice(0, 6).join('|') : undefined;
}

export function createRepoSearchTool(
  colgrep = createColgrepProvider(),
  ripgrep = createRipgrepProvider(),
) {
  async function search(
    workspace: RepositoryWorkspace,
    input: Static<typeof RepositorySearchInputSchema>,
    signal: AbortSignal,
    options: {
      source?: RepositorySourceReader;
      collection?: RipgrepCollection;
      priority?: RepositorySearchPriority;
      updateIndex?: boolean;
    } = {},
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
    const source = options.source ?? new RepositorySourceReader(workspace);
    const priority =
      options.priority ??
      (input.base === undefined
        ? undefined
        : await repositorySearchPriority(workspace, input.base, signal));
    const prioritize = priority?.prioritize;
    const collection = prioritize ? { ...options.collection, prioritize } : options.collection;
    let retrieval = await (lexical
      ? ripgrep.search(workspace, { query, mode, paths, limit }, signal, source, collection)
      : colgrep.search(
          workspace,
          {
            query,
            mode,
            pattern,
            paths,
            limit: prioritize ? COLGREP_MAX_RESULTS : limit,
            updateIndex: options.updateIndex,
          },
          signal,
          source,
        ));
    if (
      !lexical &&
      mode !== 'semantic' &&
      options.updateIndex !== false &&
      retrieval.value.status !== 'ready' &&
      retrieval.diagnostics.some(({ code }) =>
        ['indexing', 'index-unavailable', 'index-recovery'].includes(code),
      )
    ) {
      const queryPattern = fallbackPattern(query, pattern);
      if (queryPattern) {
        const fallback = await ripgrep.search(
          workspace,
          { query: queryPattern, mode: 'regex', paths, limit },
          signal,
          source,
          collection,
        );
        if (fallback.value.status === 'ready') {
          retrieval = {
            ...fallback,
            partial: true,
            diagnostics: [
              ...retrieval.diagnostics,
              ...fallback.diagnostics,
              {
                source: 'repository',
                code: 'lexical-fallback',
                message: 'Ranked search is unavailable. These are approximate lexical matches.',
              },
            ],
          };
        }
      }
    }
    const { value, ...metadata } = retrieval;
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
    if (prioritize) {
      results.sort(
        (first, second) => Number(prioritize(second.path)) - Number(prioritize(first.path)),
      );
    }
    if (!options.collection && results.length > limit) {
      results.length = limit;
      metadata.truncated = true;
    }
    if (priority) {
      metadata.partial ||= priority.partial;
      metadata.diagnostics = [...metadata.diagnostics, ...priority.diagnostics];
    }
    return {
      ...metadata,
      ...(priority?.base ? { base: priority.base } : {}),
      kind,
      status,
      ...(status === 'ready' ? { results } : { hint: metadata.diagnostics[0]?.message }),
    };
  }

  return {
    ...defineTool({
      name: REPO_SEARCH_TOOL_NAME,
      description:
        'Search the authorized local workspace. Use semantic for conceptual queries when common words produce irrelevant keyword matches. Semantic ranks by meaning alone and reports index unavailability directly. Hybrid combines semantic and keyword signals. Use exact for whole identifiers, literal for substrings, and regex for patterns. Optionally supply base (a local Git ref) to prioritize changed paths and matching test names within the results.' +
        repositoryEvidenceGuidance,
      inputSchema: RepositorySearchInputSchema,
      outputSchema: RepositorySearchOutputSchema,
      async execute(input, context) {
        return search(await openAuthorizedSearchWorkspace(context), input, context.signal);
      },
    }),
    search,
  };
}

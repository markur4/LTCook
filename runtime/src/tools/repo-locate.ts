import { Type, type Static } from 'typebox';
import {
  REPO_LOCATE_TOOL_NAME,
  REPO_SEARCH_TIMEOUT_MS,
} from '../paseo-plugin/shared/workspace-tools.js';
import type { RepositoryHit } from '../repository/results.js';
import {
  createRepoSearchTool,
  openAuthorizedSearchWorkspace,
  RepositorySearchOutputSchema,
  RepositorySearchPathsSchema,
} from './repo-search.js';
import { defineTool } from './types.js';

export { REPO_LOCATE_TOOL_NAME } from '../paseo-plugin/shared/workspace-tools.js';

const LocateSearch = Type.Object({
  ...RepositorySearchOutputSchema.properties,
  query: Type.String(),
  mode: Type.Union([Type.Literal('exact'), Type.Literal('hybrid')]),
});

const LocateOutput = Type.Object({
  searches: Type.Array(LocateSearch),
  followUp: Type.Union([
    Type.Literal('not-needed'),
    Type.Literal('attempted'),
    Type.Literal('no-verified-symbol'),
    Type.Literal('initial-unavailable'),
    Type.Literal('deadline'),
    Type.Literal('failed'),
  ]),
});

function verifiedIdentifier(hits: RepositoryHit[]): string | undefined {
  for (const { name, excerpt, excerptTruncated } of hits) {
    if (excerptTruncated || !name || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) continue;
    const identifier = new RegExp(
      `(?:^|[^\\p{L}\\p{M}\\p{N}_$])${name}(?![\\p{L}\\p{M}\\p{N}_$])`,
      'u',
    );
    if (identifier.test(excerpt)) return name;
  }
}

export function createRepoLocateTool(
  { search }: Pick<ReturnType<typeof createRepoSearchTool>, 'search'> = createRepoSearchTool(),
) {
  return defineTool({
    name: REPO_LOCATE_TOOL_NAME,
    description:
      'Locate verified source candidates for implementations, callers, and tests. Supply a known symbol or describe the behavior to find. Returns evidence for you to interpret.',
    inputSchema: Type.Object(
      {
        symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        paths: Type.Optional(RepositorySearchPathsSchema),
      },
      { additionalProperties: false },
    ),
    outputSchema: LocateOutput,
    async execute(input, context): Promise<Static<typeof LocateOutput>> {
      const query = (input.symbol ?? input.query)?.trim();
      if (
        (input.symbol === undefined) === (input.query === undefined) ||
        !query ||
        /[\0\r\n]/.test(query)
      )
        throw new Error('Supply exactly one nonempty, single-line symbol or query.');
      const deadline = AbortSignal.timeout(REPO_SEARCH_TIMEOUT_MS);
      const signal = AbortSignal.any([context.signal, deadline]);
      const workspace = await openAuthorizedSearchWorkspace(context);
      const searches: Static<typeof LocateSearch>[] = [];
      const mode = input.symbol === undefined ? 'hybrid' : 'exact';
      const run = async (mode: 'hybrid' | 'exact', query: string) => {
        const result = await search(workspace, { query, mode, paths: input.paths }, signal);
        await workspace.assertUnchanged();
        searches.push({ mode, query, ...result });
        return result;
      };
      let initial;
      try {
        initial = await run(mode, query);
      } catch (error) {
        context.signal.throwIfAborted();
        if (!deadline.aborted) throw error;
        await workspace.assertUnchanged();
        return { searches, followUp: 'deadline' };
      }
      if (mode === 'exact') return { searches, followUp: 'not-needed' };
      if (initial.status !== 'ready') return { searches, followUp: 'initial-unavailable' };
      const identifier = verifiedIdentifier(initial.results ?? []);
      if (!identifier) return { searches, followUp: 'no-verified-symbol' };
      try {
        await run('exact', identifier);
        return { searches, followUp: 'attempted' };
      } catch {
        context.signal.throwIfAborted();
        await workspace.assertUnchanged();
        return { searches, followUp: deadline.aborted ? 'deadline' : 'failed' };
      }
    },
  });
}

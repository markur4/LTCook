import { Type, type Static } from 'typebox';
import {
  REPO_LOCATE_TOOL_NAME,
  REPO_SEARCH_TIMEOUT_MS,
} from '../paseo-plugin/shared/workspace-tools.js';
import { verifySourceEvidence } from '../repository/evidence.js';
import { RepositoryHitSchema, type RepositoryHit } from '../repository/results.js';
import type { RepositoryWorkspace } from '../repository/workspace.js';
import {
  createRepoSearchTool,
  openAuthorizedSearchWorkspace,
  repositoryEvidenceGuidance,
  RepositorySearchOutputSchema,
  RepositorySearchPathsSchema,
} from './repo-search.js';
import { defineTool } from './types.js';

export { REPO_LOCATE_TOOL_NAME } from '../paseo-plugin/shared/workspace-tools.js';

const LocateHit = Type.Object({
  ...RepositoryHitSchema.properties,
  role: Type.Union([
    Type.Literal('definition'),
    Type.Literal('caller'),
    Type.Literal('test'),
    Type.Literal('reference'),
  ]),
});
type LocatedHit = Static<typeof LocateHit>;
const LocateSearch = Type.Object({
  ...RepositorySearchOutputSchema.properties,
  results: Type.Optional(Type.Array(LocateHit)),
  query: Type.String(),
  mode: Type.Union([Type.Literal('exact'), Type.Literal('hybrid')]),
});

const EXACT_CANDIDATES = 48;
const HITS_PER_ROLE = 3;
const CONTEXT_LINES = 2;

function evidenceRole(hit: RepositoryHit, symbol: string | undefined): LocatedHit['role'] {
  if (!symbol || !/^[\w$]+$/.test(symbol) || hit.excerptTruncated) return 'reference';
  if (!/\.(?:[cm]?[jt]sx?|pyi?)$/.test(hit.path)) return 'reference';
  const identifier = symbol.replaceAll('$', '\\$');
  const declaration = new RegExp(
    `^\\s*(?:(?:export|default|declare|abstract|async)\\s+)*(?:function\\b\\s*\\*?\\s*|(?:class|interface|type|enum|const|let|var|def)\\s+)${identifier}(?![\\w$])`,
  );
  const call = new RegExp(
    `(?:^|[=(:,>]|\\b(?:return|await|yield)\\s+)\\s*(?:[\\w$]+\\.)*${identifier}\\s*\\(`,
  );
  const line = hit.excerpt.split('\n', 1)[0]!;
  if (declaration.test(line)) return 'definition';
  const code = line.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*.*|\/\/.*|#.*$/,
    '',
  );
  const method = new RegExp(
    `^\\s*(?:(?:public|private|protected|static|override|async|get|set)\\s+)*${identifier}\\s*\\([^)]*\\)\\s*(?::[^{}]+)?\\{`,
  );
  if (method.test(code)) return 'definition';
  if (!call.test(code)) return 'reference';
  return /(?:^|\/)(?:tests?|__tests__|specs?)\/|(?:^|\/)test_[^/]+$|[._-](?:test|spec)\.[^/]+$/.test(
    hit.path,
  )
    ? 'test'
    : 'caller';
}

async function groupEvidence(
  workspace: RepositoryWorkspace,
  result: Static<typeof RepositorySearchOutputSchema>,
  symbol: string | undefined,
  signal: AbortSignal,
): Promise<Static<typeof RepositorySearchOutputSchema> & { results?: LocatedHit[] }> {
  const { results, ...metadata } = result;
  if (!results) return metadata;
  const groups: Record<LocatedHit['role'], LocatedHit[]> = {
    definition: [],
    caller: [],
    test: [],
    reference: [],
  };
  for (const hit of results) {
    const role = evidenceRole(hit, symbol ?? verifiedIdentifier([hit]));
    const group = groups[role];
    if (group.length >= HITS_PER_ROLE) {
      metadata.truncated = true;
      continue;
    }
    const contextAfter =
      symbol && role !== 'reference' && hit.startLine === hit.endLine
        ? results.reduce(
            (remaining, next) =>
              next.path === hit.path && next.startLine > hit.endLine
                ? Math.min(remaining, next.startLine - hit.endLine - 1)
                : remaining,
            CONTEXT_LINES,
          )
        : 0;
    const evidence =
      contextAfter > 0
        ? await verifySourceEvidence(
            workspace,
            { path: hit.path, excerpt: hit.excerpt, ranges: [hit], contextAfter },
            signal,
          )
        : hit;
    if (typeof evidence === 'string') {
      metadata.partial = true;
      if (evidence !== 'source-unavailable') metadata.freshness = 'stale';
      if (!metadata.diagnostics.some(({ code }) => code === evidence))
        metadata.diagnostics = [
          ...metadata.diagnostics,
          {
            source: 'locate',
            code: evidence,
            message: 'A matched source excerpt could not be refreshed.',
          },
        ];
      continue;
    }
    metadata.truncated ||= evidence.excerptTruncated === true;
    group.push({ ...evidence, role });
  }
  return { ...metadata, results: Object.values(groups).flat() };
}

export const RepositoryLocateOutputSchema = Type.Object({
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
      'Locate verified source candidates grouped by definition, caller, test, and reference, with short numbered source excerpts. Supply a known symbol or describe the behavior to find.' +
      repositoryEvidenceGuidance,
    inputSchema: Type.Object(
      {
        symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        paths: Type.Optional(RepositorySearchPathsSchema),
      },
      { additionalProperties: false },
    ),
    outputSchema: RepositoryLocateOutputSchema,
    async execute(input, context): Promise<Static<typeof RepositoryLocateOutputSchema>> {
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
        const result = await search(
          workspace,
          {
            query,
            mode,
            paths: input.paths,
            ...(mode === 'exact' ? { limit: EXACT_CANDIDATES } : {}),
          },
          signal,
        );
        const grouped = await groupEvidence(
          workspace,
          result,
          mode === 'exact' ? query : undefined,
          signal,
        );
        await workspace.assertUnchanged();
        signal.throwIfAborted();
        searches.push({ mode, query, ...grouped });
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

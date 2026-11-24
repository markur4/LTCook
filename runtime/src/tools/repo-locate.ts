import { Type, type Static } from 'typebox';
import {
  REPO_LOCATE_TOOL_NAME,
  REPO_SEARCH_TIMEOUT_MS,
} from '../paseo-plugin/shared/workspace-tools.js';
import { RepositorySourceReader } from '../repository/evidence.js';
import { assertRepositoryPathVisible, isRepositoryPathVisible } from '../repository/filesystem.js';
import {
  MAX_SOURCE_EXCERPT,
  RepositoryHitSchema,
  type RepositoryHit,
} from '../repository/results.js';
import { isTestSource, repositorySearchPriority } from '../repository/search-priority.js';
import { createSourceNavigation } from '../repository/source-navigation.js';
import {
  createRepoSearchTool,
  openAuthorizedSearchWorkspace,
  repositoryEvidenceGuidance,
  RepositorySearchBaseSchema,
  RepositorySearchOutputSchema,
  RepositorySearchPathsSchema,
} from './repo-search.js';
import {
  REPOSITORY_TRACE_TIMEOUT_MS,
  RepositoryTraceInputSchema,
  RepositoryTraceOutputSchema,
  traceRepository,
  verifiedIdentifier,
} from './repo-trace.js';
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
  connections: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.Union([
          Type.Literal('import'),
          Type.Literal('re-export'),
          Type.Literal('wrapper'),
          Type.Literal('call'),
        ]),
        from: RepositoryHitSchema,
        to: RepositoryHitSchema,
      }),
    ),
  ),
  query: Type.String(),
  mode: Type.Union([Type.Literal('exact'), Type.Literal('hybrid')]),
});

const HITS_PER_ROLE = 3;
const CONTEXT_LINES = 2;

type ClassifyHit = (
  hit: Pick<RepositoryHit, 'path' | 'excerpt' | 'excerptTruncated'>,
) => LocatedHit['role'];

function classifySymbol(symbol: string | undefined): ClassifyHit {
  if (!symbol || !/^[\w$]+$/.test(symbol)) return () => 'reference';
  const identifier = symbol.replaceAll('$', '\\$');
  const declaration = new RegExp(
    `^\\s*(?:(?:export|default|declare|abstract|async)\\s+)*(?:function\\b\\s*\\*?\\s*|(?:class|interface|type|enum|const|let|var|def)\\s+)${identifier}(?![\\w$])`,
  );
  const call = new RegExp(
    `(?:^|[=(:,>]|\\b(?:return|await|yield)\\s+)\\s*(?:[\\w$]+\\.)*${identifier}\\s*\\(`,
  );
  const method = new RegExp(
    `^\\s*(?:(?:public|private|protected|static|override|async|get|set)\\s+)*${identifier}\\s*\\([^)]*\\)\\s*(?::[^{}]+)?\\{`,
  );
  return (hit) => {
    if (hit.excerptTruncated || !/\.(?:[cm]?[jt]sx?|pyi?)$/.test(hit.path)) return 'reference';
    const line = hit.excerpt.split('\n', 1)[0]!;
    if (line.length > MAX_SOURCE_EXCERPT) return 'reference';
    if (declaration.test(line)) return 'definition';
    const code = line.replace(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*.*|\/\/.*|#.*$/,
      '',
    );
    if (method.test(code)) return 'definition';
    if (!call.test(code)) return 'reference';
    return isTestSource(hit.path) ? 'test' : 'caller';
  };
}

async function groupEvidence(
  reader: RepositorySourceReader,
  result: Static<typeof RepositorySearchOutputSchema>,
  classify: ClassifyHit | undefined,
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
    const role = (classify ?? classifySymbol(verifiedIdentifier([hit])))(hit);
    const group = groups[role];
    if (group.length >= HITS_PER_ROLE) {
      metadata.truncated = true;
      continue;
    }
    const contextAfter =
      classify && role !== 'reference' && hit.startLine === hit.endLine
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
        ? await reader.verify(
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

const LineNumber = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const SourceLocation = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 1024 }),
    line: LineNumber,
    maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
  },
  { additionalProperties: false },
);

export const RepositoryLocateOutputSchema = Type.Object({
  source: Type.Optional(
    Type.Object({
      ...RepositoryHitSchema.properties,
      anchorLine: LineNumber,
      complete: Type.Boolean(),
      block: Type.Optional(
        Type.Object({
          kind: Type.Union([Type.Literal('function'), Type.Literal('class'), Type.Literal('test')]),
          startLine: LineNumber,
          endLine: LineNumber,
        }),
      ),
    }),
  ),
  trace: Type.Optional(RepositoryTraceOutputSchema),
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

export function createRepoLocateTool(
  { search }: Pick<ReturnType<typeof createRepoSearchTool>, 'search'> = createRepoSearchTool(),
) {
  return defineTool({
    name: REPO_LOCATE_TOOL_NAME,
    description:
      'For multi-file investigations use trace {question, leads?} to get verified source, connections and evidence gaps in one call. Add up to four leads {mode, query}: hybrid for separate behaviors, exact for symbols, literal for routes and setting names. For quick lookups use symbol, symbols, query, or location {path, line, maxLines}. Set follow to true on quick symbol lookups for one verified local connection. Optionally supply base (a local Git ref) to prioritize changed code and related tests.' +
      repositoryEvidenceGuidance,
    inputSchema: Type.Object(
      {
        symbol: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        symbols: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 4 }),
        ),
        location: Type.Optional(SourceLocation),
        trace: Type.Optional(RepositoryTraceInputSchema),
        follow: Type.Optional(Type.Boolean()),
        base: Type.Optional(RepositorySearchBaseSchema),
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        paths: Type.Optional(RepositorySearchPathsSchema),
      },
      { additionalProperties: false },
    ),
    outputSchema: RepositoryLocateOutputSchema,
    async execute(input, context): Promise<Static<typeof RepositoryLocateOutputSchema>> {
      const queries = (input.symbols ?? [input.symbol ?? input.query ?? '']).map((query) =>
        query.trim(),
      );
      if (
        [input.symbol, input.symbols, input.query, input.location, input.trace].filter(
          (value) => value !== undefined,
        ).length !== 1 ||
        (!input.location &&
          !input.trace &&
          (queries.some((query) => !query || /[\0\r\n]/.test(query)) ||
            new Set(queries).size !== queries.length))
      )
        throw new Error(
          'Supply exactly one of symbol, symbols, query, location, or trace, with distinct nonempty single-line queries.',
        );
      const deadline = AbortSignal.timeout(
        input.trace ? REPOSITORY_TRACE_TIMEOUT_MS : REPO_SEARCH_TIMEOUT_MS,
      );
      const signal = AbortSignal.any([context.signal, deadline]);
      const workspace = await openAuthorizedSearchWorkspace(context);
      const reader = new RepositorySourceReader(workspace);
      const scopes = await Promise.all(
        (input.paths ?? []).map(async (path) => {
          const target = await workspace.resolvePath(path, { allowRoot: true });
          assertRepositoryPathVisible(target.relative);
          return target;
        }),
      );
      const allows = (path: string) =>
        isRepositoryPathVisible(path) &&
        (!scopes.length ||
          scopes.some(
            ({ relative, kind }) =>
              relative === '.' ||
              path === relative ||
              (kind === 'directory' && path.startsWith(relative + '/')),
          ));
      const navigation = createSourceNavigation(reader, signal, allows);
      if (input.location) {
        const { path, line, maxLines = 24 } = input.location;
        if (input.base !== undefined || input.follow !== undefined)
          throw new Error('Supply base and follow for search lookups.');
        const target = await workspace.resolvePath(path, { kind: 'file' });
        if (!allows(target.relative))
          throw new Error('The source file is outside the search scope.');
        const source = await reader.read(target.relative, signal);
        if (typeof source === 'string') throw new Error(`Cannot open verified source (${source}).`);
        const opened = navigation.open(source, line, maxLines);
        await workspace.assertUnchanged();
        signal.throwIfAborted();
        return { source: opened, searches: [], followUp: 'not-needed' };
      }
      const searches: Static<typeof LocateSearch>[] = [];
      const priority =
        input.base === undefined
          ? undefined
          : await repositorySearchPriority(workspace, input.base, signal).catch(
              (error: unknown) => {
                context.signal.throwIfAborted();
                if (!input.trace || !deadline.aborted) throw error;
                return undefined;
              },
            );
      if (input.trace) {
        if (input.follow !== undefined) throw new Error('Trace follows connections automatically.');
        const trace = await traceRepository(input.trace, {
          reader,
          allows,
          callerSignal: context.signal,
          deadline,
          async search({ mode, query }, traceSignal) {
            const classify = mode === 'exact' ? classifySymbol(query) : undefined;
            const group =
              mode === 'literal'
                ? ({ path }: Pick<RepositoryHit, 'path'>) =>
                    isTestSource(path)
                      ? 'test'
                      : /\.pyi?$/.test(path)
                        ? 'python'
                        : /\.[cm]?[jt]sx?$/.test(path)
                          ? 'javascript'
                          : 'other'
                : classify;
            const result = await search(
              workspace,
              { query, mode, paths: input.paths },
              traceSignal,
              {
                source: reader,
                priority,
                ...(group && { collection: { group, perGroup: HITS_PER_ROLE } }),
              },
            );
            return classify ? await groupEvidence(reader, result, classify, traceSignal) : result;
          },
        });
        await workspace.assertUnchanged();
        return { searches, followUp: 'not-needed', trace };
      }
      const run = async (mode: 'hybrid' | 'exact', query: string) => {
        const symbol = mode === 'exact' ? query : undefined;
        const classify = symbol ? classifySymbol(symbol) : undefined;
        const result = await search(workspace, { query, mode, paths: input.paths }, signal, {
          source: reader,
          priority,
          ...(classify ? { collection: { group: classify, perGroup: HITS_PER_ROLE } } : {}),
        });
        const grouped = await groupEvidence(reader, result, classify, signal);
        const connections =
          input.follow && symbol ? await navigation.connections(symbol, grouped.results ?? []) : [];
        await workspace.assertUnchanged();
        signal.throwIfAborted();
        return {
          result,
          stage: { mode, query, ...grouped, ...(connections.length ? { connections } : {}) },
        };
      };
      const mode = input.query === undefined ? 'exact' : 'hybrid';
      let initial: Static<typeof RepositorySearchOutputSchema>;
      try {
        const stages = await Promise.allSettled(queries.map((query) => run(mode, query)));
        let failure: PromiseRejectedResult | undefined;
        let first: Awaited<ReturnType<typeof run>> | undefined;
        for (const stage of stages) {
          if (stage.status === 'rejected') {
            failure ??= stage;
            continue;
          }
          first ??= stage.value;
          searches.push(stage.value.stage);
        }
        if (failure) throw failure.reason;
        if (mode === 'exact') return { searches, followUp: 'not-needed' };
        initial = first!.result;
      } catch (error) {
        context.signal.throwIfAborted();
        if (!deadline.aborted) throw error;
        await workspace.assertUnchanged();
        return { searches, followUp: 'deadline' };
      }
      if (initial.status !== 'ready') return { searches, followUp: 'initial-unavailable' };
      const identifier = verifiedIdentifier(initial.results ?? []);
      if (!identifier) return { searches, followUp: 'no-verified-symbol' };
      try {
        searches.push((await run('exact', identifier)).stage);
        return { searches, followUp: 'attempted' };
      } catch {
        context.signal.throwIfAborted();
        await workspace.assertUnchanged();
        return { searches, followUp: deadline.aborted ? 'deadline' : 'failed' };
      }
    },
  });
}

import { Type, type Static } from 'typebox';
import { REPO_LOCATE_TOOL_NAME, REPO_SEARCH_TIMEOUT_MS } from './workspace-tools.js';
import { RepositorySourceReader } from '../repository/evidence.js';
import { isRepositoryPathVisible } from '../repository/filesystem.js';
import {
  compileRepositoryFilter,
  RepositoryFilterReportSchema,
  RepositoryFilterSchema,
} from '../repository/filter.js';
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
} from './repo-search.js';
import {
  REPOSITORY_TRACE_TIMEOUT_MS,
  RepositoryTraceInputSchema,
  RepositoryTraceOutputSchema,
  traceRepository,
  verifiedIdentifier,
} from './repo-trace.js';
import { defineTool } from './types.js';

export { REPO_LOCATE_TOOL_NAME } from './workspace-tools.js';

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
  mode: Type.Union([Type.Literal('exact'), Type.Literal('hybrid'), Type.Literal('semantic')]),
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
  filter: Type.Optional(RepositoryFilterReportSchema),
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
      'Use trace {question, mode?, leads?} for verified source, connections, and gaps across files. Supply up to four leads {mode, query}: hybrid for combined ranking, semantic for ranking by meaning without keyword scoring, exact for symbols, and literal for routes and settings. Set trace.mode to semantic to generate semantic leads from the question instead of supplying leads.' +
      ' For quick lookups use symbol, symbols, query, or location {path, line, maxLines}. Set mode to semantic with query to skip lexical search and exact follow-up. Use filter to scope paths and verified source units. Prefer includeText and excludeText for literal content. Set follow to true on a symbol lookup for one verified local connection. Optionally supply base (a local Git ref) to prioritize changed paths and their tests.' +
      ' Ranked trace leads use an existing complete index. Run a ranked repository search to build or resume it.' +
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
        mode: Type.Optional(Type.Union([Type.Literal('hybrid'), Type.Literal('semantic')])),
        filter: Type.Optional(RepositoryFilterSchema),
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
      if (input.mode !== undefined && input.query === undefined)
        throw new Error('Supply a query to select a Locate mode.');
      if (input.mode === 'semantic' && input.follow)
        throw new Error(
          'Semantic Locate skips exact follow-ups. Use a semantic trace to follow verified connections.',
        );
      const deadline = AbortSignal.timeout(
        input.trace ? REPOSITORY_TRACE_TIMEOUT_MS : REPO_SEARCH_TIMEOUT_MS,
      );
      const signal = AbortSignal.any([context.signal, deadline]);
      const workspace = await openAuthorizedSearchWorkspace(context);
      const reader = new RepositorySourceReader(workspace);
      const filter = compileRepositoryFilter(
        input.filter,
        input.location ? 'Locate location' : 'Locate',
        input.location ? 'none' : 'all',
      );
      const allows = (path: string) =>
        isRepositoryPathVisible(path) && (!filter || filter.allowsPath(path));
      const navigation = createSourceNavigation(reader, signal, allows, filter);
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
      let filterBudgetExhausted = false;
      const reportedFilter = () => (filter ? { filter: filter.report(filterBudgetExhausted) } : {});
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
          filter,
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
            const result = await search(workspace, { query, mode }, traceSignal, {
              source: reader,
              filter,
              priority,
              updateIndex: false,
              ...(group && { collection: { group, perGroup: HITS_PER_ROLE } }),
            });
            filterBudgetExhausted ||= result.diagnostics.some(
              ({ code }) => code === 'filter-budget-exhausted',
            );
            return classify ? await groupEvidence(reader, result, classify, traceSignal) : result;
          },
        });
        await workspace.assertUnchanged();
        return { searches, followUp: 'not-needed', trace, ...reportedFilter() };
      }
      const run = async (mode: Static<typeof LocateSearch>['mode'], query: string) => {
        const symbol = mode === 'exact' ? query : undefined;
        const classify = symbol ? classifySymbol(symbol) : undefined;
        const result = await search(workspace, { query, mode }, signal, {
          source: reader,
          filter,
          priority,
          ...(classify ? { collection: { group: classify, perGroup: HITS_PER_ROLE } } : {}),
        });
        filterBudgetExhausted ||= result.diagnostics.some(
          ({ code }) => code === 'filter-budget-exhausted',
        );
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
      const mode = input.query === undefined ? 'exact' : (input.mode ?? 'hybrid');
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
        if (mode === 'exact') return { searches, ...reportedFilter(), followUp: 'not-needed' };
        initial = first!.result;
      } catch (error) {
        context.signal.throwIfAborted();
        if (!deadline.aborted) throw error;
        await workspace.assertUnchanged();
        return { searches, ...reportedFilter(), followUp: 'deadline' };
      }
      if (initial.status !== 'ready')
        return { searches, ...reportedFilter(), followUp: 'initial-unavailable' };
      if (mode === 'semantic') return { searches, ...reportedFilter(), followUp: 'not-needed' };
      const identifier = verifiedIdentifier(initial.results ?? []);
      if (!identifier) return { searches, ...reportedFilter(), followUp: 'no-verified-symbol' };
      try {
        searches.push((await run('exact', identifier)).stage);
        return { searches, ...reportedFilter(), followUp: 'attempted' };
      } catch {
        context.signal.throwIfAborted();
        await workspace.assertUnchanged();
        return {
          searches,
          ...reportedFilter(),
          followUp: deadline.aborted ? 'deadline' : 'failed',
        };
      }
    },
  });
}

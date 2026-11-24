import { Type, type Static } from 'typebox';
import { sourceExcerpt, type RepositorySourceReader } from '../repository/evidence.js';
import {
  MAX_SOURCE_EXCERPT,
  RepositoryHitSchema,
  type RepositoryHit,
} from '../repository/results.js';
import { isTestSource } from '../repository/search-priority.js';
import { createSourceNavigation, type SourceConnection } from '../repository/source-navigation.js';
import { RepositorySearchOutputSchema } from './repo-search.js';

const MAX_LEADS = 4;
const TRACE_TIMEOUT_MS = 15_000;
const MAX_EVIDENCE = 24;
const MAX_EXCERPT_CHARACTERS = 12_000;
const MAX_CONNECTIONS = 12;
const SOURCE_LINES = 12;

const TraceLeadSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal('hybrid'), Type.Literal('exact'), Type.Literal('literal')]),
    query: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { additionalProperties: false },
);
type TraceLead = Static<typeof TraceLeadSchema>;

export const RepositoryTraceInputSchema = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 1024 }),
    leads: Type.Optional(Type.Array(TraceLeadSchema, { minItems: 1, maxItems: MAX_LEADS })),
  },
  { additionalProperties: false },
);

const EvidenceId = Type.Integer({ minimum: 1 });
export const RepositoryTraceOutputSchema = Type.Object({
  leads: Type.Array(
    Type.Object({
      ...TraceLeadSchema.properties,
      evidenceIds: Type.Array(EvidenceId),
      gaps: Type.Array(Type.String()),
    }),
  ),
  evidence: Type.Array(Type.Object({ id: EvidenceId, ...RepositoryHitSchema.properties })),
  connections: Type.Array(
    Type.Object({
      kind: Type.Union([
        Type.Literal('import'),
        Type.Literal('re-export'),
        Type.Literal('wrapper'),
        Type.Literal('call'),
        Type.Literal('shared-literal'),
      ]),
      from: EvidenceId,
      to: EvidenceId,
      fromLine: Type.Integer({ minimum: 1 }),
      toLine: Type.Integer({ minimum: 1 }),
      literal: Type.Optional(Type.String()),
    }),
  ),
});

type TraceResult = Static<typeof RepositoryTraceOutputSchema>;
type SearchResult = Static<typeof RepositorySearchOutputSchema>;
type TraceHit = RepositoryHit & { role?: string };
type Candidates = { hits: TraceHit[]; gaps: Set<string> };

export function verifiedIdentifier(hits: RepositoryHit[]): string | undefined {
  for (const { name, excerpt, excerptTruncated } of hits) {
    if (excerptTruncated || !name || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) continue;
    const identifier = new RegExp(
      `(?:^|[^\\p{L}\\p{M}\\p{N}_$])${name}(?![\\p{L}\\p{M}\\p{N}_$])`,
      'u',
    );
    if (identifier.test(excerpt)) return name;
  }
}

function traceLeads({ question, leads }: Static<typeof RepositoryTraceInputSchema>): TraceLead[] {
  if (!question.trim() || /[\0\r\n]/.test(question))
    throw new Error('Supply a nonempty, single-line trace question.');
  const requested: TraceLead[] =
    leads ??
    question
      .trim()
      .split(/(?<=[?;])\s+/)
      .slice(0, MAX_LEADS)
      .map((query) => ({ mode: 'hybrid', query }));
  const normalized = requested.map(({ mode, query }) => ({ mode, query: query.trim() }));
  if (
    normalized.some(
      ({ mode, query }) =>
        !query || /[\0\r\n]/.test(query) || (mode === 'exact' && !/^[\w$]+$/.test(query)),
    ) ||
    (leads && new Set(normalized.map((lead) => JSON.stringify(lead))).size !== normalized.length)
  )
    throw new Error(
      'Supply distinct, nonempty, single-line leads. Exact leads require one identifier.',
    );
  return leads ? normalized : [...new Map(normalized.map((lead) => [lead.query, lead])).values()];
}

function rankedAnchors(hits: TraceHit[]) {
  const anchors = new Set<string>();
  for (const hit of hits) {
    if (isTestSource(hit.path)) continue;
    const name = verifiedIdentifier([hit]);
    if (!name) continue;
    // > Skip local values whose declaration tells us little about the enclosing behavior.
    const declaration = new RegExp(
      `(?:\\b(?:function|class|def)\\s+${name}\\b|^\\s*(?:(?:export|private|protected|public|static|async)\\s+)*${name}\\s*\\([^)]*\\)[^;\\n]*\\{)`,
      'm',
    );
    if (declaration.test(hit.excerpt)) anchors.add(name);
    if (anchors.size === 2) break;
  }
  return [...anchors];
}

function selectHits(hits: TraceHit[], limit: number, lexical: boolean) {
  const counts = new Map<string, number>();
  const includes = new Set<string>();
  const ordered = lexical
    ? hits.toSorted((a, b) => {
        const score = (hit: TraceHit) =>
          hit.role === 'definition'
            ? 3
            : hit.role === 'test' || hit.role === 'caller'
              ? 2
              : /\.(?:[cm]?[jt]sx?|pyi?)$/.test(hit.path)
                ? 1
                : 0;
        return score(b) - score(a);
      })
    : hits;
  return ordered
    .filter((hit) => {
      const matched = counts.get(hit.path) ?? 0;
      const key = JSON.stringify([hit.path, hit.startLine, hit.endLine]);
      if (matched >= 2 || includes.has(key)) return false;
      includes.add(key);
      counts.set(hit.path, matched + 1);
      return true;
    })
    .slice(0, limit);
}

function overlap(first: RepositoryHit, second: RepositoryHit): RepositoryHit | undefined {
  if (
    first.path !== second.path ||
    first.excerptTruncated ||
    second.excerptTruncated ||
    first.endLine < second.startLine ||
    second.endLine < first.startLine
  )
    return;
  const startLine = Math.min(first.startLine, second.startLine);
  const endLine = Math.max(first.endLine, second.endLine);
  const lines = first.excerpt.split('\n');
  const incoming = second.excerpt.split('\n');
  for (const [index, line] of incoming.entries()) {
    const lineNumber = second.startLine + index;
    const existing = lines[lineNumber - first.startLine];
    if (existing !== undefined && existing !== line) return;
  }
  const before = incoming.slice(0, Math.max(0, first.startLine - second.startLine));
  const after = incoming.slice(Math.max(0, first.endLine + 1 - second.startLine));
  const excerpt = [...before, ...lines, ...after].join('\n');
  if (excerpt.length <= MAX_SOURCE_EXCERPT)
    return { path: first.path, startLine, endLine, excerpt };
}

async function readCandidates(
  leads: TraceLead[],
  search: (
    lead: TraceLead,
    signal: AbortSignal,
  ) => Promise<SearchResult & { results?: TraceHit[] }>,
  signal: AbortSignal,
) {
  async function lookup(lead: TraceLead): Promise<Candidates> {
    const gaps = new Set<string>();
    try {
      const result = await search(lead, signal);
      if (result.status !== 'ready') gaps.add(result.status);
      if (result.partial) gaps.add('search-partial');
      if (result.freshness === 'stale') gaps.add('search-stale');
      if (result.truncated) gaps.add('search-truncated');
      const hits = result.results ?? [];
      if (result.status === 'ready' && !result.partial && !hits.length) gaps.add('no-matches');
      return { hits, gaps };
    } catch {
      gaps.add(signal.aborted ? 'deadline' : 'search-failed');
      return { hits: [], gaps };
    }
  }

  const primary = await Promise.all(leads.map(lookup));
  const anchors = leads.map((lead, index) =>
    lead.mode === 'exact'
      ? [lead.query]
      : lead.mode === 'hybrid'
        ? rankedAnchors(primary[index]!.hits)
        : [],
  );
  const followups = new Map<string, Promise<Candidates>>();
  for (const [index, lead] of leads.entries()) {
    if (lead.mode === 'exact') followups.set(lead.query, Promise.resolve(primary[index]!));
  }
  for (const symbol of anchors.flat()) {
    if (!followups.has(symbol)) followups.set(symbol, lookup({ mode: 'exact', query: symbol }));
  }
  return Promise.all(
    primary.map(async (result, index) => ({
      ...result,
      anchors: await Promise.all(
        anchors[index]!.map(async (symbol) => ({
          symbol,
          ...(await followups.get(symbol)!),
        })),
      ),
    })),
  );
}

export async function traceRepository(
  request: Static<typeof RepositoryTraceInputSchema>,
  {
    reader,
    allows,
    search,
    callerSignal,
  }: {
    reader: RepositorySourceReader;
    allows: (path: string) => boolean;
    search: (
      lead: TraceLead,
      signal: AbortSignal,
    ) => Promise<SearchResult & { results?: TraceHit[] }>;
    callerSignal: AbortSignal;
  },
): Promise<TraceResult> {
  const leads = traceLeads(request);
  const deadline = AbortSignal.timeout(TRACE_TIMEOUT_MS);
  const signal = AbortSignal.any([callerSignal, deadline]);
  const navigation = createSourceNavigation(reader, signal, allows);
  const candidates = await readCandidates(leads, search, signal);
  callerSignal.throwIfAborted();

  async function expand(hit: RepositoryHit): Promise<RepositoryHit | undefined> {
    if (!allows(hit.path)) return;
    const source = await reader.read(hit.path, signal, allows);
    if (typeof source === 'string' || hit.endLine > source.lines.length) return;
    const current = sourceExcerpt(source, hit);
    if (current.excerpt !== hit.excerpt && `${current.excerpt}\n` !== hit.excerpt) return;
    if (hit.endLine - hit.startLine >= SOURCE_LINES || hit.excerptTruncated) return current;
    const opened = navigation.open(source, hit.startLine, SOURCE_LINES);
    return !opened.excerptTruncated && opened.endLine >= hit.endLine ? opened : current;
  }

  const found = await Promise.all(
    candidates.map(async ({ hits, gaps, anchors }, index) => {
      const lead = leads[index]!;
      const anchorHits = anchors.flatMap((anchor) => anchor.hits);
      for (const anchor of anchors) for (const gap of anchor.gaps) gaps.add(gap);
      const limit = leads.length <= 2 ? 6 : 4;
      const selected = selectHits(
        [...hits.slice(0, 2), ...anchorHits, ...hits.slice(2)],
        limit,
        lead.mode !== 'hybrid',
      );
      const candidates = await Promise.all(
        selected.map(async (hit) => {
          try {
            const evidence = await expand(hit);
            if (!evidence) gaps.add('source-unavailable');
            if (evidence?.excerptTruncated) gaps.add('source-clipped');
            return evidence;
          } catch {
            gaps.add(signal.aborted ? 'deadline' : 'source-unavailable');
          }
        }),
      );
      const edges = await Promise.all(
        anchors.map(async ({ symbol, hits }) => {
          try {
            const { connections, incomplete } = await navigation.trace(symbol, hits, 3, 4);
            if (incomplete) gaps.add('connection-unresolved');
            return connections;
          } catch {
            gaps.add(signal.aborted ? 'deadline' : 'connection-unresolved');
            return [];
          }
        }),
      );
      const evidence = candidates.filter((hit): hit is RepositoryHit => hit !== undefined);
      const connections: (
        | SourceConnection
        | { kind: 'shared-literal'; literal: string; from: RepositoryHit; to: RepositoryHit }
      )[] = edges.flat();
      if (
        lead.mode === 'literal' &&
        /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|\/[\w-]+(?:\/[\w-]+)+)$/.test(lead.query)
      ) {
        const sources = evidence.filter(
          ({ path, excerpt }) =>
            /\.(?:[cm]?[jt]sx?|pyi?)$/.test(path) &&
            !isTestSource(path) &&
            excerpt.includes(lead.query),
        );
        const first = sources[0];
        const second = first && sources.find(({ path }) => path !== first.path);
        if (first && second)
          connections.push({
            kind: 'shared-literal',
            literal: lead.query,
            from: first,
            to: second,
          });
      }
      return { evidence, connections, gaps, ids: new Set<number>() };
    }),
  );
  callerSignal.throwIfAborted();

  const evidence: TraceResult['evidence'] = [];
  const connections: TraceResult['connections'] = [];
  let characters = 0;
  function add(hit: RepositoryHit, gaps: Set<string>) {
    for (const entry of evidence) {
      if (
        entry.path === hit.path &&
        entry.startLine === hit.startLine &&
        entry.endLine === hit.endLine &&
        entry.excerpt === hit.excerpt
      )
        return entry.id;
      const merged = overlap(entry, hit);
      if (!merged) continue;
      const added = merged.excerpt.length - entry.excerpt.length;
      if (characters + added <= MAX_EXCERPT_CHARACTERS) {
        Object.assign(entry, merged);
        characters += added;
        return entry.id;
      }
    }
    if (
      evidence.length >= MAX_EVIDENCE ||
      characters + hit.excerpt.length > MAX_EXCERPT_CHARACTERS
    ) {
      gaps.add('response-limit');
      return;
    }
    const id = evidence.length + 1;
    const { path, startLine, endLine, excerpt, excerptTruncated } = hit;
    evidence.push({
      id,
      path,
      startLine,
      endLine,
      excerpt,
      ...(excerptTruncated && { excerptTruncated }),
    });
    characters += excerpt.length;
    return id;
  }
  for (let index = 0; index < 6; index++) {
    for (const lead of found) {
      const hit = lead.evidence[index];
      if (!hit) continue;
      const id = add(hit, lead.gaps);
      if (id) lead.ids.add(id);
    }
  }
  for (const lead of found) {
    for (const edge of lead.connections) {
      if (connections.length >= MAX_CONNECTIONS) {
        lead.gaps.add('response-limit');
        break;
      }
      const from = add(edge.from, lead.gaps);
      const to = add(edge.to, lead.gaps);
      if (!from || !to) continue;
      lead.ids.add(from);
      lead.ids.add(to);
      const link = {
        kind: edge.kind,
        from,
        to,
        fromLine: edge.from.startLine,
        toLine: ('toAnchorLine' in edge ? edge.toAnchorLine : undefined) ?? edge.to.startLine,
        ...('literal' in edge && { literal: edge.literal }),
      };
      if (
        !connections.some(
          (item) =>
            item.kind === link.kind &&
            item.from === from &&
            item.to === to &&
            item.fromLine === link.fromLine &&
            item.toLine === link.toLine &&
            item.literal === link.literal,
        )
      )
        connections.push(link);
    }
  }
  return {
    leads: leads.map((lead, index) => ({
      ...lead,
      evidenceIds: [...found[index]!.ids],
      gaps: [...found[index]!.gaps],
    })),
    evidence,
    connections,
  };
}

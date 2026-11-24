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
export const REPOSITORY_TRACE_TIMEOUT_MS = 15_000;
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

type TraceConnection =
  | SourceConnection
  | {
      kind: 'shared-literal';
      literal: string;
      from: RepositoryHit;
      to: RepositoryHit;
      fromAnchorLine: number;
      toAnchorLine: number;
    };

function sharedLiteral(query: string, evidence: RepositoryHit[]): TraceConnection | undefined {
  const setting = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(query);
  if (!setting && !/^\/[\w-]+(?:\/[\w-]+)+$/.test(query)) return;
  const surrounding = setting ? '[\\p{L}\\p{M}\\p{N}_$]' : '[\\p{L}\\p{M}\\p{N}_/-]';
  const match = new RegExp(`(?<!${surrounding})${query}(?!${surrounding})`, 'u');
  const sources = evidence
    .filter(
      ({ path, excerptTruncated }) =>
        !excerptTruncated && /\.(?:[cm]?[jt]sx?|pyi?)$/.test(path) && !isTestSource(path),
    )
    .flatMap((hit) => {
      const index = hit.excerpt.split('\n').findIndex((line) => match.test(line));
      return index < 0 ? [] : [{ hit, line: hit.startLine + index }];
    });
  const first = sources[0];
  const second = first && sources.find(({ hit }) => hit.path !== first.hit.path);
  if (first && second)
    return {
      kind: 'shared-literal',
      literal: query,
      from: first.hit,
      to: second.hit,
      fromAnchorLine: first.line,
      toAnchorLine: second.line,
    };
}

export async function traceRepository(
  request: Static<typeof RepositoryTraceInputSchema>,
  {
    reader,
    allows,
    search,
    callerSignal,
    deadline,
  }: {
    reader: RepositorySourceReader;
    allows: (path: string) => boolean;
    search: (
      lead: TraceLead,
      signal: AbortSignal,
    ) => Promise<SearchResult & { results?: TraceHit[] }>;
    callerSignal: AbortSignal;
    deadline: AbortSignal;
  },
): Promise<TraceResult> {
  const leads = traceLeads(request);
  const signal = AbortSignal.any([callerSignal, deadline]);
  const navigation = createSourceNavigation(reader, signal, allows);

  async function lookup(lead: TraceLead): Promise<Candidates> {
    const gaps = new Set<string>();
    try {
      signal.throwIfAborted();
      const result = await search(lead, signal);
      if (result.status !== 'ready') gaps.add(result.status);
      if (result.partial) gaps.add('search-partial');
      if (result.freshness === 'stale') gaps.add('search-stale');
      if (result.truncated) gaps.add('search-truncated');
      const hits = result.results ?? [];
      if (result.status === 'ready' && !result.partial && !result.truncated && !hits.length)
        gaps.add('no-matches');
      return { hits, gaps };
    } catch {
      gaps.add(signal.aborted ? 'deadline' : 'search-failed');
      return { hits: [], gaps };
    }
  }

  const primary = leads.map(lookup);
  const followups = new Map<string, Promise<Candidates>>();
  leads.forEach(({ mode, query }, index) => {
    if (mode === 'exact') followups.set(query, primary[index]!);
  });

  function exactCandidate(symbol: string) {
    const existing = followups.get(symbol);
    if (existing) return existing;
    const candidate = lookup({ mode: 'exact', query: symbol });
    followups.set(symbol, candidate);
    return candidate;
  }

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
    leads.map(async (lead, index) => {
      const initial = await primary[index]!;
      const { hits } = initial;
      const gaps = new Set(initial.gaps);
      const limit = leads.length <= 2 ? 6 : 4;
      const lexical = lead.mode !== 'hybrid';
      const primaryHits = selectHits(hits, limit, lexical);
      async function readEvidence(hit: RepositoryHit) {
        try {
          const evidence = await expand(hit);
          if (!evidence) gaps.add('source-unavailable');
          if (evidence?.excerptTruncated) gaps.add('source-clipped');
          return evidence;
        } catch {
          gaps.add(signal.aborted ? 'deadline' : 'source-unavailable');
        }
      }
      // > Verify the original hits while exact follow-ups and other leads are still running.
      const primaryEvidence = new Map(primaryHits.map((hit) => [hit, readEvidence(hit)]));
      const anchorNames = lead.mode === 'exact' ? [lead.query] : lexical ? [] : rankedAnchors(hits);
      const anchors = await Promise.all(
        anchorNames.map(async (symbol) => {
          const candidate = await exactCandidate(symbol);
          for (const gap of candidate.gaps) gaps.add(gap);
          try {
            const { connections, incomplete } = await navigation.trace(
              symbol,
              candidate.hits,
              3,
              4,
            );
            if (incomplete) gaps.add('connection-unresolved');
            return { hits: candidate.hits, connections };
          } catch {
            gaps.add(signal.aborted ? 'deadline' : 'connection-unresolved');
            return { hits: candidate.hits, connections: [] };
          }
        }),
      );
      const ordered = [
        ...hits.slice(0, 2),
        ...anchors.flatMap((anchor) => anchor.hits),
        ...hits.slice(2),
      ];
      const combined = selectHits(ordered, limit, lexical);
      const selected = deadline.aborted ? primaryHits : combined;
      const candidates = await Promise.all(
        selected.map((hit) => primaryEvidence.get(hit) ?? readEvidence(hit)),
      );
      // > Wait for any original hit reads that were superseded by a better follow-up match.
      await Promise.all(primaryEvidence.values());
      const evidence = candidates.filter((hit): hit is RepositoryHit => hit !== undefined);
      const connections: TraceConnection[] = anchors.flatMap((anchor) => anchor.connections);
      const literalConnection = lead.mode === 'literal' && sharedLiteral(lead.query, evidence);
      if (literalConnection) connections.push(literalConnection);
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
      if (from) lead.ids.add(from);
      if (to) lead.ids.add(to);
      if (!from || !to) continue;
      const link = {
        kind: edge.kind,
        from,
        to,
        fromLine: edge.kind === 'shared-literal' ? edge.fromAnchorLine : edge.from.startLine,
        toLine: edge.toAnchorLine ?? edge.to.startLine,
        ...('literal' in edge && { literal: edge.literal }),
      };
      if (link.from === link.to && link.fromLine === link.toLine) continue;
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
  // > A slow lead can outlast files that faster leads had already verified.
  const paths = [...new Set(evidence.map(({ path }) => path))];
  const changed = new Set(
    (
      await Promise.all(
        paths.map(async (path) =>
          typeof (await reader.read(path, callerSignal, allows)) === 'string' ? path : undefined,
        ),
      )
    ).filter((path) => path !== undefined),
  );
  const unavailableIds = new Set(
    evidence.filter(({ path }) => changed.has(path)).map(({ id }) => id),
  );
  for (const { ids, gaps } of found) {
    for (const id of unavailableIds) if (ids.delete(id)) gaps.add('source-unavailable');
  }
  return {
    leads: leads.map((lead, index) => ({
      ...lead,
      evidenceIds: [...found[index]!.ids],
      gaps: [...found[index]!.gaps],
    })),
    evidence: evidence.filter(({ id }) => !unavailableIds.has(id)),
    connections: connections.filter(
      ({ from, to }) => !unavailableIds.has(from) && !unavailableIds.has(to),
    ),
  };
}

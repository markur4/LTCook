import { isIP } from 'node:net';

type PrimarySource = { host: string; pathPrefix: string };

type SearchCase = {
  id: string;
  query: string;
  primary: readonly PrimarySource[];
};

type EngineMix = {
  id: string;
  engines?: readonly string[];
};

type EngineFailure = { engine: string; reason: string };

type SearchResult = {
  rank: number;
  title: string;
  url?: string;
  engine?: string;
  excerpt: string;
};

type Attempt = {
  outcome: 'ok' | 'http_error' | 'timeout' | 'network_error' | 'invalid_json';
  responseMs: number;
  httpStatus?: number;
  resultCount: number;
  primaryRank: number | null;
  results: SearchResult[];
  unresponsiveEngines: EngineFailure[];
};

const searchCases = [
  {
    id: 'python-3-14-pathlib',
    query: 'Python 3.14 pathlib documentation path operations',
    primary: [{ host: 'docs.python.org', pathPrefix: '/3.14/library/pathlib.html' }],
  },
  {
    id: 'berlin-personalausweis',
    query: 'Personalausweis beantragen Berlin Gültigkeit offizielle Informationen',
    primary: [{ host: 'service.berlin.de', pathPrefix: '/dienstleistung/120703/' }],
  },
  {
    id: 'node-current-lts',
    query: 'Node.js current LTS releases schedule official',
    primary: [{ host: 'nodejs.org', pathPrefix: '/en/about/previous-releases' }],
  },
  {
    id: 'github-actions-workflow-syntax',
    query: 'GitHub Actions workflow syntax concurrency cancel-in-progress queue max official docs',
    primary: [
      {
        host: 'docs.github.com',
        pathPrefix: '/en/actions/reference/workflows-and-actions/workflow-syntax',
      },
      {
        host: 'docs.github.com',
        pathPrefix: '/actions/using-workflows/workflow-syntax-for-github-actions',
      },
    ],
  },
  {
    id: 'rfc-9110',
    query: 'RFC 9110 HTTP Semantics 200 OK section 15.3.1 IETF standards',
    primary: [
      { host: 'www.rfc-editor.org', pathPrefix: '/rfc/rfc9110.html' },
      { host: 'httpwg.org', pathPrefix: '/specs/rfc9110.html' },
    ],
  },
  {
    id: 'transformer-paper',
    query: 'Attention Is All You Need original 2017 Transformer research paper arXiv',
    primary: [{ host: 'arxiv.org', pathPrefix: '/abs/1706.03762' }],
  },
] as const satisfies readonly SearchCase[];

const mixes = [
  { id: 'inherited-general' },
  { id: 'duckduckgo+brave', engines: ['duckduckgo', 'brave'] },
  { id: 'google-cse+brave', engines: ['google cse', 'brave'] },
] as const satisfies readonly EngineMix[];

const requestTimeoutMs = 15_000;
const delayBetweenRequestsMs = 200;
const requestCount = searchCases.length * mixes.length;
const [endpointArgument, ...extraArguments] = process.argv.slice(2);
if (extraArguments.length > 0)
  throw new Error('Usage: bun evals/web-search-engine-mix.ts [SEARXNG_BASE_URL]');

const endpoint = parseEndpoint(endpointArgument);

function parseEndpoint(input: string | undefined): URL {
  const endpoint = new URL(input ?? 'http://127.0.0.1:8888');
  if (!['http:', 'https:'].includes(endpoint.protocol))
    throw new Error('SearXNG base URL must use HTTP or HTTPS.');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('SearXNG base URL must not contain credentials, a query, or a fragment.');
  if (endpoint.pathname !== '/')
    throw new Error('SearXNG base URL must point to the instance root.');
  return endpoint;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cleanText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function publicResultUrl(value: unknown): { href: string; host: string; path: string } | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      isIP(host) ||
      ['localhost', 'local', 'internal', 'lan', 'home.arpa'].some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      )
    )
      return;
    return { href: `${url.origin}${url.pathname}`, host, path: url.pathname };
  } catch {
    return;
  }
}

function matchesPrimary(
  result: { host: string; path: string } | undefined,
  primary: PrimarySource,
): boolean {
  return (
    !!result &&
    (result.host === primary.host || result.host.endsWith(`.${primary.host}`)) &&
    result.path.startsWith(primary.pathPrefix)
  );
}

function failureReason(value: unknown): string {
  const message = cleanText(value, 300).toLowerCase();
  if (/timeout|timed out/.test(message)) return 'timeout';
  if (/captcha|blocked|suspicious|bot/.test(message)) return 'blocked';
  if (/\b429\b|rate.?limit|too many requests/.test(message)) return 'rate_limited';
  if (/\b[45]\d\d\b/.test(message)) return 'http_error';
  if (/network|connection|unreachable/.test(message)) return 'network_error';
  return 'unavailable';
}

function readEngineFailures(value: unknown): EngineFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): EngineFailure[] => {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') return [];
    const engine = cleanText(entry[0], 80);
    if (!engine) return [];
    return [{ engine, reason: failureReason(entry[1]) }];
  });
}

function readResults(value: unknown): (Record<string, unknown> | undefined)[] | undefined {
  if (!Array.isArray(value)) return;
  return value.map(asRecord);
}

async function search(searchCase: SearchCase, mix: EngineMix): Promise<Attempt> {
  const url = new URL('/search', endpoint);
  url.searchParams.set('format', 'json');
  url.searchParams.set('q', searchCase.query);
  if (mix.engines) url.searchParams.set('engines', mix.engines.join(','));

  const startedAt = performance.now();
  let httpStatus: number | undefined;
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    httpStatus = response.status;
    const responseMs = Math.round(performance.now() - startedAt);
    if (!response.ok)
      return {
        outcome: 'http_error',
        responseMs,
        httpStatus,
        resultCount: 0,
        primaryRank: null,
        results: [],
        unresponsiveEngines: [],
      };

    const payload = asRecord(await response.json());
    const rawResults = readResults(payload?.results);
    if (!payload || !rawResults)
      return {
        outcome: 'invalid_json',
        responseMs: Math.round(performance.now() - startedAt),
        httpStatus,
        resultCount: 0,
        primaryRank: null,
        results: [],
        unresponsiveEngines: [],
      };

    const primaryIndex = rawResults.findIndex((result) => {
      const url = publicResultUrl(result?.url);
      return searchCase.primary.some((source) => matchesPrimary(url, source));
    });
    const results = rawResults.slice(0, 3).flatMap((result, index): SearchResult[] => {
      if (!result) return [];
      const url = publicResultUrl(result.url);
      const engine = cleanText(result.engine, 80);
      return [
        {
          rank: index + 1,
          title: cleanText(result.title, 240),
          ...(url ? { url: url.href } : {}),
          ...(engine ? { engine } : {}),
          excerpt: cleanText(result.content, 280),
        },
      ];
    });
    return {
      outcome: 'ok',
      responseMs: Math.round(performance.now() - startedAt),
      httpStatus,
      resultCount: rawResults.length,
      primaryRank: primaryIndex < 0 ? null : primaryIndex + 1,
      results,
      unresponsiveEngines: readEngineFailures(payload.unresponsive_engines),
    };
  } catch (error) {
    let outcome: Attempt['outcome'] = 'network_error';
    if (error instanceof Error && error.name === 'TimeoutError') outcome = 'timeout';
    else if (error instanceof SyntaxError) outcome = 'invalid_json';
    return {
      outcome,
      responseMs: Math.round(performance.now() - startedAt),
      ...(httpStatus === undefined ? {} : { httpStatus }),
      resultCount: 0,
      primaryRank: null,
      results: [],
      unresponsiveEngines: [],
    };
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]!
    : Math.round((ordered[middle - 1]! + ordered[middle]!) / 2);
}

function summarize(mix: EngineMix, attempts: { attempt: Attempt }[]): Record<string, unknown> {
  const rows = attempts.map(({ attempt }) => attempt);
  const successful = rows.filter((attempt) => attempt.outcome === 'ok');
  const engineFailures = new Map<string, number>();
  for (const failure of rows.flatMap((attempt) => attempt.unresponsiveEngines))
    engineFailures.set(failure.engine, (engineFailures.get(failure.engine) ?? 0) + 1);
  return {
    mix: mix.id,
    engineOverride: mix.engines ?? null,
    requests: rows.length,
    successfulQueries: successful.length,
    queriesWithResults: rows.filter((attempt) => attempt.resultCount > 0).length,
    medianResponseMs: median(rows.map((attempt) => attempt.responseMs)),
    medianSuccessfulResponseMs: median(successful.map((attempt) => attempt.responseMs)),
    primarySourceTop3: `${rows.filter((attempt) => attempt.primaryRank !== null && attempt.primaryRank <= 3).length}/${rows.length}`,
    primarySourceFound: `${rows.filter((attempt) => attempt.primaryRank !== null).length}/${rows.length}`,
    unresponsiveEngineCounts: [...engineFailures.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([engine, count]) => ({ engine, count })),
  };
}

const attempts: { query: SearchCase; mix: EngineMix; attempt: Attempt }[] = [];
for (let queryIndex = 0; queryIndex < searchCases.length; queryIndex++) {
  const searchCase = searchCases[queryIndex]!;
  for (let offset = 0; offset < mixes.length; offset++) {
    const mix = mixes[(queryIndex + offset) % mixes.length]!;
    attempts.push({ query: searchCase, mix, attempt: await search(searchCase, mix) });
    if (attempts.length < requestCount)
      await new Promise((resolve) => setTimeout(resolve, delayBetweenRequestsMs));
  }
}

const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  target: endpointArgument ? 'user_supplied' : 'loopback_default',
  requestsPlanned: requestCount,
  timeoutPerRequestMs: requestTimeoutMs,
  delayBetweenRequestsMs,
  mixes: mixes.map((mix) =>
    summarize(
      mix,
      attempts.filter((item) => item.mix.id === mix.id),
    ),
  ),
  queries: attempts.map(({ query, mix, attempt }) => ({
    id: query.id,
    query: query.query,
    mix: mix.id,
    primary: query.primary,
    ...attempt,
  })),
};

console.log(JSON.stringify(report, null, 2));

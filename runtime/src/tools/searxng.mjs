import { normalizeDomain } from '../../../node_modules/pi-web-access/domain-filter-normalization.ts';
import { normalizeSearchResultCount } from '../../../node_modules/pi-web-access/search-result-count-normalization.ts';
import {
  fetchRemoteUrl,
  loadSsrfConfig,
} from '../../../node_modules/pi-web-access/ssrf-protection.ts';
import { isLoopbackHostname } from '../../../node_modules/pi-web-access/utils.ts';
import { runSearchQueries } from '../../../node_modules/pi-web-access/web-tool-core.ts';
import {
  MAX_ENGINE_ISSUES,
  MAX_ENGINE_NAME_LENGTH,
  MAX_QUERY_ERROR_LENGTH,
  MAX_SOURCE_SNIPPET_LENGTH,
  MAX_SOURCE_TITLE_LENGTH,
  MAX_SOURCE_URL_LENGTH,
  SOURCE_URL_PATTERN,
} from './web.ts';

const sourceUrlPattern = new RegExp(SOURCE_URL_PATTERN);

function parseSourceUrl(value) {
  if (
    typeof value !== 'string' ||
    value.length > MAX_SOURCE_URL_LENGTH ||
    !sourceUrlPattern.test(value) ||
    /[\s\\\u0000-\u001f\u007f]/u.test(value)
  )
    return null;
  const url = URL.parse(value);
  return url?.hostname && !url.username && !url.password ? url : null;
}

function engineName(value) {
  return typeof value === 'string' &&
    value.length <= MAX_ENGINE_NAME_LENGTH &&
    /^[a-z0-9][a-z0-9 ._-]*$/i.test(value)
    ? value
    : undefined;
}

function engineIssue(reason) {
  if (typeof reason !== 'string') return 'unavailable';
  if (/\b429\b|rate.?limit|too many requests/i.test(reason)) return 'rate_limited';
  if (/captcha|blocked|access denied/i.test(reason)) return 'blocked';
  if (/timeout|timed out/i.test(reason)) return 'timeout';
  return 'unavailable';
}

function normalizeFilters(filters = []) {
  const allowed = new Set();
  const blocked = new Set();
  for (const filter of filters) {
    const domain = normalizeDomain(filter);
    if (domain) (filter.trim().startsWith('-') ? blocked : allowed).add(domain);
  }
  return { allowed, blocked };
}

function matchesHost(host, domains) {
  return [...domains].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function collectResults(data, filters, limit) {
  if (!Array.isArray(data?.results)) throw new Error('SearXNG returned invalid search results.');
  const issues = new Map();
  if (Array.isArray(data.unresponsive_engines)) {
    for (const entry of data.unresponsive_engines) {
      const name = Array.isArray(entry) ? engineName(entry[0]) : undefined;
      if (name) issues.set(name, engineIssue(entry[1]));
    }
  }

  const results = new Map();
  let invalidLinks = false;
  for (const item of data.results) {
    const url = parseSourceUrl(item?.url);
    if (!url) {
      invalidLinks = true;
      const names = Array.isArray(item?.engines) ? item.engines : [item?.engine];
      for (const value of names) {
        const name = engineName(value);
        if (name && !issues.has(name)) issues.set(name, 'invalid_links');
      }
      continue;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      (filters.allowed.size && !matchesHost(host, filters.allowed)) ||
      matchesHost(host, filters.blocked)
    )
      continue;
    url.hash = '';
    if (results.size >= limit || results.has(url.href)) continue;
    results.set(url.href, {
      title: (typeof item.title === 'string' && item.title ? item.title : item.url).slice(
        0,
        MAX_SOURCE_TITLE_LENGTH,
      ),
      url: item.url,
      snippet:
        typeof item.content === 'string' ? item.content.slice(0, MAX_SOURCE_SNIPPET_LENGTH) : '',
    });
  }
  const answers = Array.isArray(data.answers)
    ? data.answers.filter((answer) => typeof answer === 'string')
    : [];
  return {
    results: [...results.values()],
    answer: answers.join('\n').trim().slice(0, MAX_SOURCE_SNIPPET_LENGTH),
    issues,
    invalidLinks,
  };
}

function createSearxngRequest(config) {
  const configured = process.env.SEARXNG_BASE_URL ?? config.searxngBaseUrl;
  const base = parseSourceUrl(typeof configured === 'string' ? configured.trim() : '');
  if (!base) throw new Error('SearXNG base URL is invalid or missing.');
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  base.search = '';
  base.hash = '';
  const headers = new Headers({ Accept: 'application/json' });
  if (config.searxngHeaders && typeof config.searxngHeaders === 'object') {
    for (const [name, value] of Object.entries(config.searxngHeaders)) {
      if (typeof value !== 'string') continue;
      try {
        headers.set(name.trim(), value);
      } catch {
        // > Ignore invalid optional SearXNG headers, as the provider does.
      }
    }
  }
  const ssrf = loadSsrfConfig();
  return async (path, params, signal) => {
    const url = new URL(path, base);
    url.search = new URLSearchParams(params);
    const response = await fetchRemoteUrl(
      url,
      { headers, signal },
      {
        ...ssrf,
        allowLoopback: isLoopbackHostname(url.hostname),
        onRedirect: ({ from, to, init }) =>
          from.origin === to.origin ? init : { ...init, headers: { Accept: 'application/json' } },
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`SearXNG search error ${response.status}.`);
    }
    try {
      return await response.json();
    } catch {
      signal.throwIfAborted();
      throw new Error('SearXNG returned invalid JSON.');
    }
  };
}

export async function searchSearxng(config, queries, args, signal) {
  const request = createSearxngRequest(config);
  const filters = normalizeFilters(args.domainFilter);
  const limit = normalizeSearchResultCount(args.numResults);
  const allowed = [...filters.allowed].map((host) => `site:${host}`).join(' OR ');
  const blocked = [...filters.blocked].map((host) => `-site:${host}`);
  let engineList;
  const enabledEngines = () => {
    engineList ??= request('config', {}, AbortSignal.any([signal, AbortSignal.timeout(5000)]))
      .then((data) => {
        if (!Array.isArray(data?.engines)) return [];
        return [
          ...new Set(
            data.engines.flatMap((engine) => {
              const name = engineName(engine?.name);
              return name &&
                engine.enabled === true &&
                Array.isArray(engine.categories) &&
                engine.categories.includes('web') &&
                engine.categories.includes('general')
                ? [name]
                : [];
            }),
          ),
        ];
      })
      .catch(() => []);
    return engineList;
  };
  return runSearchQueries(queries, async (query) => {
    signal.throwIfAborted();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    const params = {
      q: [query, allowed, ...blocked].filter(Boolean).join(' '),
      format: 'json',
      ...(args.recencyFilter && { time_range: args.recencyFilter }),
    };
    const entry = { query, provider: 'searxng', results: [], answer: '' };
    try {
      let found = collectResults(await request('search', params, deadline), filters, limit);
      const issues = found.issues;
      // > A bang can select an engine explicitly. Keep that selection on failure.
      if (!found.results.length && !found.answer && issues.size > 0 && !/(?:^|\s)!\S/.test(query)) {
        const candidates = (await enabledEngines()).filter((name) => !issues.has(name));
        if (candidates.length) {
          try {
            found = collectResults(
              await request('search', { ...params, engines: candidates.join(',') }, deadline),
              filters,
              limit,
            );
            for (const [engine, reason] of found.issues) issues.set(engine, reason);
          } catch {
            signal.throwIfAborted();
            const error = 'SearXNG returned no usable sources and the fallback search failed.';
            return { ...entry, error, issues: [...issues].slice(0, MAX_ENGINE_ISSUES) };
          }
        }
      }
      signal.throwIfAborted();
      const error =
        !found.results.length && !found.answer && (issues.size || found.invalidLinks)
          ? 'SearXNG returned no usable sources.'
          : null;
      return {
        ...entry,
        results: found.results,
        answer: found.answer,
        error,
        issues: [...issues].slice(0, MAX_ENGINE_ISSUES),
      };
    } catch (error) {
      signal.throwIfAborted();
      const message =
        error instanceof Error
          ? error.message.slice(0, MAX_QUERY_ERROR_LENGTH)
          : 'SearXNG search failed.';
      return { ...entry, error: message || 'SearXNG search failed.', issues: [] };
    }
  });
}

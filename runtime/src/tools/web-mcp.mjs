import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Value } from 'typebox/value';
import { findContent } from '../../../node_modules/pi-web-access/content-find.ts';
import { deleteResult, storeResult } from '../../../node_modules/pi-web-access/storage.ts';
import { runWithProxy } from '../../../node_modules/pi-web-access/utils.ts';
import {
  createWebToolCore,
  fetchAllContent,
  getMaxInlineContentChars,
  isToolEnabled,
  loadConfig,
  markToolError,
  registeredFetchToolNames,
  resolveFetchModeConfig,
} from '../../../node_modules/pi-web-access/web-tool-core.ts';
import {
  MAX_PASSAGE_TEXT_LENGTH,
  MAX_QUERY_ERROR_LENGTH,
  MAX_SOURCE_TITLE_LENGTH,
  webDefinitions,
} from './web.ts';
import { searchSearxng } from './searxng.mjs';

// > Only the MCP transport may write to stdout.
console.log = console.info = console.debug = console.error;

const toolBindings = {
  ltcook_web_search: {
    coreName: 'webSearch',
    run: (args, signal) => runWithProxy(undefined, () => search(args, signal)),
  },
  ltcook_web_fetch: { coreName: 'fetchContent', run: fetchPage },
  ltcook_web_content: { coreName: 'getSearchContent', run: readStored },
};
const config = loadConfig();
const settings = {
  toolNames: {
    webSearch: 'ltcook_web_search',
    fetchContent: 'ltcook_web_fetch',
    getSearchContent: 'ltcook_web_content',
    sourceCheck: 'source_check',
  },
  enabledTools: {
    webSearch: isToolEnabled(config, 'webSearch'),
    fetchContent: isToolEnabled(config, 'fetchContent'),
    getSearchContent: isToolEnabled(config, 'getSearchContent'),
    sourceCheck: false,
  },
  maxInlineContentChars: getMaxInlineContentChars(config),
  fetchModes: resolveFetchModeConfig(config),
};
const extractOptions = { rejectDirectImages: 'The LTCook web tools can only read text sources.' };
const storedIds = [];
function remember(id) {
  storedIds.push(id);
  if (storedIds.length > 50) deleteResult(storedIds.shift());
}

// > Keep search and fetched content in the core's bounded, per-child store.
const core = createWebToolCore({
  settings,
  extractOptions,
  storeFetchedContent(id, data) {
    storeResult(id, data);
    remember(id);
  },
  publishResult({ id }) {
    remember(id);
  },
});
const enabledTools = webDefinitions.filter(
  ({ name }) => settings.enabledTools[toolBindings[name].coreName],
);

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

async function search(args, signal) {
  const providers = config.webSearch?.allowedProviders;
  if (Array.isArray(providers) && !providers.includes('searxng'))
    return errorResult('SearXNG is disabled by the configured search providers.');
  const queries = args.queries ?? [args.query];
  const queryList = queries.map((query) => query.trim());
  const responses = await searchSearxng(config, queryList, args, signal);
  const urls = [...new Set(responses.flatMap(({ results }) => results.map(({ url }) => url)))];
  const includeContent = args.includeContent ?? false;
  const inlineContent =
    includeContent && urls.length > 0
      ? await fetchAllContent(urls, signal, {
          ...extractOptions,
          toolNames: registeredFetchToolNames(settings),
        })
      : undefined;
  signal.throwIfAborted();
  const result = core.buildSearchReturn({
    queryList,
    results: responses,
    urls,
    includeContent,
    inlineContent,
  });
  const diagnostics = responses.flatMap(({ issues }, index) =>
    issues.map(
      ([engine, reason]) => `Query ${index + 1}: ${engine} (${reason.replaceAll('_', ' ')})`,
    ),
  );
  if (!diagnostics.length && markToolError(result).isError)
    return errorResult(result.content[0].text);
  const { responseId, fetchId } = result.structuredContent;
  return {
    content: diagnostics.length
      ? [
          ...result.content,
          { type: 'text', text: `SearXNG engine issues\n${diagnostics.join('\n')}` },
        ]
      : result.content,
    structuredContent: {
      responseId,
      ...(fetchId && { fetchId }),
      queries: responses.map(({ error, results, issues }, index) => {
        const query = queries[index];
        return {
          query,
          ...(error ? { error } : { sources: results }),
          ...(issues.length && {
            engineIssues: issues.map(([engine, reason]) => ({ engine, reason })),
          }),
        };
      }),
    },
  };
}

async function fetchPage(args, signal) {
  const { findText, findMode = 'case-insensitive', ...fetchArgs } = args;
  const mode = fetchArgs.mode ?? settings.fetchModes.defaultMode;
  if (mode !== 'readable' && mode !== 'raw')
    return errorResult('The LTCook web fetch mode must be readable or raw.');
  const { content, isError, structuredContent } = markToolError(
    await core.fetchContent({ ...fetchArgs, mode }, signal),
  );
  const responseId = structuredContent?.responseId;
  if (isError) return { content, isError };
  const stored = responseId ? { responseId } : {};
  if (findText === undefined) return { content, structuredContent: stored };
  const pages = structuredContent?.urls;
  if (!pages?.length) return errorResult('No fetched text was available for passage lookup.');
  const terms = Array.isArray(findText) ? findText : [findText];
  const passages = pages.map(({ url, title, content: pageText, error, status }) => {
    const failure = error || (status >= 400 ? `HTTP ${status}` : null);
    if (failure) return { url, error: failure.slice(0, MAX_QUERY_ERROR_LENGTH) };
    const { text, matchCount } = findContent(pageText, terms, findMode);
    return {
      url,
      title: title.slice(0, MAX_SOURCE_TITLE_LENGTH),
      content: text.slice(0, MAX_PASSAGE_TEXT_LENGTH),
      matchCount,
    };
  });
  const text = passages
    .map((page) =>
      'error' in page
        ? `${page.url}\n${page.error}`
        : `# ${page.title || page.url}\n\n${page.url}\n\n${page.content}`,
    )
    .join('\n\n');
  return { content: [{ type: 'text', text }], structuredContent: { ...stored, passages } };
}

async function readStored(args, signal) {
  const result = await core.getSearchContent({ ...args, query: args.query?.trim() }, signal);
  const { content, isError } = markToolError(result);
  return { content, isError };
}

const server = new Server(
  { name: 'ltcook-web', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: enabledTools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
  const tool = enabledTools.find(({ name }) => name === params.name);
  if (!tool) return errorResult('Unknown or disabled web tool.');
  const args = params.arguments ?? {};
  if (!Value.Check(tool.inputSchema, args)) return errorResult('Invalid web tool arguments.');
  try {
    return await toolBindings[tool.name].run(args, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Web request failed.';
    return errorResult(message.slice(0, MAX_QUERY_ERROR_LENGTH));
  }
});

// > Match the pi-web-access MCP CLI lifecycle so closing the pipe also aborts
// > active calls and releases the child process.
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await server.close();
  } finally {
    process.exit();
  }
}

process.stdin.once('end', shutdown);
process.stdin.once('close', shutdown);
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await server.connect(new StdioServerTransport());

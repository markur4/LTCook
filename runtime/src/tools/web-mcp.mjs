import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Value } from 'typebox/value';
import {
  createStandaloneWebToolCore,
  DEFAULT_TOOL_NAMES,
} from '../../../node_modules/pi-web-access/web-tool-core.ts';
import {
  MAX_QUERY_ERROR_LENGTH,
  MAX_SEARCH_RESULTS,
  MAX_SOURCE_SNIPPET_LENGTH,
  MAX_SOURCE_TITLE_LENGTH,
  MAX_SOURCE_URL_LENGTH,
  SOURCE_URL_PATTERN,
  webDefinitions,
} from './web.ts';

// > Only the MCP transport may write to stdout.
console.log = console.info = console.debug = console.error;

// > pi-web-access's standalone MCP server only forwards text. Use its shared
// > execution core to obtain source metadata and keep its policy and cache.
const toolBindings = {
  ltcook_web_search: { coreName: 'webSearch', run: search },
  ltcook_web_fetch: { coreName: 'fetchContent', run: fetchPage },
  ltcook_web_content: { coreName: 'getSearchContent', run: readStored },
};
// > This private child uses the LTCook names in the core's pagination hints.
for (const [name, { coreName }] of Object.entries(toolBindings))
  DEFAULT_TOOL_NAMES[coreName] = name;
const core = createStandaloneWebToolCore();
const enabledTools = webDefinitions.filter(({ name }) => core.enabledToolNames.includes(name));
const sourceUrlPattern = new RegExp(SOURCE_URL_PATTERN);

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function searchSource(source) {
  if (
    typeof source.url !== 'string' ||
    source.url.length > MAX_SOURCE_URL_LENGTH ||
    !sourceUrlPattern.test(source.url)
  )
    return [];
  const url = URL.parse(source.url);
  if (!url || url.username || url.password) return [];
  const title = typeof source.title === 'string' ? source.title : source.url;
  const snippet = typeof source.snippet === 'string' ? source.snippet : '';
  return [
    {
      title: title.slice(0, MAX_SOURCE_TITLE_LENGTH),
      url: source.url,
      snippet: snippet.slice(0, MAX_SOURCE_SNIPPET_LENGTH),
    },
  ];
}

async function search(args, signal) {
  const queries = args.queries ?? [args.query];
  const result = await core.webSearch({ ...args, queries, provider: 'searxng' }, signal);
  const { content, isError, structuredContent } = result;
  if (isError) return { content, isError };
  if (structuredContent?.queries?.length !== queries.length)
    return errorResult('Web search returned an invalid result.');
  const { responseId, fetchId } = structuredContent;
  return {
    content,
    structuredContent: {
      responseId,
      ...(fetchId && { fetchId }),
      queries: structuredContent.queries.map(({ error, results }, index) => {
        const query = queries[index];
        return error !== null
          ? { query, error: error.slice(0, MAX_QUERY_ERROR_LENGTH) || 'Search failed.' }
          : { query, sources: results.slice(0, MAX_SEARCH_RESULTS).flatMap(searchSource) };
      }),
    },
  };
}

async function fetchPage(args, signal) {
  const { content, isError, structuredContent } = await core.fetchContent(args, signal);
  const responseId = structuredContent?.responseId;
  if (isError || !responseId) return { content, isError };
  return { content, structuredContent: { responseId } };
}

async function readStored(args, signal) {
  const { content, isError } = await core.getSearchContent(
    { ...args, query: args.query?.trim() },
    signal,
  );
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

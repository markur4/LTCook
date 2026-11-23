/** LTCook-owned contracts for the isolated pi-web-access tools. */
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { captureShellEnvironment } from '../integrations/shell-environment.js';
import { defineTool, type ToolContext } from './types.js';

const exec = promisify(execFile);

// Web retrieval needs its own configuration and Crawl4AI credential, not the
// runtime bearer, provider-model credentials, or unrelated workspace secrets.
const WEB_PROCESS_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'PI_CODING_AGENT_DIR',
  'CRAWL4AI_API_TOKEN',
] as const;

export function webProcessEnvironment(
  prepared: Record<string, string>,
  parent: NodeJS.ProcessEnv,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of WEB_PROCESS_KEYS) {
    const value = prepared[key] ?? parent[key];
    if (value !== undefined) output[key] = value;
  }
  return output;
}
const searchQuery = Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' });
const MAX_QUERIES = 4;
export const MAX_SEARCH_RESULTS = 20;
export const MAX_SOURCE_URL_LENGTH = 4096;
export const SOURCE_URL_PATTERN = '^[Hh][Tt][Tt][Pp][Ss]?://[^/\\\\?#\\s]';
export const MAX_SOURCE_TITLE_LENGTH = 300;
export const MAX_SOURCE_SNIPPET_LENGTH = 1000;
export const MAX_QUERY_ERROR_LENGTH = 1000;
const MAX_WEB_TEXT_LENGTH = 128000;

const searchSchema = Type.Object(
  {
    query: Type.Optional(searchQuery),
    queries: Type.Optional(
      Type.Array(searchQuery, {
        minItems: 1,
        maxItems: MAX_QUERIES,
      }),
    ),
    numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
    includeContent: Type.Optional(
      Type.Boolean({ description: 'Also fetch source pages and return a fetchId when stored.' }),
    ),
    recencyFilter: Type.Optional(
      Type.Union([
        Type.Literal('day'),
        Type.Literal('week'),
        Type.Literal('month'),
        Type.Literal('year'),
      ]),
    ),
    domainFilter: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
  },
  { additionalProperties: false, oneOf: [{ required: ['query'] }, { required: ['queries'] }] },
);
const findTerm = Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' });
const findText = Type.Union([findTerm, Type.Array(findTerm, { minItems: 1, maxItems: 10 })], {
  description: 'Find passages containing these terms or phrases.',
});
const findMode = Type.Union([
  Type.Literal('exact'),
  Type.Literal('case-insensitive'),
  Type.Literal('fuzzy'),
]);

const fetchSchema = Type.Object(
  {
    url: Type.Optional(Type.String({ minLength: 1 })),
    urls: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 5 })),
    mode: Type.Optional(Type.Union([Type.Literal('readable'), Type.Literal('raw')])),
    findText: Type.Optional(findText),
    findMode: Type.Optional(findMode),
  },
  { additionalProperties: false, oneOf: [{ required: ['url'] }, { required: ['urls'] }] },
);
const contentSchema = Type.Object(
  {
    responseId: Type.String({ minLength: 1 }),
    query: Type.Optional(Type.String()),
    queryIndex: Type.Optional(Type.Integer({ minimum: 0 })),
    url: Type.Optional(Type.String()),
    urlIndex: Type.Optional(Type.Integer({ minimum: 0 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
    findText: Type.Optional(findText),
    findMode: Type.Optional(findMode),
  },
  { additionalProperties: false },
);
const responseId = Type.String({ minLength: 1, maxLength: 128 });
const content = Type.String({ maxLength: MAX_WEB_TEXT_LENGTH });
const searchSource = Type.Object(
  {
    title: Type.String({ maxLength: MAX_SOURCE_TITLE_LENGTH }),
    url: Type.String({
      maxLength: MAX_SOURCE_URL_LENGTH,
      pattern: SOURCE_URL_PATTERN,
    }),
    snippet: Type.String({ maxLength: MAX_SOURCE_SNIPPET_LENGTH }),
  },
  { additionalProperties: false },
);
export const MAX_ENGINE_ISSUES = 20;
export const MAX_ENGINE_NAME_LENGTH = 80;
const engineIssues = Type.Optional(
  Type.Array(
    Type.Object(
      {
        engine: Type.String({ minLength: 1, maxLength: MAX_ENGINE_NAME_LENGTH }),
        reason: Type.Union([
          Type.Literal('blocked'),
          Type.Literal('rate_limited'),
          Type.Literal('timeout'),
          Type.Literal('unavailable'),
          Type.Literal('invalid_links'),
        ]),
      },
      { additionalProperties: false },
    ),
    { maxItems: MAX_ENGINE_ISSUES },
  ),
);
const queryError = Type.String({ minLength: 1, maxLength: MAX_QUERY_ERROR_LENGTH });
const queryResult = Type.Union([
  Type.Object(
    {
      query: searchQuery,
      sources: Type.Array(searchSource, { maxItems: MAX_SEARCH_RESULTS }),
      engineIssues,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { query: searchQuery, error: queryError, engineIssues },
    { additionalProperties: false },
  ),
]);

export const MAX_PASSAGE_TEXT_LENGTH = 12000;
const passage = Type.Union([
  Type.Object(
    {
      url: Type.String(),
      title: Type.String({ maxLength: MAX_SOURCE_TITLE_LENGTH }),
      content: Type.String({ maxLength: MAX_PASSAGE_TEXT_LENGTH }),
      matchCount: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ url: Type.String(), error: queryError }, { additionalProperties: false }),
]);

export const webDefinitions = [
  {
    name: 'ltcook_web_search',
    description:
      'Search the web through LTCook SearXNG. Returns sources, snippets, and any engine issues per query. Use ltcook_web_fetch with a source URL and findText to locate a passage.',
    inputSchema: searchSchema,
    outputSchema: Type.Object(
      {
        content,
        responseId,
        fetchId: Type.Optional(responseId),
        queries: Type.Array(queryResult, { minItems: 1, maxItems: MAX_QUERIES }),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: 'ltcook_web_fetch',
    description:
      'Read pages through LTCook HTTP or Crawl4AI. Add findText to return matching passages and their URLs in the same call. Use the responseId with ltcook_web_content to continue reading.',
    inputSchema: fetchSchema,
    outputSchema: Type.Object(
      {
        content,
        responseId: Type.Optional(responseId),
        passages: Type.Optional(Type.Array(passage, { maxItems: 5 })),
      },
      { additionalProperties: false },
    ),
  },
  {
    name: 'ltcook_web_content',
    description:
      'Read stored web results by responseId. Select a query with queryIndex or a page with urlIndex. Use findText to locate terms or quotes, or offset and limit to continue reading.',
    inputSchema: contentSchema,
    outputSchema: Type.Object({ content }, { additionalProperties: false }),
  },
] as const;

type WebToolName = (typeof webDefinitions)[number]['name'];
type WebToolOutput = Static<(typeof webDefinitions)[number]['outputSchema']>;

export function isWebTool(name: unknown): name is string {
  return webDefinitions.some((definition) => definition.name === name);
}

function localSearxngHealthUrl(environment: Record<string, string>): URL | undefined {
  if (environment.LTCOOK_SERVICE_CONNECTION !== 'local') return;
  const url = URL.parse(environment.LTCOOK_SEARXNG_URL ?? '');
  if (url?.protocol === 'http:' && url.hostname === '127.0.0.1' && url.href === `${url.origin}/`)
    return new URL('/healthz', url);
}

async function waitForSearxng(url: URL, signal: AbortSignal): Promise<void> {
  const deadline = AbortSignal.timeout(10000);
  const waiting = AbortSignal.any([signal, deadline]);
  try {
    for (;;) {
      const probeSignal = AbortSignal.any([waiting, AbortSignal.timeout(1000)]) as NonNullable<
        RequestInit['signal']
      >;
      const response = await fetch(url, {
        redirect: 'error',
        signal: probeSignal,
      }).catch(() => undefined);
      await response?.body?.cancel();
      waiting.throwIfAborted();
      if (response?.ok) return;
      await delay(200, undefined, { signal: waiting });
    }
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.aborted) throw new Error('Local SearXNG did not become ready within 10 seconds.');
    throw error;
  }
}

type WebClient = {
  client: Client;
  searxngHealthUrl: URL | undefined;
};

type Connection = {
  workspace: string;
  controller: AbortController;
  pending: Promise<WebClient>;
};
export class WebToolService {
  private readonly agents = new Map<string, Connection>();
  private closing = false;
  constructor(
    private readonly python: string,
    private readonly launcher: { command: string; entrypoint: string },
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly sessionShell?: (sessionId: string) => Record<string, string> | undefined,
    private readonly prepareServices?: () => Promise<void>,
  ) {}

  private async connect(context: ToolContext, signal: AbortSignal): Promise<WebClient> {
    await this.prepareServices?.();
    signal.throwIfAborted();
    const workspace = path.resolve(context.workspaceRoot);
    // > Resolve the authorized workspace from the original shell, not another workspace's overlay.
    const shell = {
      ...((context.sessionId && this.sessionShell?.(context.sessionId)) ||
        captureShellEnvironment(this.environment)),
    };
    delete shell.PI_CODING_AGENT_DIR;
    delete shell.LTCOOK_WORKSPACE;
    delete shell.LTCOOK_SESSION;
    let stdout: string;
    try {
      ({ stdout } = await exec(
        this.python,
        ['-m', 'ltcook.launch', 'prepare-native', '--workspace', workspace],
        {
          env: { ...this.environment, LTCOOK_SHELL_PROVENANCE: JSON.stringify(shell) },
          signal,
          timeout: 15000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
      ));
    } catch {
      signal.throwIfAborted();
      throw new Error('AppRC could not prepare the selected workspace for web tools.');
    }
    const prepared: unknown = JSON.parse(stdout);
    if (
      !prepared ||
      typeof prepared !== 'object' ||
      !('workspaceRoot' in prepared) ||
      path.resolve(String(prepared.workspaceRoot)) !== workspace ||
      !('environment' in prepared) ||
      !prepared.environment ||
      typeof prepared.environment !== 'object' ||
      Array.isArray(prepared.environment) ||
      !Object.values(prepared.environment).every((value) => typeof value === 'string')
    )
      throw new Error('Web tool configuration does not match the authorized workspace.');
    const env = prepared.environment as Record<string, string>;
    if (!env.PI_CODING_AGENT_DIR || !path.isAbsolute(env.PI_CODING_AGENT_DIR))
      throw new Error('Web tool configuration requires an absolute Pi home.');
    const transport = new StdioClientTransport({
      command: this.launcher.command,
      args: [this.launcher.entrypoint],
      env: webProcessEnvironment(env, this.environment),
      stderr: 'inherit',
    });
    const client = new Client({ name: 'ltcook-web', version: '1.0.0' });
    try {
      await client.connect(transport, { signal, timeout: 15000 });
      return { client, searxngHealthUrl: localSearxngHealthUrl(env) };
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }
  private async connection(context: ToolContext): Promise<WebClient> {
    const workspace = path.resolve(context.workspaceRoot);
    const { agentId } = context;
    let existing = this.agents.get(agentId);
    if (existing && existing.workspace !== workspace) {
      await this.disposeAgent(agentId);
      existing = this.agents.get(agentId);
      if (existing && existing.workspace !== workspace)
        throw new Error('The authorized web workspace changed.');
    }
    if (this.closing) throw new Error('Web tools are stopping.');
    if (!existing) {
      const controller = new AbortController();
      const pending = this.connect(context, controller.signal);
      const current = { workspace, controller, pending };
      this.agents.set(agentId, current);
      const forget = () => {
        if (this.agents.get(agentId) === current) this.agents.delete(agentId);
      };
      void pending.then(({ client }) => {
        client.onclose = forget;
      }, forget);
      existing = current;
    }
    return existing.pending;
  }

  async call(
    context: ToolContext,
    name: WebToolName,
    args: Record<string, unknown>,
  ): Promise<WebToolOutput> {
    const definition = webDefinitions.find((tool) => tool.name === name);
    if (!definition) throw new Error('Unknown web tool.');
    const { signal } = context;
    signal.throwIfAborted();
    const { client, searxngHealthUrl } = await this.connection(context);
    signal.throwIfAborted();
    if (name === 'ltcook_web_search' && searxngHealthUrl)
      await waitForSearxng(searxngHealthUrl, signal);
    const result = await client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout: 120000,
    });
    const content = (Array.isArray(result.content) ? result.content : [])
      .flatMap((item: unknown) =>
        item &&
        typeof item === 'object' &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string'
          ? [item.text]
          : [],
      )
      .join('\n');
    const bounded = boundWebText(content);
    if (result.isError) throw new Error(bounded || 'Web request failed.');
    const { structuredContent } = result;
    if (
      structuredContent !== undefined &&
      (structuredContent === null ||
        typeof structuredContent !== 'object' ||
        Array.isArray(structuredContent))
    )
      throw new Error('Web tool returned an invalid result.');
    const output = { ...structuredContent, content: bounded };
    if (!Value.Check(definition.outputSchema, output))
      throw new Error('Web tool returned an invalid result.');
    return output;
  }
  async disposeAgent(agentId: string): Promise<void> {
    const session = this.agents.get(agentId);
    if (!session) return;
    this.agents.delete(agentId);
    session.controller.abort();
    const connection = await session.pending.catch(() => undefined);
    await connection?.client.close();
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.agents.keys()].map((id) => this.disposeAgent(id)));
  }
}

function boundWebText(text: string): string {
  if (text.length <= MAX_WEB_TEXT_LENGTH) return text;
  const suffix = '\n[Truncated.] Use ltcook_web_content with the stored responseId to read more.';
  return text.slice(0, MAX_WEB_TEXT_LENGTH - suffix.length) + suffix;
}

export function createWebTools(service: WebToolService) {
  return webDefinitions.map((definition) =>
    defineTool({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      execute: (input, context) => service.call(context, definition.name, input),
    }),
  );
}

/** LTCook-owned web-tool contracts, backed by pi-web-access MCP. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Type } from 'typebox';
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
const searchSchema = Type.Object(
  {
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    queries: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
        minItems: 1,
        maxItems: 4,
      }),
    ),
    numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    includeContent: Type.Optional(Type.Boolean()),
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
const fetchSchema = Type.Object(
  {
    url: Type.Optional(Type.String({ minLength: 1 })),
    urls: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 5 })),
    mode: Type.Optional(Type.Union([Type.Literal('readable'), Type.Literal('raw')])),
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
    findText: Type.Optional(
      Type.Union([
        Type.String({ minLength: 1, maxLength: 500 }),
        Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
          minItems: 1,
          maxItems: 10,
        }),
      ]),
    ),
    findMode: Type.Optional(
      Type.Union([Type.Literal('exact'), Type.Literal('case-insensitive'), Type.Literal('fuzzy')]),
    ),
  },
  { additionalProperties: false },
);
export const webDefinitions = [
  {
    name: 'ltcook_web_search',
    upstream: 'web_search',
    description: 'Search the web using LTCook SearXNG. Save the responseId to inspect results.',
    inputSchema: searchSchema,
  },
  {
    name: 'ltcook_web_fetch',
    upstream: 'fetch_content',
    description:
      'Retrieve a URL through LTCook HTTP/Crawl4AI. Save the responseId for later reading.',
    inputSchema: fetchSchema,
  },
  {
    name: 'ltcook_web_content',
    upstream: 'get_search_content',
    description:
      'Read stored web results by responseId. Select a search with queryIndex or a fetched page with urlIndex.',
    inputSchema: contentSchema,
  },
] as const;

export function isWebTool(name: unknown): name is string {
  return webDefinitions.some((definition) => definition.name === name);
}

type Connection = {
  workspace: string;
  controller: AbortController;
  pending: Promise<Client>;
};
export class WebToolService {
  private readonly agents = new Map<string, Connection>();
  private closing = false;
  constructor(
    private readonly python: string,
    private readonly appRoot: string,
    private readonly node: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly sessionShell?: (sessionId: string) => Record<string, string> | undefined,
    private readonly prepareServices?: () => Promise<void>,
  ) {}

  private async connect(context: ToolContext, signal: AbortSignal): Promise<Client> {
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
      command: this.node,
      args: [path.join(this.appRoot, 'node_modules', 'pi-web-access', 'dist', 'mcp-cli.js')],
      env: webProcessEnvironment(env, this.environment),
      stderr: 'inherit',
    });
    const client = new Client({ name: 'ltcook-web', version: '1.0.0' });
    try {
      await client.connect(transport, { signal, timeout: 15000 });
      return client;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }
  private async connection(context: ToolContext): Promise<Client> {
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
      void pending.then((client) => {
        client.onclose = forget;
      }, forget);
      existing = current;
    }
    return existing.pending;
  }

  async call(
    context: ToolContext,
    upstream: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const { signal } = context;
    signal.throwIfAborted();
    const client = await this.connection(context);
    signal.throwIfAborted();
    const result = await client.callTool(
      {
        name: upstream,
        arguments: upstream === 'web_search' ? { ...args, provider: 'searxng' } : args,
      },
      undefined,
      { signal, timeout: 120000 },
    );
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
    if (result.isError) throw new Error(content || 'Web request failed.');
    const bounded = content.slice(0, 128000);
    const hint =
      'Use ltcook_web_content with the responseId and queryIndex or urlIndex to page through stored results.';
    return content.length > bounded.length
      ? `${bounded}\n[Truncated.] ${hint}`
      : upstream === 'get_search_content' && !content.includes('get_search_content(')
        ? content
        : `${bounded}\n\n${hint}`;
  }
  async disposeAgent(agentId: string): Promise<void> {
    const session = this.agents.get(agentId);
    if (!session) return;
    this.agents.delete(agentId);
    session.controller.abort();
    const client = await session.pending.catch(() => undefined);
    await client?.close();
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.agents.keys()].map((id) => this.disposeAgent(id)));
  }
}

export function createWebTools(service: WebToolService) {
  return webDefinitions.map((definition) =>
    defineTool({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: Type.Object({ content: Type.String() }),
      async execute(input, context) {
        return {
          content: await service.call(context, definition.upstream, input),
        };
      },
    }),
  );
}

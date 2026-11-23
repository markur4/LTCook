/** LTCook-owned web-tool contracts, backed by pi-web-access MCP. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Type } from 'typebox';
import { defineTool } from './types.js';

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
    query: Type.String({ minLength: 1, maxLength: 2000 }),
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
  { additionalProperties: false },
);
const fetchSchema = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
    mode: Type.Optional(Type.Union([Type.Literal('readable'), Type.Literal('raw')])),
  },
  { additionalProperties: false },
);
const contentSchema = Type.Object(
  {
    responseId: Type.String({ minLength: 1 }),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
    findText: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
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
    description: 'Read or search stored web results by responseId.',
    inputSchema: contentSchema,
  },
] as const;

type Connection = { client: Client; workspace: string };
export class WebToolService {
  private readonly agents = new Map<string, { workspace: string; pending: Promise<Connection> }>();
  constructor(
    private readonly python: string,
    private readonly appRoot: string,
    private readonly node: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  private async connect(workspace: string): Promise<Connection> {
    // The runtime may have started for a different workspace. Never reuse its
    // launch-derived Pi home when resolving another workspace's web settings.
    const environment = { ...this.environment };
    delete environment.PI_CODING_AGENT_DIR;
    delete environment.LTCOOK_WORKSPACE;
    delete environment.LTCOOK_SESSION;
    const { stdout } = await exec(
      this.python,
      ['-m', 'ltcook.launch', 'prepare-native', '--workspace', workspace],
      { env: environment, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const prepared: unknown = JSON.parse(stdout);
    if (
      !prepared ||
      typeof prepared !== 'object' ||
      !('workspaceRoot' in prepared) ||
      path.resolve(String(prepared.workspaceRoot)) !== workspace ||
      !('environment' in prepared) ||
      !prepared.environment ||
      typeof prepared.environment !== 'object' ||
      Array.isArray(prepared.environment)
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
      await client.connect(transport);
      return { client, workspace };
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }
  private async connection(agentId: string, workspace: string): Promise<Connection> {
    let existing = this.agents.get(agentId);
    if (existing && existing.workspace !== workspace) {
      await this.disposeAgent(agentId);
      existing = undefined;
    }
    if (!existing) {
      const pending = this.connect(workspace);
      existing = { workspace, pending };
      this.agents.set(agentId, existing);
      const current = existing;
      void pending.catch(() => {
        if (this.agents.get(agentId) === current) this.agents.delete(agentId);
      });
    }
    return existing.pending;
  }
  async call(
    agentId: string,
    workspaceRoot: string,
    upstream: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const { client } = await this.connection(agentId, path.resolve(workspaceRoot));
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
    return content.length > 128000
      ? content.slice(0, 128000) + '\n[Truncated; use ltcook_web_content.]'
      : content;
  }
  async disposeAgent(agentId: string): Promise<void> {
    const session = this.agents.get(agentId);
    if (!session) return;
    this.agents.delete(agentId);
    const conn = await session.pending.catch(() => undefined);
    if (conn) await conn.client.close();
  }
  async close(): Promise<void> {
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
          content: await service.call(
            context.agentId,
            context.workspaceRoot,
            definition.upstream,
            input,
            context.signal,
          ),
        };
      },
    }),
  );
}

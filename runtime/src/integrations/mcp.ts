import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
  ToolSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolContext } from '../tools/types.js';
import { isRepositoryTool } from '../paseo-plugin/shared/workspace-tools.js';
import type { WebToolService } from '../tools/web.js';

type Grant = {
  agentId: string;
  workspaceRoot: string;
  workspaceIdentity: string;
  workspaceFileAccess: boolean;
  repositorySearchAccess: boolean;
  token: string;
};

type Connection = {
  id: string;
  grant: Grant;
  server: Server;
  transport: StreamableHTTPServerTransport;
};

const MAX_BODY_BYTES = 128 * 1024;
const MAX_CONNECTIONS = 256;

function directoryIdentity(directory: string): string {
  const stats = statSync(directory, { bigint: true });
  if (!stats.isDirectory()) throw new Error('MCP requires a workspace directory.');
  return `${stats.dev}:${stats.ino}`;
}

/** In-memory grants remain stable on warm resume and expire with the runtime. */
export class WorkspaceMcp {
  private readonly grants = new Map<string, Grant>();
  private readonly tokens = new Map<string, Grant>();
  private readonly connections = new Map<string, Connection>();
  private readonly catalog: Tool[];
  private readonly tools: Map<string, ToolDefinition>;

  constructor(
    tools: readonly ToolDefinition[],
    private readonly authority: string,
    private readonly web?: WebToolService,
  ) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.catalog = tools.map(({ name, description, inputSchema, outputSchema }) =>
      ToolSchema.parse({
        name,
        description,
        inputSchema,
        outputSchema,
        ...(isRepositoryTool(name)
          ? { annotations: { readOnlyHint: true, openWorldHint: false } }
          : {}),
      }),
    );
  }

  async grant(
    agentId: string,
    cwd: string,
    workspaceFileAccess: boolean,
    repositorySearchAccess = false,
  ): Promise<string> {
    if (!isAbsolute(cwd)) throw new Error('MCP requires an absolute workspace directory.');
    const workspaceRoot = realpathSync(cwd);
    const workspaceIdentity = directoryIdentity(workspaceRoot);
    const existing = this.grants.get(agentId);
    if (
      existing?.workspaceRoot === workspaceRoot &&
      existing.workspaceIdentity === workspaceIdentity &&
      existing.workspaceFileAccess === workspaceFileAccess &&
      existing.repositorySearchAccess === repositorySearchAccess
    )
      return existing.token;
    const previous = this.revoke(agentId);
    const grant = {
      agentId,
      workspaceRoot,
      workspaceIdentity,
      workspaceFileAccess,
      repositorySearchAccess,
      token: randomBytes(32).toString('base64url'),
    };
    this.grants.set(agentId, grant);
    this.tokens.set(grant.token, grant);
    await previous;
    return grant.token;
  }

  async invokeTool(
    name: string,
    args: unknown,
    context: ToolContext,
  ): Promise<Record<string, unknown>> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error('Unknown LTCook tool.');
    return tool.invoke(args, context);
  }

  async revoke(agentId: string): Promise<void> {
    const grant = this.grants.get(agentId);
    if (!grant) {
      await this.web?.disposeAgent(agentId);
      return;
    }
    this.grants.delete(agentId);
    this.tokens.delete(grant.token);
    await Promise.all([
      this.web?.disposeAgent(agentId),
      ...[...this.connections.values()]
        .filter((connection) => connection.grant === grant)
        .map((connection) => connection.server.close()),
    ]);
  }

  async close(): Promise<void> {
    this.grants.clear();
    this.tokens.clear();
    await Promise.all([
      this.web?.close(),
      ...[...this.connections.values()].map(({ server }) => server.close()),
    ]);
  }

  private createConnection(grant: Grant): Connection {
    const id = randomUUID();
    const server = new Server(
      { name: 'ltcook', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
    });
    transport.onclose = () => {
      this.connections.delete(id);
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: grant.repositorySearchAccess
        ? this.catalog
        : this.catalog.filter(({ name }) => !isRepositoryTool(name)),
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
      try {
        if (
          this.tokens.get(grant.token) !== grant ||
          realpathSync(grant.workspaceRoot) !== grant.workspaceRoot ||
          directoryIdentity(grant.workspaceRoot) !== grant.workspaceIdentity
        ) {
          throw new Error('The authorized workspace is no longer available.');
        }
        const tool = this.tools.get(params.name);
        if (!tool || (isRepositoryTool(params.name) && !grant.repositorySearchAccess))
          throw new Error('Unknown LTCook tool.');
        const output = await tool.invoke(params.arguments ?? {}, {
          agentId: grant.agentId,
          workspaceRoot: grant.workspaceRoot,
          workspaceFileAccess: grant.workspaceFileAccess,
          repositorySearchAccess: grant.repositorySearchAccess,
          signal,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'LTCook tool failed.';
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    });
    return { id, server, transport, grant };
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.host !== this.authority || request.headers.origin !== undefined) {
      response.writeHead(403).end();
      return;
    }
    const token = request.headers.authorization?.match(/^Bearer ([\w-]+)$/)?.[1];
    const grant = token && this.tokens.get(token);
    if (!grant) {
      response.writeHead(401).end();
      return;
    }
    try {
      let body: unknown;
      if (request.method === 'POST') {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) {
            request.resume();
            response.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      }

      const id = request.headers['mcp-session-id'];
      if (id !== undefined) {
        const connection = typeof id === 'string' ? this.connections.get(id) : undefined;
        if (!connection || connection.grant !== grant || this.tokens.get(grant.token) !== grant) {
          response.writeHead(404).end();
          return;
        }
        await connection.transport.handleRequest(request, response, body);
      } else if (
        request.method === 'POST' &&
        isInitializeRequest(body) &&
        this.tokens.get(grant.token) === grant
      ) {
        const previous = [...this.connections.values()].find(
          (connection) => connection.grant === grant,
        );
        if (!previous && this.connections.size >= MAX_CONNECTIONS) {
          response.writeHead(503).end();
          return;
        }
        const connection = this.createConnection(grant);
        this.connections.set(connection.id, connection);
        try {
          // > Paseo runs one provider session per agent. A reconnect replaces its old transport.
          await Promise.all([
            connection.server.connect(connection.transport),
            previous?.server.close(),
          ]);
          if (this.connections.get(connection.id) !== connection) {
            response.writeHead(404).end();
            return;
          }
          await connection.transport.handleRequest(request, response, body);
        } finally {
          if (!connection.transport.sessionId) await connection.server.close();
        }
      } else {
        response.writeHead(400).end();
      }
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  }
}

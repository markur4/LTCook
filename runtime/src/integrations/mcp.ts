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
  type RequestId,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolContext } from '../tools/types.js';
import {
  isRepositoryTool,
  WORKSPACE_MCP_SERVER,
  WORKTREE_TOOL_NAME,
} from '../paseo-plugin/shared/workspace-tools.js';
import { repositoryEvidenceText } from '../tools/repository-evidence-text.js';
import { openRepositoryWorkspace } from '../repository/workspace.js';
import type { WebToolService } from '../tools/web.js';
import type { PlanningDialogEvent } from './planning-dialogs.js';

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

type RestartApproval = {
  message: string;
  permissionId?: string;
  resolve: (approved: boolean) => void;
};

const MAX_BODY_BYTES = 128 * 1024;
const MAX_CONNECTIONS = 256;
const RESTART_APPROVAL_TIMEOUT_MS = 90_000;
const RESTART_TOOL: Tool = {
  name: 'ltcook_restart',
  description:
    'Ask the user to approve a restart of this local LTCook installation after active work ends. Use only when the user requests a restart. Set update to true if they also requested an update. Report the returned queue result and finish the turn so LTCook can become idle. If approval is unavailable, direct the user to ltcook restart --when-idle.',
  inputSchema: {
    type: 'object',
    properties: { update: { type: 'boolean', description: 'Update LTCook before restarting.' } },
    additionalProperties: false,
  },
};

function requiresRepositoryAccess(name: string): boolean {
  return isRepositoryTool(name) || name === WORKTREE_TOOL_NAME;
}

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
  private readonly restartApprovals = new Map<string, RestartApproval>();
  private readonly catalog: Tool[];
  private readonly tools: Map<string, ToolDefinition>;

  constructor(
    tools: readonly ToolDefinition[],
    private readonly authority: string,
    private readonly web?: WebToolService,
    private readonly requestRestart?: (update: boolean) => Promise<Record<string, unknown>>,
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

  async repositorySearchWorkspace(agentId: string) {
    const grant = this.grants.get(agentId);
    if (!grant?.repositorySearchAccess) return undefined;
    const workspace = await openRepositoryWorkspace(grant.workspaceRoot).catch(() => undefined);
    if (
      this.grants.get(agentId) !== grant ||
      workspace?.root !== grant.workspaceRoot ||
      workspace.identity !== grant.workspaceIdentity
    )
      return undefined;
    return {
      ...workspace,
      assertUnchanged: async () => {
        await workspace.assertUnchanged();
        if (this.grants.get(agentId) !== grant)
          throw new Error('The repository search grant is no longer active.');
      },
    };
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

  /** Authenticate consent through the parent host in addition to the MCP client. */
  observeRestartApproval(event: PlanningDialogEvent): void {
    const approval = this.restartApprovals.get(event.agentId);
    if (!approval) return;
    if (event.type === 'agent_permission_request') {
      const { request } = event;
      if (
        request.provider !== 'codex' ||
        request.kind !== 'tool' ||
        request.name !== 'CodexMcpElicitation' ||
        request.title !== `MCP approval: ${WORKSPACE_MCP_SERVER}` ||
        request.metadata?.serverName !== WORKSPACE_MCP_SERVER ||
        request.input?.mode !== 'form' ||
        request.description !== approval.message ||
        approval.permissionId !== undefined
      )
        return;
      approval.permissionId = request.id;
    } else if (approval.permissionId === event.requestId) {
      approval.resolve(event.resolution.behavior === 'allow');
    }
  }

  private assertWorkspaceGrant(grant: Grant): void {
    if (
      this.tokens.get(grant.token) !== grant ||
      realpathSync(grant.workspaceRoot) !== grant.workspaceRoot ||
      directoryIdentity(grant.workspaceRoot) !== grant.workspaceIdentity
    ) {
      throw new Error('The authorized workspace is no longer available.');
    }
  }

  private async approveRestart(
    args: Record<string, unknown>,
    connection: Connection,
    requestId: RequestId,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const { grant, server } = connection;
    const requestRestart = this.requestRestart;
    if (!requestRestart || !server.getClientCapabilities()?.elicitation?.form)
      throw new Error('Restart approval is unavailable. Use ltcook restart --when-idle.');
    if (
      Object.keys(args).some((key) => key !== 'update') ||
      (Object.hasOwn(args, 'update') && typeof args.update !== 'boolean')
    )
      throw new Error('The restart tool accepts only an optional update boolean.');
    if (this.restartApprovals.has(grant.agentId))
      throw new Error('A restart approval is already pending for this conversation.');

    const update = args.update === true;
    const action = update ? 'update and restart' : 'restart';
    const message = `Allow LTCook to ${action} this local installation after active work ends? Request ${randomUUID()}.`;
    const approval = Promise.withResolvers<boolean>();
    this.restartApprovals.set(grant.agentId, { message, resolve: approval.resolve });
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(RESTART_APPROVAL_TIMEOUT_MS)]);
    const cancelApproval = () => approval.resolve(false);
    deadline.addEventListener('abort', cancelApproval, { once: true });
    try {
      deadline.throwIfAborted();
      const result = await server.elicitInput(
        { mode: 'form', message, requestedSchema: { type: 'object', properties: {} } },
        { relatedRequestId: requestId, signal: deadline, timeout: RESTART_APPROVAL_TIMEOUT_MS },
      );
      if (result.action !== 'accept' || !(await approval.promise))
        throw new Error('The user did not approve the restart. Use ltcook restart --when-idle.');
      deadline.throwIfAborted();
      this.assertWorkspaceGrant(grant);
      if (this.connections.get(connection.id) !== connection)
        throw new Error('The authorized MCP connection is no longer available.');
      return requestRestart(update);
    } finally {
      deadline.removeEventListener('abort', cancelApproval);
      this.restartApprovals.delete(grant.agentId);
    }
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
    const connection = { id, server, transport, grant };
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = grant.repositorySearchAccess
        ? this.catalog
        : this.catalog.filter(({ name }) => !requiresRepositoryAccess(name));
      return {
        tools:
          this.requestRestart && server.getClientCapabilities()?.elicitation?.form
            ? [...tools, RESTART_TOOL]
            : tools,
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal, requestId }) => {
      try {
        this.assertWorkspaceGrant(grant);
        let output: Record<string, unknown>;
        if (params.name === RESTART_TOOL.name) {
          output = await this.approveRestart(params.arguments ?? {}, connection, requestId, signal);
        } else {
          const tool = this.tools.get(params.name);
          if (!tool || (requiresRepositoryAccess(params.name) && !grant.repositorySearchAccess))
            throw new Error('Unknown LTCook tool.');
          output = await tool.invoke(params.arguments ?? {}, {
            agentId: grant.agentId,
            workspaceRoot: grant.workspaceRoot,
            workspaceFileAccess: grant.workspaceFileAccess,
            repositorySearchAccess: grant.repositorySearchAccess,
            signal,
          });
        }
        const text = isRepositoryTool(params.name)
          ? repositoryEvidenceText(params.name, output)
          : JSON.stringify(output);
        return {
          content: [{ type: 'text', text }],
          structuredContent: output,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'LTCook tool failed.';
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    });
    return connection;
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

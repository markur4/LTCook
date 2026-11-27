import type { ServerResponse } from 'node:http';
import { canonicalWorkspace } from '../core/workspace.js';
import { validateRiedRequest } from '../repository/requests.js';
import { isManagedWorkspaceTool } from '../tools/capabilities.js';
import type { ToolCatalog } from '../tools/catalog.js';
import {
  isRepositoryTool,
  REPO_SEARCH_TIMEOUT_MS,
  SESSION_MEMORY_TOOL_NAME,
} from '../tools/workspace-tools.js';
import type { RuntimeActor, RuntimeController } from '../workflow-api/index.js';

interface ToolRouteBody {
  sessionId?: string;
  nativeAgentId?: string;
  toolName?: unknown;
  toolArgs?: unknown;
  input?: unknown;
}

interface ToolRouteServices {
  runtime: Pick<
    RuntimeController,
    'authorizeTool' | 'authorizeWorkspaceTool' | 'ried' | 'snapshot'
  >;
  catalog: ToolCatalog | undefined;
  registeredWorkspace(sessionId: string): string | undefined;
}

type ToolHandler = (
  input: ToolRouteBody,
  response: ServerResponse,
  actor: RuntimeActor,
  services: ToolRouteServices,
) => void | Promise<void>;

const toolRoutes = {
  async '/v1/workspace-tool'(input, response, actor, { catalog, runtime }) {
    const toolName = input.toolName;
    if (
      actor.kind !== 'agent' ||
      !input.sessionId ||
      !catalog ||
      !isManagedWorkspaceTool(toolName) ||
      !input.toolArgs ||
      typeof input.toolArgs !== 'object' ||
      Array.isArray(input.toolArgs)
    ) {
      response.writeHead(403).end('{}');
      return;
    }
    const authorization = runtime.authorizeWorkspaceTool(
      input.sessionId,
      actor.nativeAgentId,
      toolName,
      input.toolArgs as Record<string, unknown>,
    );
    if (!authorization.allowed) {
      response
        .writeHead(403)
        .end(authorization.unbound ? '{}' : JSON.stringify({ error: authorization.reason }));
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once('close', cancel);
    try {
      const repositorySearch = isRepositoryTool(toolName);
      const timeoutMs =
        toolName === SESSION_MEMORY_TOOL_NAME
          ? 5_000
          : repositorySearch
            ? REPO_SEARCH_TIMEOUT_MS + 5_000
            : 120_000;
      const result = await catalog.invoke(toolName, input.toolArgs, {
        agentId: actor.nativeAgentId,
        workspaceRoot: authorization.workspaceRoot,
        sessionId: input.sessionId,
        workspaceFileAccess: false,
        repositorySearchAccess: repositorySearch,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      });
      response.writeHead(200).end(JSON.stringify(result));
    } finally {
      response.off('close', cancel);
    }
  },
  async '/v1/ried'(input, response, actor, { registeredWorkspace, runtime }) {
    const { sessionId, nativeAgentId: _nativeAgentId, ...toolArgs } = input;
    if (!sessionId) throw new Error('RIED requires a Session');
    const inventoryRequest = validateRiedRequest(toolArgs);
    const session = runtime.snapshot(sessionId);
    if (actor.kind === 'agent') {
      if (
        !session.members.some(
          (member) =>
            member.binding?.nativeAgentId === actor.nativeAgentId &&
            member.binding.state === 'bound',
        )
      ) {
        response.writeHead(403).end('{"error":"native agent is not bound to this session"}');
        return;
      }
    } else if (
      registeredWorkspace(sessionId) !== canonicalWorkspace(session.session.workspaceRoot)
    ) {
      response.writeHead(403).end('{"error":"session is not active in this runtime"}');
      return;
    }
    const value = await runtime.ried(sessionId, inventoryRequest);
    response.writeHead(200).end(JSON.stringify({ value }));
  },
  '/v1/tool/authorize'(input, response, actor, { runtime }) {
    if (
      actor.kind !== 'agent' ||
      !input.sessionId ||
      typeof input.toolName !== 'string' ||
      !input.input ||
      typeof input.input !== 'object' ||
      Array.isArray(input.input)
    )
      throw new Error('Bound agent, Session, toolName and input mapping required');
    const authorization = runtime.authorizeTool(
      input.sessionId,
      actor.nativeAgentId,
      input.toolName,
      input.input as Record<string, unknown>,
    );
    response.writeHead(200).end(JSON.stringify(authorization));
  },
} satisfies Record<string, ToolHandler>;

type ToolRoute = keyof typeof toolRoutes;

export function isToolRoute(path: string | undefined): path is ToolRoute {
  return path !== undefined && Object.hasOwn(toolRoutes, path);
}

export function handleToolRoute(
  route: ToolRoute,
  parsed: object,
  response: ServerResponse,
  actor: RuntimeActor,
  services: ToolRouteServices,
): void | Promise<void> {
  return toolRoutes[route](parsed as ToolRouteBody, response, actor, services);
}

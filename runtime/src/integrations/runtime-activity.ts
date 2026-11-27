import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { activityToggleRpc } from '../paseo-plugin/shared/activity.js';
import { repositoryQuerySubscription } from '../paseo-plugin/shared/repository-query.js';
import type { createColgrepProvider } from '../repository/providers/colgrep.js';
import { openRepositoryWorkspace, type RepositoryWorkspace } from '../repository/workspace.js';
import type { ConversationRecords } from '../session-memory/conversation.js';
import type { ToolCatalog } from '../tools/catalog.js';
import { repositoryEvidenceText } from '../tools/repository-evidence-text.js';
import {
  REPO_LOCATE_TOOL_NAME,
  REPO_SEARCH_TIMEOUT_MS,
  REPO_SEARCH_TOOL_NAME,
} from '../tools/workspace-tools.js';
import type { SessionSnapshot } from '../workflow-api/index.js';
import type { ActivityPreferences } from './activity-preferences.js';
import type { WorkspaceMcp } from './mcp.js';
import type { PaseoHost } from './paseo.js';
import type { PaseoWorkspaceServices } from './paseo-workspace-services.js';
import {
  workspaceActivityRpc,
  workspaceServicesRpc,
} from '../paseo-plugin/shared/workspace-services.js';

export interface ActivityServices {
  preferences: ActivityPreferences;
  colgrep: ReturnType<typeof createColgrepProvider>;
}

interface ActivityDependencies {
  activity?: ActivityServices;
  catalog?: ToolCatalog;
  workspaceServices?: PaseoWorkspaceServices;
  lastDelivered: ConversationRecords['lastDelivered'];
  readSession(sessionId: string): SessionSnapshot | undefined;
  registeredWorkspace(sessionId: string): string | undefined;
  readGrantedWorkspace(
    agentId: string,
  ): ReturnType<WorkspaceMcp['repositorySearchWorkspace']> | undefined;
  listProviderSubagents(
    agentId: string,
  ): ReturnType<PaseoHost['listProviderSubagents']> | undefined;
}

type ActivityHandler = (
  parsed: object,
  response: ServerResponse,
  dependencies: ActivityDependencies,
) => void | Promise<void>;

const repositoryQueryRequest = repositoryQuerySubscription.input.extend({
  sessionId: z.string().min(1).max(1024).optional(),
});

function activityWorkspaceIdentity(workspace: RepositoryWorkspace): string {
  return JSON.stringify([workspace.identity, workspace.cacheIdentity]);
}

function boundActivitySession(
  agentId: string,
  sessionId: string,
  dependencies: ActivityDependencies,
): SessionSnapshot | undefined {
  const session = dependencies.readSession(sessionId);
  return session?.members.some(
    ({ binding }) => binding?.state === 'bound' && binding.nativeAgentId === agentId,
  )
    ? session
    : undefined;
}

async function activityRepositoryScope(
  agentId: string,
  sessionId: string | undefined,
  dependencies: ActivityDependencies,
) {
  if (!sessionId) return { workspace: await dependencies.readGrantedWorkspace(agentId) };
  const session = boundActivitySession(agentId, sessionId, dependencies);
  if (!session) return undefined;
  const root = dependencies.registeredWorkspace(sessionId);
  const workspace =
    root === session.session.workspaceRoot
      ? await openRepositoryWorkspace(root)
          .then((opened) => (opened.root === root ? opened : undefined))
          .catch(() => undefined)
      : undefined;
  return { session, workspace };
}

const activityRoutes = {
  async '/v1/activity/workspace-touch'(parsed, response, dependencies) {
    const { workspaceId } = workspaceActivityRpc.input.parse(parsed);
    const service = dependencies.workspaceServices;
    if (!service) {
      response.writeHead(503).end('{"error":"Workspace Services are unavailable."}');
      return;
    }
    await service.recordActivity(workspaceId);
    response.writeHead(200).end(JSON.stringify({ recorded: true }));
  },
  '/v1/activity/workspace-services'(parsed, response, dependencies) {
    workspaceServicesRpc.input.parse(parsed);
    const service = dependencies.workspaceServices;
    if (!service) {
      response.writeHead(503).end('{"error":"Workspace Services are unavailable."}');
      return;
    }
    response
      .writeHead(200)
      .end(JSON.stringify(workspaceServicesRpc.output.parse(service.status())));
  },
  '/v1/activity/toggle'(parsed, response, dependencies) {
    const { feature, enabled } = activityToggleRpc.input.parse(parsed);
    const activity = dependencies.activity;
    if (!activity) {
      response.writeHead(503).end('{"error":"This Activity control is unavailable."}');
      return;
    }
    activity.preferences.set(feature, enabled);
    activity.colgrep.setIndexingEnabled(enabled);
    response.writeHead(200).end(JSON.stringify({ enabled }));
  },
  async '/v1/activity/repository-query'(parsed, response, dependencies) {
    const input = repositoryQueryRequest.safeParse(parsed);
    if (!input.success) {
      response.writeHead(400).end('{"error":"Invalid repository query request."}');
      return;
    }
    const { catalog } = dependencies;
    if (!catalog) {
      response.writeHead(503).end('{"error":"LTCook repository tools are unavailable."}');
      return;
    }
    const { agentId, sessionId, workspaceIdentity, request } = input.data;
    const connection = new AbortController();
    const cancel = () => connection.abort();
    response.once('close', cancel);
    if (response.destroyed) cancel();
    const deadline = AbortSignal.timeout(REPO_SEARCH_TIMEOUT_MS);
    const signal = AbortSignal.any([connection.signal, deadline]);
    try {
      const scope = await activityRepositoryScope(agentId, sessionId, dependencies);
      signal.throwIfAborted();
      const workspace = scope?.workspace;
      if (!workspace) {
        response.writeHead(403).end('{"error":"The repository search scope is unavailable."}');
        return;
      }
      if (activityWorkspaceIdentity(workspace) !== workspaceIdentity) {
        response
          .writeHead(409)
          .end('{"error":"The worktree changed. Reopen Query Repo from Activity."}');
        return;
      }
      const name = request.tool === 'search' ? REPO_SEARCH_TOOL_NAME : REPO_LOCATE_TOOL_NAME;
      const result = await catalog.invoke(name, request.input, {
        agentId,
        sessionId,
        workspaceRoot: workspace.root,
        workspaceFileAccess: false,
        repositorySearchAccess: true,
        repositoryWorkspace: workspace,
        signal,
      });
      await workspace.assertUnchanged();
      const current = (await activityRepositoryScope(agentId, sessionId, dependencies))?.workspace;
      signal.throwIfAborted();
      if (
        !current ||
        current.root !== workspace.root ||
        activityWorkspaceIdentity(current) !== workspaceIdentity
      ) {
        response.writeHead(403).end('{"error":"The repository search scope is unavailable."}');
        return;
      }
      response.writeHead(200).end(JSON.stringify({ text: repositoryEvidenceText(name, result) }));
    } catch (error) {
      if (connection.signal.aborted) return;
      if (deadline.aborted) {
        response.writeHead(504).end('{"error":"The repository tool timed out."}');
        return;
      }
      const message =
        error instanceof Error && error.message === 'Invalid tool arguments.'
          ? error.message
          : 'The repository tool could not run. Check its arguments and workspace access.';
      response.writeHead(400).end(JSON.stringify({ error: message }));
    } finally {
      response.off('close', cancel);
    }
  },
  async '/v1/activity/services'(parsed, response, dependencies) {
    const input = parsed as { nativeAgentId?: string; sessionId?: string };
    const agentId = input.nativeAgentId;
    if (typeof agentId !== 'string' || !agentId) {
      response.writeHead(400).end('{}');
      return;
    }
    const scope = await activityRepositoryScope(agentId, input.sessionId, dependencies);
    if (!scope) {
      response.writeHead(403).end('{}');
      return;
    }
    const { session, workspace } = scope;
    const colgrep = dependencies.activity?.colgrep;
    const [rag, subagents] = await Promise.all([
      workspace && colgrep
        ? colgrep.readStatus(workspace)
        : {
            availability: 'unavailable',
            activity: 'unknown',
            diagnostic: 'Repository search scope is unavailable.',
          },
      dependencies.listProviderSubagents(agentId)?.catch(() => undefined),
    ]);
    const assignment = session?.assignments.find(
      (value) =>
        value.nativeAgentId === agentId && (value.status === 'sending' || value.status === 'sent'),
    );
    const task = session?.tasks.find((value) => value.id === assignment?.taskId);
    response.writeHead(200).end(
      JSON.stringify({
        rag: {
          ...rag,
          indexingEnabled: dependencies.activity?.preferences.enabled('rag-index') ?? null,
        },
        task: task?.title,
        subagents,
        workspace: workspace && {
          root: workspace.root,
          identity: activityWorkspaceIdentity(workspace),
        },
        lastDelivered: session && dependencies.lastDelivered(session.session.id, agentId),
      }),
    );
  },
} satisfies Record<string, ActivityHandler>;

type ActivityRoute = keyof typeof activityRoutes;

export function isActivityRoute(path: string | undefined): path is ActivityRoute {
  return path !== undefined && Object.hasOwn(activityRoutes, path);
}

export function handleActivityRoute(
  route: ActivityRoute,
  parsed: object,
  response: ServerResponse,
  dependencies: ActivityDependencies,
): void | Promise<void> {
  return activityRoutes[route](parsed, response, dependencies);
}

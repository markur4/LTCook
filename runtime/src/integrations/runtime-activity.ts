import type { ServerResponse } from 'node:http';
import { activityToggleRpc } from '../paseo-plugin/shared/activity.js';
import type { createColgrepProvider } from '../repository/providers/colgrep.js';
import { openRepositoryWorkspace } from '../repository/workspace.js';
import type { ConversationRecords } from '../session-memory/conversation.js';
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
  async '/v1/activity/services'(parsed, response, dependencies) {
    const input = parsed as { nativeAgentId?: string; sessionId?: string };
    const agentId = input.nativeAgentId;
    if (typeof agentId !== 'string' || !agentId) {
      response.writeHead(400).end('{}');
      return;
    }
    const session = input.sessionId ? dependencies.readSession(input.sessionId) : undefined;
    if (
      session &&
      !session.members.some(
        ({ binding }) => binding?.state === 'bound' && binding.nativeAgentId === agentId,
      )
    ) {
      response.writeHead(403).end('{}');
      return;
    }
    const registeredWorkspace = session && dependencies.registeredWorkspace(session.session.id);
    const workspace = session
      ? registeredWorkspace === session.session.workspaceRoot
        ? await openRepositoryWorkspace(registeredWorkspace)
            .then((opened) => (opened.root === registeredWorkspace ? opened : undefined))
            .catch(() => undefined)
        : undefined
      : await dependencies.readGrantedWorkspace(agentId);
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
        workspace: workspace && { root: workspace.root, identity: workspace.identity },
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

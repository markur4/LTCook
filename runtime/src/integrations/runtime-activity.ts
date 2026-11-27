import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { activityToggleRpc } from '../paseo-plugin/shared/activity.js';
import {
  repositoryAgentQueryInput,
  repositoryQueryWorkspaceSubscription,
  repositoryWorkspaceQueryInput,
} from '../paseo-plugin/shared/repository-query.js';
import type { createColgrepProvider } from '../repository/providers/colgrep.js';
import type { BugScanService } from '../services/bugscan.js';
import type { BugFixService } from '../services/bugfix.js';
import { openRepositoryWorkspace, type RepositoryWorkspace } from '../repository/workspace.js';
import type { ConversationRecords } from '../session-memory/conversation.js';
import type { ToolCatalog } from '../tools/catalog.js';
import { RepositoryFilterError } from '../repository/filter.js';
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

export interface BugScanActivity {
  service: BugScanService;
  scope: string;
  requireWorkspace: boolean;
}

interface ActivityDependencies {
  shutdownSignal: AbortSignal;
  activity?: ActivityServices;
  bugScan?: BugScanActivity;
  bugFix?: BugFixService;
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

const paseoWorkspaceRoot = z.string().refine(path.isAbsolute);
const repositoryWorkspaceRequest = repositoryQueryWorkspaceSubscription.input.extend({
  workspaceRoot: paseoWorkspaceRoot,
});
const repositoryQueryRequest = z.union([
  repositoryAgentQueryInput.extend({ sessionId: z.string().min(1).max(1024).optional() }),
  repositoryWorkspaceQueryInput.extend({ workspaceRoot: paseoWorkspaceRoot }),
]);

function activityWorkspaceIdentity(workspace: RepositoryWorkspace): string {
  return JSON.stringify([workspace.identity, workspace.cacheIdentity]);
}

async function openPaseoRepositoryWorkspace(root: string) {
  const workspace = await openRepositoryWorkspace(root).catch(() => undefined);
  return workspace && path.relative(workspace.root, root) === '' ? workspace : undefined;
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
  async '/v1/activity/bugscan'(parsed, response, dependencies) {
    const input = z
      .object({
        nativeAgentId: z.string().min(1),
        sessionId: z.string().optional(),
        action: z.enum(['run', 'pause', 'resume', 'pause-fix', 'resume-fix']).default('run'),
        id: z.string().optional(),
      })
      .parse(parsed);
    const scope = await activityRepositoryScope(input.nativeAgentId, input.sessionId, dependencies);
    const bugScan = dependencies.bugScan;
    if (
      !bugScan ||
      !scope ||
      dependencies.activity?.preferences.enabled('bughunter') === false ||
      (bugScan.requireWorkspace && scope.workspace?.root !== bugScan.scope)
    ) {
      response.writeHead(403).end('{"error":"BugScan is unavailable for this scope"}');
      return;
    }
    const fixes = dependencies.bugFix;
    switch (input.action) {
      case 'run':
        await bugScan.service.trigger(bugScan.scope);
        break;
      case 'pause':
        bugScan.service.pause(bugScan.scope);
        break;
      case 'resume':
        if (
          input.id &&
          bugScan.service.list().some(({ id, scope }) => id === input.id && scope === bugScan.scope)
        )
          bugScan.service.resume(input.id);
        break;
      case 'pause-fix':
      case 'resume-fix':
        if (
          input.id &&
          fixes?.list().some(({ id, scope }) => id === input.id && scope === bugScan.scope)
        ) {
          if (input.action === 'pause-fix') fixes.pause(input.id);
          else fixes.resume(input.id);
        }
        break;
    }
    response.writeHead(200).end('{"accepted":true}');
  },
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
    if (feature === 'rag-index') activity.colgrep.setIndexingEnabled(enabled);
    else if (!enabled) {
      if (dependencies.bugScan) dependencies.bugScan.service.pause(dependencies.bugScan.scope);
      for (const bugFix of dependencies.bugFix?.list() ?? []) dependencies.bugFix?.pause(bugFix.id);
    }
    response.writeHead(200).end(JSON.stringify({ enabled }));
  },
  async '/v1/activity/repository-query-workspace'(parsed, response, { activity, shutdownSignal }) {
    const input = repositoryWorkspaceRequest.safeParse(parsed);
    if (!input.success) {
      response.writeHead(400).end('{"error":"Invalid repository workspace request."}');
      return;
    }
    const workspace = await openPaseoRepositoryWorkspace(input.data.workspaceRoot);
    if (response.destroyed) return;
    if (shutdownSignal.aborted) {
      response.writeHead(503).end('{"error":"LTCook runtime is stopping."}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    if (!workspace) {
      response.end('null\n');
      return;
    }

    // > Keep the existing scheduler authorization only while the Query Repo tab is open.
    const release = activity?.colgrep.indexService.activate(workspace);
    const cleanup = () => {
      response.off('close', cleanup);
      shutdownSignal.removeEventListener('abort', close);
      release?.();
    };
    const close = () => {
      cleanup();
      response.end();
    };
    response.once('close', cleanup);
    shutdownSignal.addEventListener('abort', close, { once: true });
    response.write(
      JSON.stringify({ identity: activityWorkspaceIdentity(workspace), path: workspace.root }) +
        '\n',
    );
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
    const query = input.data;
    const { workspaceIdentity, request } = query;
    const readWorkspace =
      'agentId' in query
        ? async () =>
            (await activityRepositoryScope(query.agentId, query.sessionId, dependencies))?.workspace
        : () => openPaseoRepositoryWorkspace(query.workspaceRoot);
    const connection = new AbortController();
    const cancel = () => connection.abort();
    response.once('close', cancel);
    if (response.destroyed) cancel();
    const deadline = AbortSignal.timeout(REPO_SEARCH_TIMEOUT_MS);
    const signal = AbortSignal.any([connection.signal, deadline, dependencies.shutdownSignal]);
    try {
      const workspace = await readWorkspace();
      signal.throwIfAborted();
      if (!workspace) {
        response.writeHead(403).end('{"error":"The repository search scope is unavailable."}');
        return;
      }
      if (activityWorkspaceIdentity(workspace) !== workspaceIdentity) {
        response
          .writeHead(409)
          .end('{"error":"The worktree changed. Reopen Query Repo for the current worktree."}');
        return;
      }
      const name = request.tool === 'search' ? REPO_SEARCH_TOOL_NAME : REPO_LOCATE_TOOL_NAME;
      const result = await catalog.invoke(name, request.input, {
        agentId: 'agentId' in query ? query.agentId : query.workspaceId,
        sessionId: 'agentId' in query ? query.sessionId : undefined,
        workspaceRoot: workspace.root,
        workspaceFileAccess: false,
        repositorySearchAccess: true,
        repositoryWorkspace: workspace,
        signal,
      });
      await workspace.assertUnchanged();
      const current = await readWorkspace();
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
      if (dependencies.shutdownSignal.aborted) {
        response.writeHead(503).end('{"error":"LTCook runtime is stopping."}');
        return;
      }
      if (deadline.aborted) {
        response.writeHead(504).end('{"error":"The repository tool timed out."}');
        return;
      }
      const message =
        error instanceof RepositoryFilterError ||
        (error instanceof Error && error.message === 'Invalid tool arguments.')
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
    const bugScan = dependencies.bugScan;
    const showBugScan = bugScan && (!bugScan.requireWorkspace || workspace?.root === bugScan.scope);
    const hunt = showBugScan ? bugScan.service.list().at(-1) : undefined;
    const fix = showBugScan ? dependencies.bugFix?.list().at(-1) : undefined;
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
        ...(showBugScan
          ? {
              bugScan: {
                status: hunt?.status ?? 'idle',
                id: hunt?.id,
                enabled: dependencies.activity?.preferences.enabled('bughunter') ?? true,
                failure: hunt?.failure,
                fix: fix && {
                  id: fix.id,
                  status: fix.status,
                  failure: fix.failure,
                  implemented: fix.operations.some(
                    ({ stage, result }) =>
                      ['implement', 'correct'].includes(stage.kind) &&
                      result?.status === 'completed',
                  ),
                  verified: Boolean(fix.verifiedTree),
                  integrated: Boolean(fix.integratedRevision),
                  installed: Boolean(fix.installedBuild),
                  recovered: fix.recoveredRemedies.length > 0,
                },
                findings:
                  hunt?.findings.map(({ confidence, cause, remedy, technicalDebt }) => ({
                    confidence,
                    cause,
                    remedy: remedy?.description,
                    technicalDebt,
                  })) ?? [],
              },
            }
          : {}),
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

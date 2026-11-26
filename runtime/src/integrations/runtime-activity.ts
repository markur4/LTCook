import type { ServerResponse } from 'node:http';
import {
  activityToggleRpc,
  memoryDeviceRpc,
  memoryInferenceRpc,
  memoryRedoRpc,
  memoryEvidenceRpc,
  storedSummariesRpc,
} from '../paseo-plugin/shared/activity.js';
import type { createColgrepProvider } from '../repository/providers/colgrep.js';
import { openRepositoryWorkspace } from '../repository/workspace.js';
import { MemorySummaryError, type SessionMemory } from '../session-memory/service.js';
import type { SessionSnapshot } from '../workflow-api/index.js';
import type { ActivityPreferences } from './activity-preferences.js';
import type { WorkspaceMcp } from './mcp.js';
import type { PaseoHost } from './paseo.js';

export interface ActivityServices {
  preferences: ActivityPreferences;
  colgrep: ReturnType<typeof createColgrepProvider>;
}

interface ActivityDependencies {
  activity?: ActivityServices;
  memoryDisabled: boolean;
  readMemory(): SessionMemory | undefined;
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
  '/v1/activity/toggle'(parsed, response, dependencies) {
    const { feature, enabled } = activityToggleRpc.input.parse(parsed);
    const activity = dependencies.activity;
    const memory = dependencies.readMemory();
    if (!activity || (feature === 'summarizer' && !memory)) {
      response.writeHead(503).end('{"error":"This Activity control is unavailable."}');
      return;
    }
    activity.preferences.set(feature, enabled);
    if (feature === 'summarizer') memory?.setSummarizationEnabled(enabled);
    else activity.colgrep.setIndexingEnabled(enabled);
    response.writeHead(200).end(JSON.stringify({ enabled }));
  },
  '/v1/activity/memory-inference'(parsed, response, dependencies) {
    const { mode } = memoryInferenceRpc.input.parse(parsed);
    const memory = dependencies.readMemory();
    const preferences = dependencies.activity?.preferences;
    if (!preferences || !memory?.inferenceSelection()) {
      response.writeHead(503).end('{"error":"Session Memory inference is unavailable."}');
      return;
    }
    preferences.setMemoryInferenceMode(mode);
    response.writeHead(200).end(JSON.stringify(memory.setInferenceMode(mode)));
  },
  async '/v1/activity/memory-device'(parsed, response, dependencies) {
    const { deviceId } = memoryDeviceRpc.input.parse(parsed);
    const memory = dependencies.readMemory();
    if (!memory) {
      response.writeHead(503).end('{"error":"Session Memory is unavailable."}');
      return;
    }
    if (memory.inferenceSelection()?.mode === 'hosted') {
      response
        .writeHead(409)
        .end('{"error":"Device selection is available for Local Session Memory."}');
      return;
    }
    const device = await memory.device(deviceId);
    response.writeHead(200).end(JSON.stringify(device));
  },
  async '/v1/activity/memory-redo'(parsed, response, dependencies) {
    const input = memoryRedoRpc.input.parse(parsed);
    const memory = dependencies.readMemory();
    if (!memory) {
      response.writeHead(503).end('{"error":"Session Memory is unavailable."}');
      return;
    }
    try {
      const result =
        input.scope === 'passage'
          ? memory.redoSummaries(input.agentId, {
              epoch: input.passage.epoch,
              scope: 'passage',
              passage: input.passage,
            })
          : memory.redoSummaries(input.agentId, {
              epoch: input.epoch,
              scope: 'from',
              position: input.position,
            });
      response.writeHead(200).end(JSON.stringify(result));
    } catch (error) {
      const status = error instanceof MemorySummaryError ? 409 : 500;
      response
        .writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: error instanceof Error ? error.message : 'Redo failed.' }));
    }
  },
  async '/v1/activity/memory-evidence'(parsed, response, dependencies) {
    const memory = dependencies.readMemory();
    if (!memory) {
      response.writeHead(503).end('{"error":"Session Memory is unavailable."}');
      return;
    }
    const { agentId, after, ...record } = memoryEvidenceRpc.input.parse(parsed);
    const references = await memory.readEvidenceReferences(agentId, record, after);
    response.writeHead(200).end(JSON.stringify(references));
  },
  async '/v1/activity/stored-summaries'(parsed, response, dependencies) {
    const { agentId, before, includeContent, passage } = storedSummariesRpc.input.parse(parsed);
    const memory = dependencies.readMemory();
    if (!memory) {
      response.writeHead(503).end('{"error":"Session Memory is unavailable."}');
      return;
    }
    const page = await memory.readStoredSummaries(agentId, before, {
      includeContent,
      passage,
    });
    response.writeHead(200).end(JSON.stringify(page));
  },
  async '/v1/activity/services'(parsed, response, dependencies) {
    const input = parsed as { nativeAgentId?: string; sessionId?: string };
    const agentId = input.nativeAgentId;
    if (typeof agentId !== 'string' || !agentId) {
      response.writeHead(400).end('{}');
      return;
    }
    const timelineEpoch =
      'timelineEpoch' in parsed && typeof parsed.timelineEpoch === 'string'
        ? parsed.timelineEpoch
        : undefined;
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
    const memory = dependencies.readMemory()?.status(session?.session.id, agentId, timelineEpoch);
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
        memory,
        memoryDisabled: dependencies.memoryDisabled,
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

import path from 'node:path';
import type { PaseoApi } from '@getpaseo/client';
import { z } from 'zod';
import { defineRpc } from '@getpaseo/plugin';
import { EvalRequestSchema, EvalResponseSchema } from './shared/evals';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import {
  PanelDetailSourceSchema,
  TeamDetailRequestSchema,
  TeamDetailResponseSchema,
  panelDetail,
} from './shared/panel-details';
const teamDetail = defineRpc({
  name: 'ltcook.team.detail',
  input: TeamDetailRequestSchema,
  output: TeamDetailResponseSchema,
});
const evalsDiagnostics = defineRpc({
  name: 'ltcook.evals.diagnostics',
  input: EvalRequestSchema,
  output: EvalResponseSchema,
});
import {
  panelSnapshot,
  PanelSnapshotSourceSchema,
  TeamSnapshotRequestSchema,
  TeamSnapshotResponseSchema,
} from './shared/panel-snapshot';

import {
  TeamCatalogRequestSchema,
  TeamCatalogResponseSchema,
  SessionListRequestSchema,
  SessionListResponseSchema,
  SessionOpenRequestSchema,
  SessionOpenResponseSchema,
} from './shared/team-catalog';
const teamCatalog = defineRpc({
  name: 'ltcook.team.catalog',
  input: TeamCatalogRequestSchema,
  output: TeamCatalogResponseSchema,
});
const sessionList = defineRpc({
  name: 'ltcook.session.list',
  input: SessionListRequestSchema,
  output: SessionListResponseSchema,
});

const teamSnapshot = defineRpc({
  name: 'ltcook.team.snapshot',
  input: TeamSnapshotRequestSchema,
  output: TeamSnapshotResponseSchema,
});
const openSession = defineRpc({
  name: 'ltcook.session.open',
  input: SessionOpenRequestSchema,
  output: SessionOpenResponseSchema,
});

function runtimeConfig() {
  const endpoint = process.env.LTCOOK_RUNTIME_API_URL;
  const token = process.env.LTCOOK_RUNTIME_USER_TOKEN;
  if (!endpoint || !token) throw new Error('LTCook runtime API is not available');
  return {
    endpoint,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  };
}

async function runtimeRequest(
  endpoint: string,
  headers: Record<string, string>,
  path: string,
  body: unknown,
) {
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(5000) as NonNullable<Parameters<typeof fetch>[1]>['signal'],
    headers,
    body: JSON.stringify(body),
  });
  let payload: unknown;
  let detail = '';
  if (!response.ok) {
    try {
      payload = await response.json();
      if (
        payload &&
        typeof payload === 'object' &&
        'error' in payload &&
        typeof payload.error === 'string'
      ) {
        detail = `: ${payload.error}`;
      }
    } catch {
      // Keep the HTTP status when the runtime does not return a JSON error.
    }
  }
  return { response, detail, payload };
}

const preparedSession = z.object({
  env: z.record(z.string(), z.string()),
  mcpServers: z
    .record(
      z.string(),
      z.object({
        type: z.literal('http'),
        url: z.string().url(),
        headers: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
});

async function runtimeJson(path: string, body: unknown) {
  const { endpoint, headers } = runtimeConfig();
  const { response, detail } = await runtimeRequest(endpoint, headers, path, body);
  if (!response.ok) throw new Error(`LTCook request failed (${response.status})${detail}`);
  return response.json();
}

async function runtimeSnapshot(sessionId: string, paseo: PaseoApi, leaderAgentId = sessionId) {
  const { endpoint, headers } = runtimeConfig();
  const result = await runtimeRequest(endpoint, headers, '/v1/snapshot', { sessionId });
  if (
    result.response.status !== 400 ||
    !result.payload ||
    typeof result.payload !== 'object' ||
    !('error' in result.payload) ||
    result.payload.error !== 'Session is not active in this runtime'
  )
    return result;
  const native = await paseo.agents.ref(leaderAgentId).refresh();
  const profileLeader = native?.agent.provider === 'ltcook' && native.agent.id === sessionId;
  const managedLeader =
    native?.agent.provider === 'pi' &&
    native.agent.labels['ltcook.member'] === 'leader' &&
    native.agent.labels['ltcook.session'] === sessionId;
  const teamSelection = profileLeader
    ? native.agent.metadata?.['ltcook.team']
    : managedLeader
      ? native.agent.labels['ltcook.team']
      : undefined;
  if (
    !native ||
    native.agent.id !== leaderAgentId ||
    !native.agent.cwd ||
    typeof teamSelection !== 'string' ||
    !teamSelection
  )
    throw new Error(
      'Saved LTCook Leader identity is unavailable. Open a supported Leader conversation.',
    );
  return runtimeRequest(endpoint, headers, '/v1/snapshot', {
    sessionId,
    leaderAgentId: native.agent.id,
    workspaceRoot: native.agent.cwd,
    teamSelection,
  });
}

async function listSessions(input: z.infer<typeof SessionListRequestSchema>, paseo: PaseoApi) {
  const response = SessionListResponseSchema.parse(await runtimeJson('/v1/session/list', input));
  const sessions = await Promise.all(
    response.sessions.map(async (session) => {
      if (!session.leaderAgentId || session.blocker)
        return {
          ...session,
          status: 'unavailable',
          blocker: session.blocker ?? 'Leader binding is unavailable; inspect this Session.',
        };
      const native = await paseo.agents.ref(session.leaderAgentId).refresh();
      if (!native)
        return {
          ...session,
          status: 'unavailable',
          blocker:
            'Saved native Leader is missing; inspect this Session before starting a replacement.',
        };
      if (native.agent.archivedAt) return null;
      return {
        ...session,
        title: native.agent.title,
        status: native.agent.status ?? 'unknown',
        lastActivityAt: native.agent.updatedAt,
      };
    }),
  );
  return {
    sessions: sessions
      .filter((session) => session !== null)
      .sort((a, b) =>
        (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt),
      ),
  };
}

export default function contribute(server: PluginServerContext) {
  const cleanup = [
    server.addHook('agent.create.before', async ({ request }) => {
      if (request.config.provider.split('/')[0] !== 'ltcook') return;
      const selection = request.metadata?.['ltcook.team'];
      if (typeof selection !== 'string' || !selection)
        throw new Error('Choose an installed Team before starting LTCook.');
      const catalog = z
        .object({ teams: z.array(z.object({ selection: z.string(), status: z.string() })) })
        .parse(await runtimeJson('/v1/team/catalog', {}));
      if (
        !catalog.teams.some((team) => team.selection === selection && team.status === 'installed')
      )
        throw new Error('Selected Team is unavailable. Choose an installed Team.');
      return request;
    }),
    server.addHook('agent.open.before', async ({ request }) => {
      if (request.provider !== 'ltcook' || request.purpose === 'history') return;
      const teamSelection = request.metadata['ltcook.team'];
      if (typeof teamSelection !== 'string' || !teamSelection)
        throw new Error(
          'This LTCook conversation has no supported Team identity. Start a new Session.',
        );
      const identity = {
        sessionId: request.agentId,
        leaderAgentId: request.agentId,
        workspaceRoot: request.cwd,
        teamSelection,
      };
      await runtimeJson('/v1/session/open', identity);
      const prepared = preparedSession.parse(await runtimeJson('/v1/session/prepare', identity));
      return {
        ...request,
        env: { ...request.env, ...prepared.env },
        mcpServers: { ...request.mcpServers, ...prepared.mcpServers },
      };
    }),
  ];
  server.handle(teamCatalog, async () =>
    TeamCatalogResponseSchema.parse(await runtimeJson('/v1/team/catalog', {})),
  );
  server.handle(sessionList, async (input, { paseo }) => listSessions(input, paseo));
  server.handle(evalsDiagnostics, async (input) => {
    const { endpoint, headers } = runtimeConfig();
    const routes = {
      start: '/v1/evals/start',
      list: '/v1/evals/list',
      status: '/v1/evals/status',
      report: '/v1/evals/report',
      cancel: '/v1/evals/cancel',
      delete: '/v1/evals/delete',
    };
    const { response, detail } = await runtimeRequest(endpoint, headers, routes[input.action], {
      ...(input.setup ? { setup: input.setup } : {}),
      ...(input.staticOnly !== undefined ? { staticOnly: input.staticOnly } : {}),
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      ...(input.preset ? { preset: input.preset } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
    });
    if (!response.ok)
      throw new Error(`Agent Evals diagnostics unavailable (${response.status})${detail}`);
    return response.json();
  });
  server.handle(teamDetail, async (input, { paseo }) => {
    const { response, detail, payload } = await runtimeSnapshot(
      input.sessionId,
      paseo,
      input.leaderAgentId,
    );
    if (
      response.status === 404 &&
      payload &&
      typeof payload === 'object' &&
      'code' in payload &&
      payload.code === 'SESSION_NOT_FOUND' &&
      'error' in payload &&
      payload.error === 'No session found for workspace'
    )
      return null;
    if (!response.ok)
      throw new Error(`LTCook team detail unavailable (${response.status})${detail}`);
    return panelDetail(PanelDetailSourceSchema.parse(await response.json()), input.target);
  });
  server.handle(teamSnapshot, async (input, { paseo }) => {
    const { response, detail, payload } = await runtimeSnapshot(
      input.sessionId,
      paseo,
      input.leaderAgentId,
    );
    if (
      response.status === 404 &&
      payload &&
      typeof payload === 'object' &&
      'code' in payload &&
      payload.code === 'SESSION_NOT_FOUND' &&
      'error' in payload &&
      payload.error === 'No session found for workspace'
    ) {
      return null;
    }
    if (!response.ok)
      throw new Error(`LTCook team snapshot unavailable (${response.status})${detail}`);
    const snapshot = PanelSnapshotSourceSchema.parse(await response.json());
    return panelSnapshot(snapshot);
  });
  server.handle(openSession, async (input, { paseo }) => {
    if (!input.newSession) {
      const existing = await listSessions(
        { workspaceRoot: input.workspaceRoot, teamSelection: input.teamSelection },
        paseo,
      );
      const selected = input.leaderAgentId
        ? existing.sessions.find((session) => session.leaderAgentId === input.leaderAgentId)
        : existing.sessions.find((session) => session.leaderAgentId && !session.blocker);
      if (selected?.leaderAgentId && !selected.blocker)
        return {
          sessionId: selected.sessionId,
          workspaceRoot: selected.workspaceRoot,
          leaderAgentId: selected.leaderAgentId,
        };
      const blocked = selected ?? existing.sessions.find((session) => session.blocker);
      if (blocked)
        throw new Error(
          `${blocked.blocker ?? 'Requested Leader is unavailable.'} Use New Session only to start a separate conversation.`,
        );
      if (input.leaderAgentId)
        throw new Error('Requested Leader is unavailable in this Workspace and Team.');
    }
    const catalog = TeamCatalogResponseSchema.parse(await runtimeJson('/v1/team/catalog', {}));
    const team = catalog.teams.find(
      (team) => team.selection === input.teamSelection && team.status === 'installed',
    );
    if (!team) throw new Error('Choose an installed Team.');
    const available = await paseo.providers.listModels('ltcook');
    const model = available.models?.find((model) => model.isDefault) ?? available.models?.[0];
    if (available.error || !model)
      throw new Error('Configure an available LTCook model in Paseo before starting a Session.');
    const agentId = crypto.randomUUID();
    const leader = await paseo.agents.create({
      agentId,
      idempotencyKey: agentId,
      cwd: input.workspaceRoot,
      config: { provider: `ltcook/${model.id}` },
      title: `${path.basename(input.workspaceRoot)} · ${team.name}`,
      metadata: { 'ltcook.team': team.selection },
    });
    return { sessionId: leader.id, leaderAgentId: leader.id, workspaceRoot: input.workspaceRoot };
  });
  return () => cleanup.forEach((dispose) => dispose());
}

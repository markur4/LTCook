import path from 'node:path';
import type { PaseoApi } from '@getpaseo/client';
import { z } from 'zod';
import { defineRpc, PluginAttachmentItemSchema } from '@getpaseo/plugin';
import { EvalRequestSchema, EvalResponseSchema } from './shared/evals';
import { activitySubscription } from './shared/activity';
import { observeActivity, observedTimestamp } from './server/activity';
import { WORKSPACE_MCP_SERVER } from './shared/workspace-tools';
import { discardPastedTextRpc, pastedTextRpc, pastedTextSearchRpc } from './shared/pasted-text';
import {
  ModelCatalogRequestSchema,
  ModelCatalogResponseSchema,
  ResolvedModelSchema,
  MODEL_ALIAS_METADATA_KEY,
  MODEL_REASONING_METADATA_KEY,
  RESOLVED_MODEL_METADATA_KEY,
} from './shared/models';
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
const modelCatalog = defineRpc({
  name: 'ltcook.model.catalog',
  input: ModelCatalogRequestSchema,
  output: ModelCatalogResponseSchema,
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
  signal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(5000);
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    signal: (signal ? AbortSignal.any([signal, timeout]) : timeout) as NonNullable<
      Parameters<typeof fetch>[1]
    >['signal'],
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

async function runtimeJson(path: string, body: unknown, signal?: AbortSignal) {
  const { endpoint, headers } = runtimeConfig();
  const { response, detail } = await runtimeRequest(endpoint, headers, path, body, signal);
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

const activityServices = z.object({
  rag: z.object({
    availability: z.enum(['ready', 'not-ready', 'unavailable', 'unknown']),
    activity: z.enum([
      'idle',
      'checking',
      'indexing',
      'updating',
      'interrupted',
      'error',
      'unknown',
    ]),
    diagnostic: z.string().nullable(),
  }),
  workspace: z.object({ root: z.string(), identity: z.string() }).optional(),
  task: z.string().optional(),
  memoryDisabled: z.boolean().optional(),
  memory: z
    .object({
      summarization: z.enum([
        'summarizing',
        'queued',
        'up-to-date',
        'below-threshold',
        'failed',
        'unknown',
      ]),
      lastSuccessfulSummaryAt: z.string().nullable(),
      lastError: z.object({ message: z.string() }).nullable(),
      stored: z
        .object({ uamp: z.number().int().nonnegative(), aab: z.number().int().nonnegative() })
        .nullable(),
      lastDelivered: z
        .object({
          sourceAgentId: z.string(),
          recipientAgentId: z.string(),
          deliveredAt: z.string(),
          bytes: z.number().int().nonnegative(),
          uamp: z.number().int().nonnegative(),
          aab: z.number().int().nonnegative(),
        })
        .nullable(),
      pendingUamp: z.number().int().nonnegative().nullable(),
      pendingAab: z.number().int().nonnegative().nullable(),
    })
    .optional(),
  subagents: z
    .array(
      z.object({
        id: z.string(),
        parentAgentId: z.string(),
        parentSubagentId: z.string().nullable().optional(),
        provider: z.string(),
        title: z.string().nullable(),
        status: z.enum(['running', 'completed', 'failed', 'canceled']),
        updatedAt: z.string(),
        cwd: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

export default function contribute(server: PluginServerContext) {
  server.handle(activitySubscription, ({ agentId }, { paseo, signal, push }) =>
    observeActivity(
      paseo,
      agentId,
      signal,
      push,
      async (agent, observerSignal, timelineEpoch) => {
        const sessionId = agent.provider === 'ltcook' ? agent.id : agent.labels['ltcook.session'];
        const { endpoint, headers } = runtimeConfig();
        const response = await fetch(`${endpoint}/v1/activity/services`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ nativeAgentId: agent.id, sessionId, timelineEpoch }),
          signal: AbortSignal.any([observerSignal, AbortSignal.timeout(5000)]) as NonNullable<
            Parameters<typeof fetch>[1]
          >['signal'],
        }).catch(() => undefined);
        const parsed = activityServices.safeParse(
          response?.ok ? await response.json().catch(() => undefined) : undefined,
        );
        const services = parsed.success ? parsed.data : undefined;
        const workspace = services?.workspace;
        const memory = services?.memory;
        const delivery = memory?.lastDelivered;
        const source = delivery?.sourceAgentId
          ? (
              await paseo.agents
                .ref(delivery.sourceAgentId)
                .refresh()
                .catch(() => null)
            )?.agent.title
          : undefined;
        return {
          task: services?.task,
          providerSubagents: (services?.subagents ?? [])
            .filter((child) => child.parentAgentId === agent.id && !child.parentSubagentId)
            .map((child) => ({
              id: child.id,
              name: child.title || child.provider,
              worktree: child.cwd
                ? { id: child.cwd, name: path.basename(child.cwd) || child.cwd, path: child.cwd }
                : null,
              status:
                child.status === 'completed' || child.status === 'canceled'
                  ? 'finished'
                  : child.status,
              updatedAt: observedTimestamp(child.updatedAt),
              context: null,
              tools: null,
              skills: null,
              canOpenConversation: false,
            })),
          rag: {
            worktree: workspace
              ? {
                  id: workspace.identity,
                  name: path.basename(workspace.root),
                  path: workspace.root,
                }
              : null,
            provider: 'ColGREP',
            availability: services?.rag.availability ?? 'unknown',
            activity: services?.rag.activity ?? 'unknown',
            ...(services?.rag.diagnostic ? { diagnostic: services.rag.diagnostic } : {}),
          },
          memory: {
            scopeLabel: 'Selected agent storage',
            context: null,
            contextStage: delivery ? 'delivered' : 'unknown',
            summarization: services?.memoryDisabled
              ? 'disabled'
              : (memory?.summarization ?? 'unknown'),
            lastSummaryAt: memory?.lastSuccessfulSummaryAt
              ? observedTimestamp(memory.lastSuccessfulSummaryAt)
              : null,
            pendingUamp: memory?.pendingUamp ?? null,
            pendingAab: memory?.pendingAab ?? null,
            uamp: { inContext: null, stored: memory?.stored?.uamp ?? null },
            aab: { inContext: null, stored: memory?.stored?.aab ?? null },
            ...(memory?.lastError?.message ? { diagnostic: memory.lastError.message } : {}),
            ...(delivery
              ? {
                  sourceLabel: source ?? 'Leader',
                  recipientLabel: agent.title ?? 'Selected agent',
                  lastDelivery: {
                    at: observedTimestamp(delivery.deliveredAt),
                    bytes: delivery.bytes,
                    uamp: delivery.uamp,
                    aab: delivery.aab,
                  },
                }
              : {}),
          },
        };
      },
      async (agent, observerSignal) => {
        const sessionId = agent.provider === 'ltcook' ? agent.id : agent.labels['ltcook.session'];
        if (!sessionId) return undefined;
        const { value: reports } = z
          .object({
            value: z.array(
              z.object({
                id: z.string(),
                inspection: z.object({
                  diagnostics: z.array(z.unknown()),
                  resources: z.array(
                    z.object({
                      name: z.string(),
                      path: z.string(),
                      kind: z.enum(['skill', 'rule']),
                      applicable: z.boolean(),
                      loaded: z.boolean(),
                    }),
                  ),
                }),
              }),
            ),
          })
          .parse(
            await runtimeJson(
              '/v1/command',
              { sessionId, command: { type: 'guidance.inspect', nativeAgentId: agent.id } },
              observerSignal,
            ),
          );
        return reports
          .find((report) => report.id === agent.id && !report.inspection.diagnostics.length)
          ?.inspection.resources.filter(
            (resource) => resource.kind === 'skill' && resource.applicable && resource.loaded,
          );
      },
    ),
  );

  server.handle(pastedTextSearchRpc, async () => ({ items: [] }));
  server.handle(discardPastedTextRpc, async ({ id }) => {
    await runtimeJson('/v1/session-memory/paste', { discard: id });
    return {};
  });
  server.handle(pastedTextRpc, async ({ query }) => {
    if (!query.trim()) return { items: [] };
    const item = PluginAttachmentItemSchema.parse(
      await runtimeJson('/v1/session-memory/paste', { text: query }),
    );
    return { items: [item] };
  });
  const observeMemory = (
    agent: { id: string; provider: string },
    event: Record<string, unknown> = {},
  ) => {
    if (['ltcook', 'pi', 'codex'].includes(agent.provider)) {
      void runtimeJson('/v1/session-memory/observe', { nativeAgentId: agent.id, ...event }).catch(
        () => {},
      );
    }
  };
  const cleanup = [
    server.addHook('agent.turn.before', async ({ agent, turnId }, context) => {
      const model = ResolvedModelSchema.safeParse(agent.metadata[RESOLVED_MODEL_METADATA_KEY]);
      const reference = context.paseo.agents.ref(agent.id);
      const current = model.success
        ? reference.current()
        : (reference.current() ?? (await reference.refresh().catch(() => undefined))?.agent);
      const local =
        (model.success && model.data.provider === 'ollama') ||
        current?.model?.startsWith('ollama/') === true;
      observeMemory(agent, { turnId, outcome: 'running', local });
    }),
    server.addHook('agent.turn.after', async ({ agent, turnId, outcome }) =>
      observeMemory(agent, { turnId, outcome: outcome.kind }),
    ),
    server.addHook('agent.close.after', async ({ agent }) =>
      observeMemory(agent, { closed: true }),
    ),
    server.addHook('agent.create.before', async ({ request }) => {
      if (request.config.provider.split('/')[0] !== 'ltcook') return;
      const selection = request.metadata?.['ltcook.team'];
      if (typeof selection !== 'string' || !selection)
        throw new Error('Choose an installed Team before starting LTCook.');
      const selected = ResolvedModelSchema.parse(
        await runtimeJson('/v1/model/resolve', {
          teamSelection: selection,
          workspaceRoot: request.config.cwd,
          alias: request.metadata?.[MODEL_ALIAS_METADATA_KEY],
          reasoning: request.metadata?.[MODEL_REASONING_METADATA_KEY],
        }),
      );
      return {
        ...request,
        config: {
          ...request.config,
          provider: 'ltcook',
          model: `${selected.provider}/${selected.model}`,
          thinkingOptionId: selected.reasoning === 'none' ? 'off' : selected.reasoning,
        },
        metadata: { ...request.metadata, [RESOLVED_MODEL_METADATA_KEY]: selected },
      };
    }),
    server.addHook('agent.open.before', async ({ request }) => {
      if (request.purpose !== 'interactive') return;
      if (request.provider !== 'ltcook') {
        if (!['pi', 'codex'].includes(request.provider) || request.labels['ltcook.session']) return;
        const { token } = z.object({ token: z.string() }).parse(
          await runtimeJson('/v1/mcp/grant', {
            nativeAgentId: request.agentId,
            workspaceRoot: request.cwd,
            provider: request.provider,
          }),
        );
        const { endpoint } = runtimeConfig();
        return {
          ...request,
          env: {
            ...request.env,
            LTCOOK_WORKSPACE_MCP: WORKSPACE_MCP_SERVER,
            LTCOOK_RUNTIME_USER_TOKEN: '',
            LTCOOK_API_TOKEN: '',
          },
          mcpServers: {
            ...request.mcpServers,
            [WORKSPACE_MCP_SERVER]: {
              type: 'http',
              url: `${endpoint}/mcp`,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        };
      }
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
      const savedModel = ResolvedModelSchema.safeParse(
        request.metadata[RESOLVED_MODEL_METADATA_KEY],
      );
      if (!savedModel.success)
        throw new Error(
          'This conversation has no saved LTCook model selection. Start a new Session.',
        );
      await runtimeJson('/v1/session/open', identity);
      const prepared = preparedSession.parse(
        await runtimeJson('/v1/session/prepare', { ...identity, savedModel: savedModel.data }),
      );
      return {
        ...request,
        env: { ...request.env, ...prepared.env },
        mcpServers: { ...request.mcpServers, ...prepared.mcpServers },
      };
    }),
    server.addHook('agent.archive.after', async ({ agent }) => {
      if (!['ltcook', 'pi', 'codex'].includes(agent.provider)) return;
      observeMemory(agent, { force: true });
      await runtimeJson('/v1/mcp/revoke', { nativeAgentId: agent.id });
    }),
  ];
  server.handle(teamCatalog, async () =>
    TeamCatalogResponseSchema.parse(await runtimeJson('/v1/team/catalog', {})),
  );
  server.handle(modelCatalog, async (input) =>
    ModelCatalogResponseSchema.parse(await runtimeJson('/v1/model/catalog', input)),
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
      ...(input.repetitions !== undefined ? { repetitions: input.repetitions } : {}),
      ...(input.scenario ? { scenario: input.scenario } : {}),
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
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

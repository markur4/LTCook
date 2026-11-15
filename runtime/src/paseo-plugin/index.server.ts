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
  SessionOpenRequestSchema,
  SessionOpenResponseSchema,
  TeamSnapshotRequestSchema,
  TeamSnapshotResponseSchema,
} from './shared/panel-snapshot';

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

export default function contribute(server: PluginServerContext) {
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
      ...(input.preset ? { preset: input.preset } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
    });
    if (!response.ok)
      throw new Error(`Agent Evals diagnostics unavailable (${response.status})${detail}`);
    return response.json();
  });
  server.handle(teamDetail, async (input) => {
    const { endpoint, headers } = runtimeConfig();
    const { response, detail, payload } = await runtimeRequest(endpoint, headers, '/v1/snapshot', {
      workspaceRoot: input.workspaceRoot,
    });
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
  server.handle(teamSnapshot, async (input) => {
    const { endpoint, headers } = runtimeConfig();
    const { response, detail, payload } = await runtimeRequest(
      endpoint,
      headers,
      '/v1/snapshot',
      input,
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
  server.handle(openSession, async (input) => {
    const { endpoint, headers } = runtimeConfig();
    const teamSelection = process.env.LTCOOK_TEAM;
    if (!teamSelection) throw new Error('LTCook team selection is not available');
    const { response, detail } = await runtimeRequest(endpoint, headers, '/v1/session/open', {
      workspaceRoot: input.workspaceRoot,
      sessionId: crypto.randomUUID(),
      teamSelection,
    });
    if (!response.ok) {
      throw new Error(`LTCook session could not be started (${response.status})${detail}`);
    }
    return SessionOpenResponseSchema.parse(await response.json());
  });
  return () => undefined;
}

import type { GuidanceInspection } from '../guidance-api/index.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { setTimeout } from 'node:timers';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentRuntimeCommandInputSchema } from '../workflow-api/commands.js';
import { Type } from 'typebox';
import { RiedService, type RiedRequest } from '../ried.js';
import { selectedTeam } from './team-loader.js';
import { nativeToolAllowed } from './native-policy.js';
import { decisionTitle, readPlanForApproval } from './planning-dialogs.js';
const require = createRequire(import.meta.url);
async function activateOptionalBrowser(pi: ExtensionAPI): Promise<void> {
  if (process.env.LTCOOK_BROWSER_ENABLED !== 'true') return;
  try {
    const extensionPath =
      require.resolve('pi-agent-browser-native/dist/extensions/agent-browser/index.js');
    const extension = (await import(pathToFileURL(extensionPath).href)) as {
      default?: (api: ExtensionAPI) => void | Promise<void>;
    };
    if (typeof extension.default !== 'function')
      throw new Error('Native browser extension entrypoint unavailable');
    await extension.default(pi);
  } catch {
    console.warn(
      'Optional native browser extension failed to load; core chat and search remain available.',
    );
  }
}

export default async function activate(
  pi: ExtensionAPI,
  inspection?: () => GuidanceInspection,
): Promise<void> {
  const nativeAgentId = process.env.LTCOOK_NATIVE_AGENT_ID;
  const sessionId = process.env.LTCOOK_SESSION_ID;
  const teamInstanceId = process.env.LTCOOK_TEAM_INSTANCE_ID;
  const teamId = process.env.LTCOOK_TEAM_ID;
  const memberKey = process.env.LTCOOK_MEMBER_KEY;
  const endpoint = process.env.LTCOOK_RUNTIME_API_URL;
  const token = process.env.LTCOOK_AGENT_API_TOKEN;
  const teamSelection = process.env.LTCOOK_TEAM;
  if (
    !nativeAgentId ||
    !sessionId ||
    !teamInstanceId ||
    !teamId ||
    !memberKey ||
    !endpoint ||
    !token ||
    !teamSelection
  ) {
    if (nativeAgentId)
      throw new Error('Managed native identity and authenticated runtime context are incomplete.');
    return;
  }

  const team = await selectedTeam(teamSelection);
  if (team.definition.id !== teamId)
    throw new Error('Selected native team does not match the active session');
  const rpc = async (pathname: string, payload: Record<string, unknown>): Promise<Response> =>
    fetch(`${endpoint}${pathname}`, {
      signal: globalThis.AbortSignal.timeout(pathname === '/v1/ried' ? 30000 : 3000) as NonNullable<
        Parameters<typeof fetch>[1]
      >['signal'],
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, nativeAgentId, ...payload }),
    });
  if (process.env.LTCOOK_EVAL_ARM) {
    const observe = async (value: Record<string, unknown>) => {
      const response = await rpc('/v1/evaluation/observe', value);
      if (!response.ok) throw new Error('Evaluation observation unavailable');
    };
    pi.on('agent_start', async (_event, context) => {
      await observe({ kind: 'prompt', prompt: context.getSystemPrompt() });
    });
    pi.on('before_provider_request', async (_event, context) => {
      if (
        context.model?.id !== 'ltcook-spark-x2.6-4b-q8_0-ctx8192:latest' ||
        context.model.provider !== 'ollama' ||
        context.model.baseUrl !== `${process.env.LTCOOK_EVAL_ENDPOINT}/v1`
      )
        throw new Error('Evaluation model pin violation');
      await observe({ kind: 'model.start' });
    });
    pi.on('before_provider_headers', (event) => {
      event.headers['x-ltcook-member'] = memberKey;
    });
    pi.on('message_end', async (event) => {
      if (event.message.role === 'assistant')
        await observe({
          kind: 'model.end',
          usage: event.message.usage,
          stopReason: event.message.stopReason,
        });
    });
    const fixtureVerifications = new Set<string>();
    pi.on('tool_execution_start', async (event) => {
      if (
        event.toolName === 'bash' &&
        typeof event.args?.command === 'string' &&
        /(?:^|&&|;)\s*node\s+\.ltcook-evals\/verify\.cjs(?:\s|$)/.test(event.args.command)
      )
        fixtureVerifications.add(event.toolCallId);
      await observe({ kind: 'tool.start', tool: event.toolName, callId: event.toolCallId });
    });
    pi.on('tool_execution_end', async (event) => {
      await observe({
        kind: 'tool.end',
        tool: event.toolName,
        callId: event.toolCallId,
        durationMs: event.durationMs,
        fixtureVerification: fixtureVerifications.delete(event.toolCallId),
        isError: event.isError,
      });
    });
  }
  const member = team.definition.members.find((candidate) => candidate.key === memberKey);
  if (!member) throw new Error('Native agent identity is not a member of the selected team');
  const publishGuidance = async () => {
    if (!inspection) throw new Error('Managed native guidance inspection is unavailable.');
    const response = await rpc('/v1/command', {
      command: { type: 'guidance.loaded', inspection: inspection() },
    });
    if (!response.ok) throw new Error(`Native guidance registration failed (${response.status}).`);
  };
  pi.on('session_start', () => {
    // > Agent creation precedes Core binding. Retry only this idempotent inspection publication.
    let attempts = 0;
    const publish = async () => {
      try {
        await publishGuidance();
      } catch {
        attempts += 1;
        if (attempts < 5)
          setTimeout(() => {
            void publish();
          }, 1000);
        else
          console.error(
            'Native guidance loaded, but runtime inspection publication is unavailable.',
          );
      }
    };
    void publish();
  });
  pi.on('before_agent_start', async () => {
    await publishGuidance();
  });
  pi.on('tool_call', async (event, ctx) => {
    if (!nativeToolAllowed(member.readOnly, event.toolName))
      return { block: true, reason: 'This team member is restricted to read-only exploration.' };
    try {
      // > Native new/resume may change cwd; authorize exactly the path the tool will use.
      const input =
        ['write', 'edit'].includes(event.toolName) &&
        'path' in event.input &&
        typeof event.input.path === 'string' &&
        !path.isAbsolute(event.input.path)
          ? { ...event.input, path: path.resolve(ctx.cwd, event.input.path) }
          : event.input;
      const response = await rpc('/v1/tool/authorize', {
        toolName: event.toolName,
        input,
      });
      if (!response.ok)
        return { block: true, reason: `Runtime authorization unavailable (${response.status}).` };
      const authorization = (await response.json()) as { allowed?: boolean; reason?: string };
      if (authorization.allowed !== true)
        return { block: true, reason: authorization.reason ?? 'Runtime denied tool execution.' };
    } catch {
      return {
        block: true,
        reason: 'Runtime authorization unavailable; tool execution is blocked.',
      };
    }
    return undefined;
  });
  pi.registerTool({
    name: 'ltcook_team',
    label: 'Team coordination',
    description: 'Submit a coordination command.',
    parameters: AgentRuntimeCommandInputSchema,
    async execute(_id, input, _signal, _onUpdate, ctx) {
      // > Native Pi validates the narrower projection of the shared command schema.
      const command = input.command;
      const response = await rpc('/v1/command', { command });
      if (!response.ok) throw new Error(`Coordination request failed (${response.status})`);
      const result: unknown = await response.json();
      const value = (
        result as {
          value?: { id?: string; stage?: string; answer?: string; plan?: { path?: string } };
        }
      ).value;
      if (command.type === 'decision.create' && value?.id && value.answer === undefined) {
        await ctx.ui.input(
          decisionTitle(
            { sessionId, planId: command.planId, decisionId: value.id, kind: 'question' },
            command.prompt,
          ),
        );
      } else if (command.type === 'planning.submit' && value?.stage === 'awaiting-approval') {
        if (!value.plan?.path)
          throw new Error('Registered Plan path is unavailable; approval remains pending.');
        await ctx.ui.confirm(
          decisionTitle(
            { sessionId, planId: command.planId, decisionId: '', kind: 'approval' },
            `Approve Plan ${command.planId}?`,
          ),
          readPlanForApproval(value.plan.path),
        );
      }
      const serialized = JSON.stringify(result);
      if (serialized === undefined) throw new Error('Coordination response could not be encoded.');
      return { content: [{ type: 'text', text: serialized }], details: result };
    },
  });
  registerRiedTool(pi, async (input) => {
    const response = await rpc('/v1/ried', input);
    if (!response.ok) throw new Error(`RIED request failed (${response.status})`);
    return response.json();
  });
  await activateOptionalBrowser(pi);
}

/** Register the same read-only inventory contract for managed and standalone Pi. */
function registerRiedTool(
  pi: ExtensionAPI,
  read: (request: RiedRequest) => Promise<unknown>,
): void {
  pi.registerTool({
    name: 'ltcook_ried',
    label: 'Repository and environment inventory',
    description: 'Read a bounded inventory of this chat workspace or refresh it.',
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal('summary'),
        Type.Literal('section'),
        Type.Literal('refresh'),
      ]),
      section: Type.Optional(
        Type.Union([
          Type.Literal('repository'),
          Type.Literal('git'),
          Type.Literal('host'),
          Type.Literal('recipes'),
        ]),
      ),
    }),
    async execute(_id, input) {
      const result = await read(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}

/** Bind standalone inventory to the native runtime workspace, without Team authority. */
export function activateStandaloneRied(
  pi: ExtensionAPI,
  workspaceRoot: string,
  sessionId: string,
): void {
  const cache = process.env.LTCOOK_RIED_CACHE_DIR;
  const brief = process.env.LTCOOK_BRIEF_EXECUTABLE;
  if (!cache || !path.isAbsolute(cache) || !brief || !path.isAbsolute(brief)) return;
  const service = new RiedService(cache, brief, () => ({ PATH: process.env.PATH ?? '' }));
  registerRiedTool(pi, async (request) => ({
    value: await service.get({ id: sessionId, workspaceRoot }, request),
  }));
}

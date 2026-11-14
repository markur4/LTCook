import type { GuidanceInspection } from '../guidance-api/index.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { setTimeout } from 'node:timers';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AgentRuntimeCommandInputSchema, type RuntimeCommand } from '../workflow-api/commands.js';
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
      signal: globalThis.AbortSignal.timeout(3000) as NonNullable<
        Parameters<typeof fetch>[1]
      >['signal'],
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, nativeAgentId, ...payload }),
    });
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
  pi.on('tool_call', async (event) => {
    if (!nativeToolAllowed(member.readOnly, event.toolName))
      return { block: true, reason: 'This team member is restricted to read-only exploration.' };
    try {
      const response = await rpc('/v1/tool/authorize', {
        toolName: event.toolName,
        input: event.input,
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
      // > Native Pi validates the narrower agent schema before this shared command boundary.
      const command = input.command as RuntimeCommand;
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
  await activateOptionalBrowser(pi);
}

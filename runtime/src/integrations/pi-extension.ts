import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { InstructionResource, RuntimeCommand, SessionSnapshot, TeamAgentRuntime, TeamPackage } from '../api/team.js';
import { nativeToolAllowed } from './native-policy.js';
const require = createRequire(import.meta.url);
const RuntimeCommandInput = Type.Union([
  Type.Object({
    type: Type.Literal('task.create'),
    passId: Type.Optional(Type.String()), passTitle: Type.Optional(Type.String()),
    title: Type.String(), description: Type.String(), acceptance: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('task.update'), taskId: Type.String(),
    status: Type.Union([
      Type.Literal('pending'), Type.Literal('running'), Type.Literal('blocked'),
      Type.Literal('completed'), Type.Literal('failed'), Type.Literal('cancelled'),
    ]),
    blocker: Type.Optional(Type.String()),
  }),
  Type.Object({ type: Type.Literal('assignment.create'), taskId: Type.String(), memberKey: Type.String(), message: Type.String() }),
  Type.Object({ type: Type.Literal('report.create'), assignmentId: Type.String(), summary: Type.String(), evidence: Type.String() }),
  Type.Object({
    type: Type.Literal('review.create'), reportId: Type.String(),
    outcome: Type.Union([Type.Literal('accepted'), Type.Literal('changes-requested')]),
    summary: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('approval.create'),
    scope: Type.Object({ action: Type.String(), resourceId: Type.String(), revision: Type.String() }),
    decision: Type.Union([Type.Literal('approved'), Type.Literal('rejected')]),
  }),
  Type.Object({ type: Type.Literal('team.spawn'), memberKey: Type.String() }),
  Type.Object({ type: Type.Literal('team.message'), memberKey: Type.String(), message: Type.String() }),
  Type.Object({ type: Type.Literal('team.close'), memberKey: Type.String() }),
]);
const CommandInput = Type.Object({ command: RuntimeCommandInput });

async function selectedTeam(selection: string): Promise<TeamPackage> {
  const moduleName = selection === 'default' ? '@ltcook/team-default'
    : selection === 'default-minimal' ? '@ltcook/team-default-minimal' : selection;
  const loaded = await import(moduleName) as { default?: TeamPackage };
  const team = loaded.default;
  if (!team || team.apiVersion !== 1) throw new Error(`Selected team module does not export apiVersion 1: ${selection}`);
  return team;
}
async function activateOptionalBrowser(pi: ExtensionAPI): Promise<void> {
  if (process.env.LTCOOK_BROWSER_ENABLED !== 'true') return;
  try {
    const extensionPath = require.resolve('pi-agent-browser-native/dist/extensions/agent-browser/index.js');
    const extension = await import(pathToFileURL(extensionPath).href) as { default?: (api: ExtensionAPI) => void | Promise<void> };
    if (typeof extension.default !== 'function') throw new Error('Native browser extension entrypoint unavailable');
    await extension.default(pi);
  } catch {
    console.warn('Optional native browser extension failed to load; core chat and search remain available.');
  }
}

function resourcePath(resource: InstructionResource): string {
  return resource.url.startsWith('file:') ? fileURLToPath(resource.url) : resource.path;
}

export default async function activate(pi: ExtensionAPI): Promise<void> {
  const nativeAgentId = process.env.LTCOOK_NATIVE_AGENT_ID;
  const sessionId = process.env.LTCOOK_SESSION_ID;
  const teamId = process.env.LTCOOK_TEAM_ID;
  const memberKey = process.env.LTCOOK_MEMBER_KEY;
  const endpoint = process.env.LTCOOK_RUNTIME_API_URL;
  const token = process.env.LTCOOK_AGENT_API_TOKEN;
  const teamSelection = process.env.LTCOOK_TEAM;
  if (!nativeAgentId || !sessionId || !teamId || !memberKey || !endpoint || !token || !teamSelection) return;

  const team = await selectedTeam(teamSelection);
  if (team.definition.id !== teamId) throw new Error('Selected native team does not match the active session');
  const resources = new Map<string, InstructionResource>();
  const rpc = async (pathname: string, payload: Record<string, unknown>): Promise<Response> => fetch(`${endpoint}${pathname}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, nativeAgentId, ...payload }),
  });
  const coordination: TeamAgentRuntime['coordination'] = {
    async snapshot() {
      const response = await rpc('/v1/snapshot', {});
      if (!response.ok) throw new Error(`Coordination snapshot failed (${response.status})`);
      return await response.json() as SessionSnapshot;
    },
    async execute(command: RuntimeCommand) {
      const response = await rpc('/v1/command', { command });
      if (!response.ok) throw new Error(`Coordination request failed (${response.status})`);
      return await response.json();
    },
  };
  const member = team.definition.members.find(candidate => candidate.key === memberKey);
  if (!member) throw new Error('Native agent identity is not a member of the selected team');
  await team.activateAgent({
    definition: team.definition,
    identity: { sessionId, teamId, memberKey, nativeAgentId },
    coordination,
    instructions: { register(values) { for (const resource of values) resources.set(resource.path, resource); } },
  });

  pi.on('resources_discover', () => ({ promptPaths: [...resources.values()].map(resourcePath) }));
  pi.on('before_agent_start', async event => {
    const paths = member.instructionPaths.map(instructionPath => resources.get(instructionPath)).filter((resource): resource is InstructionResource => resource !== undefined).map(resourcePath);
    const content = await Promise.all(paths.map(async resource => `\n\n${await readFile(resource, 'utf8')}`));
    return content.length ? { systemPrompt: `${event.systemPrompt}${content.join('')}` } : undefined;
  });

  pi.on('tool_call', event => {
    if (!nativeToolAllowed(member.readOnly, event.toolName)) return { block: true, reason: 'This team member is restricted to read-only exploration.' };
    return undefined;
  });
  pi.registerTool({
    name: 'ltcook_team', label: 'Team coordination', description: 'Submit a coordination command. Read-only members may report assigned findings, update assigned task progress, or message the coordinator.',
    parameters: CommandInput,
    async execute(_id, input) {
      const response = await rpc('/v1/command', { command: input.command });
      if (!response.ok) throw new Error(`Coordination request failed (${response.status})`);
      const result: unknown = await response.json();
      const serialized = JSON.stringify(result);
      if (serialized === undefined) throw new Error('Coordination response could not be encoded.');
      return { content: [{ type: 'text', text: serialized }], details: result };
    },
  });
  await activateOptionalBrowser(pi);
}

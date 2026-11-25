import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { buildAgentDeepLinkRoute } from '@getpaseo/protocol/agent-deep-link';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Telemetry } from '../../../runtime/src/diagnostics/telemetry.js';
import { EvalRunService } from '../../../runtime/src/evals/service.js';
import path from 'node:path';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import { createPaseoMemorySource } from '../../../runtime/src/integrations/paseo-memory.js';
import { SessionMemory } from '../../../runtime/src/session-memory/service.js';
import { WorkspaceMcp } from '../../../runtime/src/integrations/mcp.js';
import { agentBearer, RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import {
  createPaseoAgentBackend,
  startPaseoHost,
} from '../../../runtime/src/integrations/paseo.js';
import { catalogModelAliases } from '../../../runtime/src/models/aliases.js';
import { TeamRegistry } from '../../../runtime/src/integrations/team-loader.js';

const root = path.resolve(import.meta.dir, '../../..');
const directory = process.argv[2];
if (!directory || process.platform !== 'linux')
  throw new Error('Isolated Linux fixture directory required');
const workspace = path.join(directory, 'workspace');
const deployment = path.join(directory, 'deployment');
const piHome = path.join(directory, 'pi');
const authHome = path.join(directory, 'auth');
const fixtureSkill = path.join(directory, 'guidance', 'skills', 'activity-fixture', 'SKILL.md');
await mkdir(path.dirname(fixtureSkill), { recursive: true });
await writeFile(
  fixtureSkill,
  '---\nname: activity-fixture\ndescription: Browser activity fixture\n---\nRead the fixture.\n',
);
for (const entry of [workspace, deployment, piHome, authHome])
  await mkdir(entry, { recursive: true });
async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}
const listen = `127.0.0.1:${await freePort()}`;
const endpoint = `http://${listen}`;
const secret = 'offline-leader-system-token';
const node = process.env.LTCOOK_TEST_NODE ?? 'node';
const teams = await TeamRegistry.load(root);
const team = teams.resolve('default-minimal');
const browserSession = `ltcook-gui-${randomUUID()}`;
const run = promisify(execFile);
let stage = 'setup';
async function browser(...args: string[]): Promise<string> {
  const result = await run(
    node,
    [
      path.join(root, 'node_modules/agent-browser/bin/agent-browser.js'),
      '--session',
      browserSession,
      ...args,
    ],
    { timeout: 30_000, env: process.env, maxBuffer: 2_000_000 },
  );
  return result.stdout;
}
let modelCalls = 0;
let providerError: unknown;
const provider = createHttpServer(async (request, response) => {
  try {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as {
      model: string;
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const lastUser = input.messages?.findLastIndex(({ role }) => role === 'user') ?? -1;
    const prompt = JSON.stringify(input.messages?.[lastUser]?.content ?? '');
    const exerciseParallel = prompt.includes('Exercise Activity parallel tools');
    const exerciseActivity = exerciseParallel || prompt.includes('Exercise Activity tools');
    const needsTools =
      exerciseActivity && !input.messages?.slice(lastUser + 1).some(({ role }) => role === 'tool');
    const reply = JSON.stringify(input.messages ?? []).includes('GUI mobile draft launch')
      ? 'GUI mobile native Leader response.'
      : 'GUI native Leader response.';
    modelCalls++;
    const id = `gui-fixture-${modelCalls}`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const toolRequests = exerciseParallel
      ? Array.from({ length: 2 }, () => ({ name: 'bash', args: { command: 'sleep 7' } }))
      : Array.from({ length: 8 }, () => ({ name: 'read', args: { path: fixtureSkill } }));
    const tools = needsTools
      ? toolRequests.map(({ name, args }, index) => ({
          index,
          id: `${id}-${index}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }))
      : undefined;
    for (const [delta, finish_reason] of [
      [{ role: 'assistant' }, null],
      [
        tools
          ? { tool_calls: tools }
          : {
              content: exerciseParallel
                ? 'Activity parallel fixture done.'
                : exerciseActivity
                  ? 'Activity fixture done.'
                  : reply,
            },
        null,
      ],
      [{}, tools ? 'tool_calls' : 'stop'],
    ]) {
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    }
    response.end('data: [DONE]\n\n');
  } catch (error) {
    providerError = error;
    response.writeHead(500).end('Scripted GUI fixture failed');
  }
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const providerAddress = provider.address();
assert(providerAddress && typeof providerAddress !== 'string');
async function inspectStage(name: string): Promise<void> {
  stage = name;
  console.log(JSON.stringify({ stage, snapshot: await browser('snapshot') }));
}
async function clickButton(name: string): Promise<void> {
  await browser('find', 'role', 'button', 'click', '--name', name, '--exact');
}
const explorer = '[data-testid="workspace-explorer-sidebar"]';
async function openExplorerPanel(name: string): Promise<void> {
  const addTab = `${explorer} [aria-label="New tab"]`;
  const target = `explorer-add-${randomUUID()}`;
  await browser(
    'wait',
    '--fn',
    `[...document.querySelectorAll(${JSON.stringify(addTab)})].some(button => {
      if (!button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const rect = button.getBoundingClientRect();
      if (!button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))) return false;
      button.setAttribute('data-ltcook-explorer-add', ${JSON.stringify(target)});
      return true;
    })`,
  );
  await browser('click', `[data-ltcook-explorer-add="${target}"]`);
  await browser('find', 'role', 'menuitem', 'click', '--name', name, '--exact');
}
async function openActivityPanel(): Promise<void> {
  await browser('press', 'Control+k');
  await browser(
    'find',
    'placeholder',
    'Search commands, files, workspaces, and agents...',
    'fill',
    'Open Activity panel',
  );
  await clickButton('Open Activity panel');
}
async function tapNativeChoice(name: string): Promise<void> {
  const target = `native-touch-${randomUUID()}`;
  await browser(
    'wait',
    '--fn',
    `(() => {
    const name = ${JSON.stringify(name)};
    const roles = 'button,[role=button],[role=option],[role=menuitem]';
    const direct = [...document.querySelectorAll(roles)].filter(node => node.getAttribute('aria-label') === name || node.textContent?.trim() === name);
    const labels = [...document.querySelectorAll('div,span,p')].filter(node => node.textContent?.trim() === name).map(node => node.closest(roles)).filter(Boolean);
    const node = [...direct, ...labels].find(node => {
      if (node.closest('[aria-hidden=true],[inert]') || !node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.bottom > innerHeight) return false;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === node || node.contains(hit);
    });
    if (!node || node.getAttribute('aria-disabled') === 'true') return false;
    const rect = node.getBoundingClientRect();
    const bounds = [rect.x, rect.y, rect.width, rect.height].map(value => Math.round(value * 10)).join(',');
    const previous = window.__ltcookTouchTarget;
    if (!previous || previous.id !== ${JSON.stringify(target)} || previous.bounds !== bounds) {
      window.__ltcookTouchTarget = { id: ${JSON.stringify(target)}, bounds, since: performance.now() };
      return false;
    }
    if (performance.now() - previous.since < 300) return false;
    node.setAttribute('data-ltcook-acceptance-touch', ${JSON.stringify(target)});
    return true;
  })()`,
  );
  await browser(
    'eval',
    `(() => {
      window.__ltcookTouchEvents ??= [];
      for (const type of ['touchstart', 'touchend', 'touchcancel', 'click']) {
        document.querySelector('[data-ltcook-acceptance-touch="${target}"]').addEventListener(type, event => {
          window.__ltcookTouchEvents.push({ type, name: ${JSON.stringify(name)}, trusted: event.isTrusted });
        }, { once: true });
      }
    })()`,
  );
  await browser('tap', `[data-ltcook-acceptance-touch="${target}"]`);
}
async function selectLtcook(inheritedMobileProfile = false): Promise<void> {
  await inspectStage('provider-picker');
  await browser('find', 'role', 'button', 'click', '--name', 'Select model');
  await inspectStage('native-model-provider-picker');
  if (!inheritedMobileProfile) {
    await browser(
      'wait',
      '--fn',
      `(() => {
      const button = [...document.querySelectorAll('[role=dialog] button,[role=dialog] [role=button]')].find(node => node.textContent?.trim().startsWith('LTCook'));
      return button && !button.textContent?.includes('Loading') && button.getAttribute('aria-disabled') !== 'true';
    })()`,
    );
    await browser('find', 'role', 'button', 'click', '--name', 'LTCook');
    await browser('wait', '--text', 'Offline startup fixture');
    await inspectStage('native-ltcook-model-picker');
    await browser('find', 'text', 'Offline startup fixture', 'click', '--exact');
  }
  await browser('wait', '--text', 'Team');
  await inspectStage('team-selector');
  if (inheritedMobileProfile) {
    await inspectStage('mobile-native-team-options');
    await tapNativeChoice('Default Minimal');
    await browser(
      'wait',
      '--fn',
      ` [...document.querySelectorAll('div,span,p')].some(node => node.textContent?.trim() === 'Selected Team: Default Minimal' && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().bottom > 0 && node.getBoundingClientRect().top < innerHeight)`,
    );
    await inspectStage('mobile-selected-team-controls');
    await tapNativeChoice('Close');
    await waitForComposer();
  } else {
    await clickButton('Team');
    await browser('wait', '--text', 'Default Minimal');
    await browser('find', 'text', 'Default Minimal', 'click', '--exact');
  }
}
async function waitForComposer(title?: string): Promise<void> {
  const script = `(() => {
    const title = ${JSON.stringify(title ?? '')};
    if (title && !document.body.innerText.includes(title)) return false;
    const composer = [...document.querySelectorAll('textarea,[contenteditable=true],[role=textbox]')].find(node => {
      if (node.closest('[aria-hidden=true],[inert]') || !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight) return false;
      const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2)), Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2)));
      return hit === node || node.contains(hit);
    });
    if (!composer) return false;
    document.querySelectorAll('[data-ltcook-acceptance-composer]').forEach(node => node.removeAttribute('data-ltcook-acceptance-composer'));
    composer.setAttribute('data-ltcook-acceptance-composer', 'visible');
    return true;
  })()`;
  await browser('wait', '--fn', script);
}
async function sendPrompt(prompt: string, action = 'Send message'): Promise<void> {
  await waitForComposer();
  await browser('fill', '[data-ltcook-acceptance-composer=visible]', prompt);
  await clickButton(action);
  await browser(
    'wait',
    '--text',
    prompt.includes('mobile')
      ? 'GUI mobile native Leader response.'
      : 'GUI native Leader response.',
  );
  if (providerError) throw providerError;
}
async function clickTeamAction(teamName: string, action: string): Promise<void> {
  const target = `team-action-${randomUUID()}`;
  const script = `(() => {
    const headings = '[role=heading],h1,h2,h3';
    const heading = [...document.querySelectorAll(headings)].find(node => node.textContent?.trim() === ${JSON.stringify(teamName)});
    if (!heading) throw new Error('Selected Team heading is not visible');
    for (let card = heading.parentElement; card; card = card.parentElement) {
      // A shared ancestor containing other Team cards must never select its first action.
      if (card.querySelectorAll(headings).length !== 1) continue;
      const buttons = [...card.querySelectorAll('button,[role=button]')].filter(node => node.getAttribute('aria-label') === ${JSON.stringify(action)} || node.textContent?.trim() === ${JSON.stringify(action)});
      if (buttons.length !== 1) continue;
      buttons[0].setAttribute('data-ltcook-acceptance-action', ${JSON.stringify(target)});
      return 'located';
    }
    throw new Error('Selected Team card has no unique matching action');
  })()`;
  await browser('eval', script);
  await browser('click', `[data-ltcook-acceptance-action="${target}"]`);
}
await writeFile(
  path.join(piHome, 'models.json'),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
        api: 'openai-completions',
        apiKey: 'fake-local-key',
        models: [
          {
            id: 'test',
            name: 'Offline startup fixture',
            contextWindow: 32768,
            maxTokens: 1024,
            input: ['text'],
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
);
const environment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  ),
  PI_CODING_AGENT_DIR: piHome,
  LTCOOK_PI_AUTH_DIR: authHome,
  PI_OFFLINE: '1',
  LTCOOK_MODEL_SMART: 'fixture/test',
  LTCOOK_MODEL_SMOL: 'fixture/test',
  LTCOOK_MODEL_EXPENSIVE: 'fixture/test',
  LTCOOK_MODEL_TINY_LOCAL: 'fixture-model',
  LTCOOK_GUIDANCE_DIR: path.join(directory, 'guidance'),
  LTCOOK_BROWSER_ENABLED: 'false',
  LTCOOK_CODESEARCH_ENABLED: 'false',
  LTCOOK_CONTEXT7_ENABLED: 'false',
};
const tracePath = path.join(directory, 'gui.perfetto.json');
const telemetry = new Telemetry(path.join(directory, 'gui.events.jsonl'), tracePath);
const api = new RuntimeApi(undefined, secret, listen, environment, telemetry);
api.setActivityPreferences(path.join(directory, 'activity-settings.json'));
const evals = new EvalRunService(path.join(directory, 'eval-state'), async (request) => {
  assert.equal(request.preset, 'full');
  assert.equal(request.setup, 'synthetic');
  assert.equal(request.scenario, 'summarization');
  return {
    metadata: { summarizationQualification: 'failed' },
    result: {
      results: {
        summarization: {
          scope: 'full',
          verdict: 'failed',
          complete: true,
          attempts: [{ id: 'migration-failure', input: 'inline', attempt: 1, verdict: 'failed' }],
        },
      },
    },
    trace: null,
  };
});
await evals.initialize();
api.setEval(evals);
api.setWorkspaceMcp(new WorkspaceMcp([api.worktreeTool], listen));
await api.listen();
let host: Awaited<ReturnType<typeof startPaseoHost>> | undefined;
let runtime: ReturnType<typeof createRuntime> | undefined;
let memory: SessionMemory | undefined;
let backgroundSummary = false;
let activityRequests = 0;
try {
  host = await startPaseoHost({
    node,
    home: path.join(deployment, 'paseo'),
    deploymentRoot: deployment,
    listen: '127.0.0.1:0',
    runtimeApiUrl: endpoint,
    userToken: secret,
    pluginDirectory: path.join(root, 'runtime/dist/paseo-plugin'),
    environment,
    piCommand: path.join(root, 'runtime/dist/integrations/pi-rpc.js'),
  });
  api.setProviderSubagents(async (agentId) => {
    activityRequests++;
    return host!.listProviderSubagents(agentId);
  });
  const backend = await createPaseoAgentBackend({
    api: host.api,
    python: 'unused-prepared-environment',
    runtimeApiUrl: endpoint,
    piHome,
    extensionPath: path.join(root, 'runtime/dist/integrations/pi-extension.js'),
    appNodeModules: path.join(root, 'node_modules'),
    deploymentNode: node,
    browserAvailable: false,
    preparedEnvironment: environment,
    identity(id) {
      return { agentId: id, token: agentBearer(secret, id) };
    },
    thinking: 'off',
    telemetry,
  });
  const createController = () =>
    createRuntime({
      databasePath: path.join(directory, 'coordination.sqlite'),
      stateDirectory: path.join(directory, 'state'),
      team,
      teams,
      agents: backend,
    });
  runtime = createController();
  api.setRuntime(runtime);
  api.setOpenWorkspaceHandler(async (request) =>
    runtime!.openSession({
      id: request.sessionId,
      workspaceRoot: request.workspaceRoot,
      teamSelection: request.teamSelection,
      ...(request.leaderAgentId ? { leaderAgentId: request.leaderAgentId } : {}),
    }),
  );
  const leaderFor = (selection: string) => {
    const { definition } = teams.resolve(selection);
    const leader = definition.members.find((member) => member.key === definition.leaderKey);
    assert(leader);
    return leader;
  };
  api.setModelSelectionHandlers({
    catalog: ({ teamSelection }) => catalogModelAliases(leaderFor(teamSelection), environment),
    resolve: ({ teamSelection, workspaceRoot, alias, reasoning }) =>
      backend.resolveSelection(workspaceRoot, leaderFor(teamSelection), alias, reasoning ?? 'none'),
  });
  api.setPrepareSessionHandler(async (request) => {
    const snapshot = runtime!.snapshot(request.sessionId);
    const member = snapshot.definition.members.find((member) => member.key === 'leader');
    assert(member);
    const prepared = await backend.prepare(
      {
        member,
        sessionId: request.sessionId,
        teamInstanceId: snapshot.session.teamInstanceId,
        teamId: snapshot.session.teamId,
        workspaceRoot: request.workspaceRoot,
      },
      request.leaderAgentId,
      request.savedModel,
    );
    return {
      env: prepared.env,
      ...(prepared.mcpServers ? { mcpServers: prepared.mcpServers } : {}),
    };
  });
  await host.api.workspaces.open(workspace);
  await browser('set', 'viewport', '1440', '1000');
  await browser('open', `http://${host.listen}`);
  await browser('wait', '--text', 'New workspace');
  await inspectStage('native-desktop-entry');
  await clickButton('New workspace');
  await waitForComposer();
  await inspectStage('new-workspace-desktop');
  await selectLtcook();
  await sendPrompt('GUI desktop launch', 'Create');
  const initial = runtime.listSessions(workspace, 'default-minimal');
  assert.equal(initial.length, 1, 'Native submission creates exactly one LTCook Session');
  const leaderId = initial[0]!.id;
  const snapshot = runtime.snapshot(leaderId);
  assert.equal(snapshot.session.teamId, team.definition.id);
  assert.equal(
    snapshot.members.find(({ member }) => member.key === 'leader')?.binding?.nativeAgentId,
    leaderId,
  );
  const leader = await host.api.agents.ref(leaderId).refresh();
  assert(
    leader && !['Main', 'Leader'].includes(leader.agent.title ?? ''),
    'Session title describes work or context',
  );
  const nativeChat = await browser('snapshot');
  assert(
    nativeChat.includes(leader!.agent.title!),
    'Native Leader title is rendered in the selected chat',
  );
  assert(
    nativeChat.includes('textbox "Message agent..."'),
    'Leader opens in the native message composer',
  );
  assert(
    nativeChat.includes('GUI native Leader response.'),
    'Native Leader response is visible immediately',
  );
  assert(!nativeChat.includes('Team Overview'), 'No intermediary Team Overview replaces the chat');
  await inspectStage('native-leader-chat');

  stage = 'native-explorer-defaults';
  await browser('wait', '--text', 'Recent conversation activity');
  assert.equal(
    (
      await browser('get', 'count', `${explorer} :is([aria-label="Team"], [aria-label="Tasks"])`)
    ).trim(),
    '0',
    'Only Activity opens automatically',
  );
  const activityTab = `${explorer} [aria-label="Activity"][data-testid^="workspace-tab-"]`;
  await browser('hover', activityTab);
  await browser('click', `${explorer} [data-testid^="workspace-plugin-close-"]`);
  assert.equal((await browser('get', 'count', activityTab)).trim(), '0', 'Activity tab closes');

  await clickButton('Teams');
  await browser('wait', '--text', 'Default Minimal');
  await inspectStage('teams-browser');
  await clickTeamAction('Default Minimal', 'Open Leader chat');
  await browser('wait', '--text', 'GUI native Leader response.');
  await browser('reload');
  await waitForComposer(leader.agent.title ?? undefined);
  assert.equal(
    (await browser('get', 'count', activityTab)).trim(),
    '0',
    'Returning to the same workspace and reloading respects the closed Activity tab',
  );
  await openExplorerPanel('Activity');
  await browser('wait', '--text', 'Recent conversation activity');
  assert.equal(
    runtime.listSessions(workspace, 'default-minimal').length,
    1,
    'Open Leader reuses the existing Session',
  );
  await clickButton('Teams');
  await clickTeamAction('Default Minimal', 'New Session');
  const newSessionDeadline = Date.now() + 30_000;
  while (runtime.listSessions(workspace, 'default-minimal').length !== 2) {
    if (Date.now() > newSessionDeadline)
      throw new Error('New Session did not create a separate Leader');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const separate = runtime
    .listSessions(workspace, 'default-minimal')
    .find((session) => session.id !== leaderId);
  assert(separate, 'New Session has an independent Leader identity');
  assert.equal(
    runtime.snapshot(separate.id).members.find(({ member }) => member.key === 'leader')?.binding
      ?.nativeAgentId,
    separate.id,
  );
  let separateLeader = await host.api.agents.ref(separate.id).refresh();
  while (!separateLeader?.agent.title || separateLeader.agent.status === 'initializing') {
    if (Date.now() > newSessionDeadline)
      throw new Error('Reserved New Session did not finish native Leader creation');
    await new Promise((resolve) => setTimeout(resolve, 50));
    separateLeader = await host.api.agents.ref(separate.id).refresh();
  }
  assert.equal(separateLeader.agent.status, 'idle', 'New Leader reached native readiness');
  await waitForComposer(separateLeader.agent.title);
  const separateChat = await browser('snapshot');
  assert(
    separateChat.includes(separateLeader.agent.title),
    'New Leader title is visible after navigation',
  );
  assert(
    separateChat.includes('textbox "Message agent..."'),
    'New Session opens its native chat before resizing',
  );
  await inspectStage('separate-native-leader-chat');

  await browser('set', 'device', 'iPhone 14');
  await browser('wait', '--fn', 'window.innerWidth === 390');
  assert.equal(
    (await browser('eval', 'document.documentElement.scrollWidth <= window.innerWidth')).trim(),
    'true',
    'Native mobile shell fits its viewport',
  );
  await inspectStage('native-mobile-entry');
  await browser('find', 'role', 'button', 'click', '--name', 'Switch tabs');
  await inspectStage('native-mobile-tab-switcher');
  await clickButton('New agent');
  await waitForComposer();
  await selectLtcook(true);
  await sendPrompt('GUI mobile draft launch');
  assert.equal(
    runtime.listSessions(workspace, 'default-minimal').length,
    3,
    'Mobile native draft creates a distinct Team Session',
  );
  const mobileSession = runtime
    .listSessions(workspace, 'default-minimal')
    .find((session) => session.id !== leaderId && session.id !== separate.id);
  assert(mobileSession, 'Mobile submission has its own Session identity');
  assert.equal(
    runtime.snapshot(mobileSession.id).session.teamId,
    team.definition.id,
    'Mobile Team choice is durably bound to Default Minimal',
  );
  assert.equal(
    runtime.snapshot(mobileSession.id).members.find(({ member }) => member.key === 'leader')
      ?.binding?.nativeAgentId,
    mobileSession.id,
  );
  await inspectStage('native-mobile-leader-chat');
  assert(modelCalls >= 2, 'Submitted native prompts reached the local scripted provider');

  await browser('set', 'viewport', '1440', '1000');
  await waitForComposer();
  const mobileLeader = await host.api.agents.ref(mobileSession.id).refresh();
  assert(mobileLeader?.agent.title);
  const adjutantId = runtime
    .snapshot(mobileSession.id)
    .members.find(({ member }) => member.key === 'adjutant')?.binding?.nativeAgentId;
  assert(adjutantId, 'Persistent Adjutant is bound to the active Leader');
  const adjutant = await host.api.agents.ref(adjutantId).refresh();
  assert(adjutant);
  assert.equal(adjutant.agent.labels['paseo.parent-agent-id'], mobileSession.id);
  await clickButton('1 subagent');
  await inspectStage('native-subagent-track');
  await browser('find', 'role', 'menuitem', 'click', '--name', 'Adjutant', '--exact');
  await waitForComposer('Adjutant');
  await inspectStage('native-child-conversation');
  await clickButton(`Back to ${mobileLeader.agent.title}`);
  await waitForComposer(mobileLeader.agent.title);

  const gitWorkspace = path.join(directory, 'activity-parent');
  const workerWorkspace = path.join(directory, 'activity-worktree');
  await mkdir(gitWorkspace);
  await run('git', ['init', gitWorkspace]);
  await run(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '--no-gpg-sign',
      '-m',
      'Fixture',
    ],
    { cwd: gitWorkspace },
  );
  await run('git', ['worktree', 'add', '--detach', workerWorkspace], { cwd: gitWorkspace });
  const differentWorkspace = await host.api.workspaces.open(workerWorkspace);
  const crossAgent = await differentWorkspace.agents.create({
    parent: mobileSession.id,
    title: 'Activity cross-worktree worker',
    config: { provider: 'pi/fixture/test' },
    env: environment,
  });

  assert.equal((await crossAgent.refresh())?.agent.workspaceId, differentWorkspace.id);
  await openActivityPanel();
  await browser('wait', '--text', 'Recent conversation activity');
  assert(
    (await browser('snapshot')).includes('Close Explorer sidebar'),
    'Activity opens in Explorer',
  );
  await inspectStage('native-activity-explorer');

  await host.api.agents.ref(mobileSession.id).send('Exercise Activity tools');
  await browser('wait', '--text', 'Activity fixture done.');
  await browser(
    'wait',
    '--fn',
    `Boolean(document.querySelector('[aria-label="activity-fixture, observed skill load"]'))`,
  );
  await clickButton('activity-fixture, observed skill load');
  await browser(
    'wait',
    '--fn',
    `Boolean(document.querySelector('[aria-label="Close activity-fixture preview"]'))`,
  );
  const skillDocument = '[data-testid="ltcook-skill-document"]';
  const skillPreview = '[data-testid="ltcook-passage-skill-preview"]';
  stage = 'native-activity-skill-document';
  assert.match(
    await browser('get', 'text', '[aria-label="Open skill in new tab"]'),
    /Open skill in new tab/,
  );
  await clickButton('Open skill in new tab');
  await browser('wait', skillDocument);
  await browser(
    'wait',
    '--fn',
    `document.querySelector(${JSON.stringify(skillDocument)})?.textContent.includes('Read the fixture.')`,
  );
  await clickButton(mobileLeader.agent.title);
  await waitForComposer(mobileLeader.agent.title);
  stage = 'native-chat-skill-preview';
  await clickButton('Preview skill activity-fixture');
  await browser('wait', skillPreview);
  await browser(
    'wait',
    '--fn',
    `document.querySelector(${JSON.stringify(skillPreview)})?.textContent.includes('Read the fixture.')`,
  );
  await clickButton('Open in new tab');
  await browser('wait', skillDocument);
  await clickButton(mobileLeader.agent.title);
  await waitForComposer(mobileLeader.agent.title);

  await browser(
    'wait',
    '--fn',
    `document.querySelectorAll('[aria-label="read, 8 calls"]').length === 1`,
  );
  await clickButton('read, 8 calls');
  await browser(
    'wait',
    '--fn',
    `document.querySelectorAll('[aria-label^="read call, Success,"]').length === 8`,
  );
  stage = 'native-activity-tool-skill-document';
  await clickButton('Open skill in new tab');
  await browser('wait', skillDocument);
  await browser(
    'wait',
    '--fn',
    `document.querySelector(${JSON.stringify(skillDocument)})?.textContent.includes('Read the fixture.')`,
  );
  await clickButton(mobileLeader.agent.title);
  await waitForComposer(mobileLeader.agent.title);
  if (!(await browser('snapshot')).includes('Close read preview'))
    await clickButton('read, 8 calls');

  stage = 'native-activity-show-in-chat';
  await browser('wait', '[aria-label^="Show in Chat, read 1 of 8 at"]');
  const turn = await host.api.agents.ref(mobileSession.id).timeline.refetch({
    direction: 'tail',
    projection: 'canonical',
    limit: 40,
  });
  const calls = turn.entries
    .filter((entry) => entry.item.type === 'tool_call' && entry.item.name === 'read')
    .map(({ item, turnId, timestamp, seqEnd }) => {
      assert(item.type === 'tool_call');
      assert(turnId);
      return { id: item.callId, turnId, time: Date.parse(timestamp), seqEnd };
    })
    .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  assert.equal(calls.length, 8);
  for (const index of [0, 7]) {
    const call = calls[index]!;
    const nativeId = `agent_tool_turn:${encodeURIComponent(call.turnId)}/${encodeURIComponent(call.id)}`;
    await browser('click', `[aria-label^="Show in Chat, read ${index + 1} of 8 at"]`);
    await browser(
      'wait',
      '--fn',
      `(() => {
        const row = [...document.querySelectorAll('[data-message-id]')]
          .find(node => node.getAttribute('data-message-id') === ${JSON.stringify(nativeId)});
        if (!row) return false;
        const bounds = row.getBoundingClientRect();
        return bounds.height > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight;
      })()`,
    );
  }
  await clickButton('Close read preview');
  await browser(
    'wait',
    '--fn',
    `Boolean(document.querySelector('[aria-label="activity-fixture, observed skill load"]'))`,
  );
  await clickButton('activity-fixture, observed skill load');
  await openActivityPanel();
  await browser(
    'wait',
    '--fn',
    `Boolean(document.querySelector('[aria-label="Close activity-fixture preview"]'))`,
  );
  await browser('set', 'viewport', '1100', '950');
  await browser(
    'wait',
    '--fn',
    `[...document.querySelectorAll('[aria-label^="Agent context,"]')].some(node => /[0-9].*tokens/.test(node.getAttribute('aria-label') ?? ''))`,
  );
  const panelWidth = JSON.parse(
    await browser(
      'eval',
      `(() => {
    const row = document.querySelector('[aria-label^="RAG Index,"]');
    const bounds = row?.getBoundingClientRect();
    return { width: bounds?.width ?? 0, fits: Boolean(row && row.scrollWidth <= row.clientWidth + 1) };
  })()`,
    ),
  ) as { width: number; fits: boolean };
  assert(
    panelWidth.width >= 260 && panelWidth.width <= 430 && panelWidth.fits,
    'Activity cards fit the narrow Explorer',
  );
  await browser('screenshot', path.join(directory, 'activity-explorer.png'));
  const colors = `(() => {
    let element = document.querySelector('[aria-label^="RAG Index,"]');
    const backgrounds = [];
    for (let depth = 0; element && depth < 6; depth++, element = element.parentElement) {
      backgrounds.push(getComputedStyle(element).backgroundColor);
    }
    return backgrounds;
  })()`;
  const lightColors = JSON.parse(await browser('eval', colors)) as string[];
  await browser('set', 'media', 'dark');
  await browser(
    'wait',
    '--fn',
    `JSON.stringify(${colors}) !== JSON.stringify(${JSON.stringify(lightColors)})`,
  );
  await browser('screenshot', path.join(directory, 'activity-explorer-dark.png'));
  await browser('set', 'media', 'light');
  await inspectStage('native-activity-tools-and-skills');
  await browser('set', 'viewport', '1440', '1000');

  await clickButton('Open Adjutant conversation');
  await waitForComposer('Adjutant');
  await browser(
    'wait',
    '--fn',
    `Boolean(document.querySelector('[aria-label="Adjutant"][aria-selected="true"]'))`,
  );
  await clickButton(`Back to ${mobileLeader.agent.title}`);
  await waitForComposer(mobileLeader.agent.title);
  await browser('wait', '--text', 'RAG Index');
  await clickButton('Open Activity cross-worktree worker conversation');
  await waitForComposer('Activity cross-worktree worker');
  await browser('wait', '--text', workerWorkspace);
  await inspectStage('native-activity-cross-worktree');
  await crossAgent.send('Exercise Activity parallel tools');
  await browser(
    'wait',
    '--fn',
    `document.querySelectorAll('[aria-label="bash, 2 calls, 2 running"]').length === 1`,
  );
  await inspectStage('native-activity-parallel-tools');
  await browser('wait', '--text', 'Activity parallel fixture done.');
  await clickButton(`Back to ${mobileLeader.agent.title}`);
  await waitForComposer(mobileLeader.agent.title);
  await browser('wait', '--text', 'RAG Index');

  const selectedGpu = { id: 'CUDA:fixture-4070', label: 'RTX 4070 Ti SUPER', mainGpu: 1 };
  const summaryContent = { findings: [{ detail: 'Background summary fixture', confirmed: true }] };
  const latestSummary = {
    findings: [{ detail: 'Live throughput passage summary', confirmed: true }],
  };
  const ambiguousReason = 'Ollama cannot select this device uniquely.';
  let deviceProbes = 0;
  const livePlacements: Array<{ cpuOnly?: boolean; mainGpu?: number }> = [];
  memory = new SessionMemory({
    databasePath: path.join(directory, 'activity-memory.sqlite'),
    source: createPaseoMemorySource(host.api, secret),
    async deviceCatalog() {
      deviceProbes++;
      return {
        devices: [
          { id: 'CUDA:fixture-5090', label: 'RTX 5090', mainGpu: 0 },
          selectedGpu,
          { id: 'ROCm:fixture-igpu', label: 'AMD integrated GPU', unavailable: ambiguousReason },
        ],
      };
    },
    async summarize(type, prompt, _signal, placement, onProgress) {
      const input = JSON.stringify(prompt);
      if (input.includes('Summarize without Activity')) backgroundSummary = true;
      const isLatest = input.includes('Measure live summary throughput');
      if (isLatest) {
        livePlacements.push(placement);
        onProgress?.({ tokensPerSecond: 12.5, estimated: true });
        await Bun.sleep(2100);
        onProgress?.({ tokensPerSecond: 19, estimated: true });
        await Bun.sleep(2100);
      }
      const content = isLatest ? latestSummary : summaryContent;
      return {
        type,
        text: JSON.stringify(content),
        content,
        complete: true,
        elapsedMs: 1,
      };
    },
  });
  api.setSessionMemory(memory, () => ({ sessionId: mobileSession.id }));
  await clickButton('Close Explorer sidebar');
  await new Promise((resolve) => setTimeout(resolve, 1750));
  const requestsWhileHidden = activityRequests;
  await host.api.agents
    .ref(mobileSession.id)
    .send('Summarize without Activity', { clientMessageId: randomUUID() });
  for (let attempt = 0; attempt < 100 && !backgroundSummary; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(backgroundSummary, 'Session Memory summarizes while Activity is hidden');
  assert.equal(activityRequests, requestsWhileHidden, 'Hidden Activity releases observation');
  await clickButton('Open Explorer sidebar');
  await browser('wait', '--text', 'Recent conversation activity');
  assert(activityRequests > requestsWhileHidden, 'Reopening Activity resumes observation');
  stage = 'native-activity-switches';
  await browser('click', '[aria-label^="RAG Index,"]');
  const indexingSwitch = '[role="switch"][aria-label="Index updates"]';
  await browser('click', indexingSwitch);
  await browser('wait', '[aria-label^="RAG Index,"][aria-label*="Index updates off"]');
  assert.equal(api.activityColgrep.isIndexingEnabled(), false);
  await browser('click', indexingSwitch);
  await browser(
    'wait',
    '--fn',
    `document.querySelector(${JSON.stringify(indexingSwitch)})?.checked === true`,
  );
  assert.equal(api.activityColgrep.isIndexingEnabled(), true);
  await browser('click', '[aria-label^="RAG Index,"]');
  stage = 'native-activity-memory-summaries';
  await browser('wait', '[aria-label^="Session Memory,"][aria-label*="stored"]');
  await browser('click', '[aria-label^="Session Memory,"]');
  const summarizerSwitch = '[role="switch"][aria-label="Summarizer"]';
  await browser('click', summarizerSwitch);
  await browser('wait', '[aria-label^="Session Memory,"][aria-label$="Paused"]');
  assert.equal(memory.status(undefined, mobileSession.id).summarization, 'paused');
  await browser('click', summarizerSwitch);
  await browser(
    'wait',
    '--fn',
    `document.querySelector(${JSON.stringify(summarizerSwitch)})?.checked === true`,
  );
  assert.notEqual(memory.status(undefined, mobileSession.id).summarization, 'paused');
  stage = 'native-activity-memory-device';
  await browser('wait', '[aria-label="Inference device: Auto"]');
  assert.equal(deviceProbes, 0, 'Opening the Activity card does not probe GPUs');
  const deviceRow = JSON.parse(
    await browser(
      'eval',
      `(() => {
        const row = document.querySelector('[data-testid="ltcook-memory-device-row"]');
        const trigger = row.querySelector('[aria-label="Inference device: Auto"]');
        const label = [...row.querySelectorAll('div, span')].find(node => node.textContent === 'Inference device');
        const rowHeight = row.getBoundingClientRect().height;
        row.style.width = '174px';
        const key = label.getBoundingClientRect();
        const value = trigger.getBoundingClientRect();
        const narrow = row.getBoundingClientRect();
        row.style.removeProperty('width');
        return {
          rowHeight,
          sameLine: key.right <= value.left + 1 && Math.abs(key.top + key.height / 2 - value.top - value.height / 2) <= 2,
          reservedWidth: value.width / narrow.width,
          fits: value.right <= narrow.right + 1,
        };
      })()`,
    ),
  ) as { rowHeight: number; sameLine: boolean; reservedWidth: number; fits: boolean };
  assert(
    deviceRow.sameLine &&
      deviceRow.rowHeight < 32 &&
      deviceRow.fits &&
      deviceRow.reservedWidth > 0.5,
    'The device label and control share one compact row',
  );
  await clickButton('Inference device: Auto');
  await browser('wait', '--text', 'RTX 5090');
  await browser('wait', '--text', 'RTX 4070 Ti SUPER');
  await browser('wait', '--text', ambiguousReason);
  await browser('wait', '[aria-label="AMD integrated GPU"][aria-disabled="true"]');
  assert(deviceProbes > 0, 'Opening the device list probes Ollama');
  await clickButton('CPU');
  await browser(
    'wait',
    '--fn',
    `(() => {
      const button = document.querySelector('[aria-label="Inference device: CPU"]');
      if (!button) return false;
      const bounds = button.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return button.contains(hit);
    })()`,
  );
  assert.equal(memory.status(undefined, mobileSession.id).device.id, 'cpu');
  await clickButton('Inference device: CPU');
  await clickButton(selectedGpu.label);
  await browser('wait', '[aria-label="Inference device: RTX 4070 Ti SUPER"]');
  assert.equal(memory.status(undefined, mobileSession.id).device.id, selectedGpu.id);
  stage = 'native-activity-memory-live-rate';
  await host.api.agents
    .ref(mobileSession.id)
    .send('Measure live summary throughput', { clientMessageId: randomUUID() });
  await browser('wait', '--text', '12.5 tokens/s');
  await browser('wait', '--text', '19 tokens/s');
  assert.deepEqual(livePlacements[0], { mainGpu: 1 });
  let latestStored = false;
  for (let attempt = 0; attempt < 100 && !latestStored; attempt++) {
    const catalog = await memory.readStoredSummaries(mobileSession.id);
    latestStored = catalog.summaries.some((summary) =>
      summary.parts.some(
        ({ content }) => JSON.stringify(content) === JSON.stringify(latestSummary),
      ),
    );
    if (!latestStored) await Bun.sleep(100);
  }
  assert(latestStored, 'The live Session Memory summary completed before opening its catalog');
  stage = 'native-activity-memory-catalog';
  await browser('wait', '--text', 'Stored for this agent');
  await browser('find', 'role', 'button', 'click', '--name', 'Stored for this agent');
  await browser('wait', '--text', 'Est. tokens');
  await browser('wait', '--text', 'Source #');
  assert(
    !(await browser('snapshot')).includes('Background summary fixture'),
    'The narrow Explorer does not render summary bodies',
  );
  stage = 'native-activity-memory-json-tab';
  await clickButton('Open stored summaries');
  await browser('wait', '--text', 'Live throughput passage summary');
  await browser('wait', '--text', 'Background summary fixture');
  await browser('wait', '--text', 'activity-memory.sqlite');
  const jsonDisplay = JSON.parse(
    await browser(
      'eval',
      `(() => {
        const code = document.querySelector('[data-testid="ltcook-stored-summaries-json"]');
        const tokens = [...code.querySelectorAll('span')];
        return {
          font: getComputedStyle(code).fontFamily,
          colors: new Set(tokens.map(token => getComputedStyle(token).color)).size,
          summaries: JSON.parse(code.textContent),
        };
      })()`,
    ),
  ) as {
    font: string;
    colors: number;
    summaries: Array<{ parts: Array<{ content: unknown }> }>;
  };
  assert.match(jsonDisplay.font, /monospace/);
  assert(jsonDisplay.colors > 1, 'The Stored Summaries tab colors JSON syntax');
  assert.deepEqual(jsonDisplay.summaries[0]?.parts[0]?.content, latestSummary);
  await browser(
    'eval',
    `(() => {
      const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async value => {
        await writeText(value);
        window.__ltcookCopiedSummaries = value;
      };
    })()`,
  );
  await clickButton('Copy JSON');
  await browser('wait', '--text', 'Copied stored summaries');
  assert.deepEqual(
    JSON.parse(await browser('eval', 'JSON.parse(window.__ltcookCopiedSummaries)')),
    jsonDisplay.summaries,
  );
  await clickButton(mobileLeader.agent.title);
  await waitForComposer(mobileLeader.agent.title);
  stage = 'native-activity-memory-chat-shortcut';
  await browser('set', 'viewport', '1100', '950');
  const showSummary = '[aria-label="Show summary"]';
  const preview = '[data-testid="ltcook-passage-summary-preview"]';
  const completeSummary = '[data-testid="ltcook-passage-summary-complete"]';
  await browser(
    'wait',
    '--fn',
    `document.querySelectorAll(${JSON.stringify(showSummary)}).length === 2`,
  );
  async function openPassage(index: number) {
    await browser(
      'eval',
      `(() => {
      document.querySelectorAll('[data-ltcook-test-summary]').forEach(node => node.removeAttribute('data-ltcook-test-summary'));
      document.querySelectorAll(${JSON.stringify(showSummary)})[${index}].setAttribute('data-ltcook-test-summary', '');
    })()`,
    );
    await browser('click', '[data-ltcook-test-summary]');
    await browser('wait', preview);
  }
  await openPassage(0);
  await browser('wait', '--text', 'Background summary fixture');
  const earlier = await browser('get', 'text', preview);
  assert(earlier.includes('Background summary fixture'));
  assert(!earlier.includes('Live throughput passage summary'));
  assert(!earlier.includes('"findings"'), 'The chat preview is rendered as fields, not JSON');
  await clickButton('Hide summary');
  await openPassage(1);
  await browser('wait', '--text', 'Live throughput passage summary');
  const later = await browser('get', 'text', preview);
  assert(later.includes('Live throughput passage summary'));
  assert(!later.includes('Background summary fixture'));
  const previewLayout = JSON.parse(
    await browser(
      'eval',
      `(() => {
        const card = document.querySelector(${JSON.stringify(preview)});
        return {
          headings: [...card.querySelectorAll('[role="heading"], h1, h2, h3, h4, h5, h6')].map(node => node.textContent),
          fits: card.scrollWidth <= card.clientWidth + 1,
        };
      })()`,
    ),
  ) as { headings: string[]; fits: boolean };
  assert(previewLayout.headings.some((heading) => heading.includes('Findings')));
  assert(previewLayout.fits, 'Summary fields fit the narrow conversation');
  await browser('screenshot', path.join(directory, 'passage-summary-preview.png'));
  await clickButton('Open complete summary');
  await browser('wait', completeSummary);
  const complete = await browser('get', 'text', completeSummary);
  assert(complete.includes('Live throughput passage summary'));
  assert(!complete.includes('Background summary fixture'));
  assert(!complete.includes('"findings"'), 'The complete entry is rendered as fields, not JSON');
  await browser('screenshot', path.join(directory, 'passage-summary-complete.png'));
  await browser('press', 'Escape');
  await browser(
    'wait',
    '--fn',
    `(() => {
    const button = document.querySelector('[aria-label="Hide summary"]');
    if (!button) return false;
    const bounds = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  })()`,
  );
  await clickButton('Hide summary');
  await browser('set', 'viewport', '1440', '1000');
  await browser('find', 'role', 'button', 'click', '--name', 'Stored for this agent');
  await browser('wait', '--text', 'No acknowledged handoff available for this agent.');
  await browser('click', '[aria-label^="Session Memory,"]');

  let acknowledgeMemory: (() => void) | undefined;
  await memory.handoff(mobileSession.id, 'Summarize without Activity', undefined, (payload) => {
    acknowledgeMemory = memory!.prepareDelivery(mobileSession.id, adjutantId, payload);
  });
  assert(acknowledgeMemory, 'The Leader supplied a measured handoff');
  acknowledgeMemory();

  const panelNavigation = telemetry.begin('panel.navigation');
  try {
    await openExplorerPanel('Team');
    await browser('wait', '--text', 'Persistent members');
  } finally {
    panelNavigation.end();
  }
  const panel = await browser('snapshot');
  for (const heading of [
    'Leader',
    'Persistent members',
    'Temporary members',
    'Available temporary roles',
  ]) {
    assert(panel.includes(heading), `Contextual Team panel renders ${heading}`);
  }
  assert(panel.includes('Adjutant'), 'Contextual panel includes the connected persistent member');
  await inspectStage('contextual-team-panel');
  await clickButton('Diagnostics');
  await browser('wait', '--text', 'Agent Evals');
  await clickButton('Synthetic Setup');
  await clickButton('Summarization only');
  await clickButton('Run full qualification');
  await browser('wait', '--text', 'Summarization qualification · failed');
  await inspectStage('contextual-diagnostics');
  await clickButton('Team Overview');
  await browser('wait', '--text', 'Persistent members');
  await clickButton('Open conversation');
  await waitForComposer('Adjutant');
  await inspectStage('panel-direct-child-conversation');
  stage = 'native-activity-memory-handoff';
  await openActivityPanel();
  await browser('wait', '[aria-label^="Session Memory,"][aria-label*="Handoff received"]');
  await browser('click', '[aria-label^="Session Memory,"]');
  await browser('wait', '--text', 'Summaries represented');
  const handoff = await browser('snapshot');
  assert(handoff.includes(mobileLeader.agent.title), 'Activity names the sending Leader');
  await browser('click', '[aria-label^="Session Memory,"]');
  await openExplorerPanel('Tasks');
  await browser('wait', '--text', 'Task Board');
  await inspectStage('contextual-task-board');

  stage = 'session-worktree-changes';
  const gitCheckout = await host.api.workspaces.open(gitWorkspace);
  const created = await Promise.all(
    ['first', 'second'].map(async (name) => {
      const agent = await gitCheckout.agents.create({
        title: `Worktree fixture ${name}`,
        config: { provider: 'pi/fixture/test' },
        env: environment,
      });
      return { name, agent, checkout: path.join(directory, `changes-${name}`) };
    }),
  );
  const [first, second] = created;
  assert(first && second);
  for (const { name, agent, checkout } of created) {
    await run('git', ['worktree', 'add', '-b', `changes/${name}`, checkout], {
      cwd: gitWorkspace,
    });
    await writeFile(path.join(checkout, `${name}-session.txt`), `${name} worktree change\n`);
    const grant = await fetch(`${endpoint}/v1/mcp/grant`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        nativeAgentId: agent.id,
        workspaceRoot: gitWorkspace,
        provider: 'pi',
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(grant.status, 200);
    const { token } = (await grant.json()) as { token: string };
    const client = new Client({ name: 'worktree-fixture', version: '1.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      const registration = await client.callTool({
        name: 'ltcook_worktree',
        arguments: { operation: 'use', path: checkout },
      });
      assert.deepEqual(registration.structuredContent, { ok: true });
    } finally {
      await client.close();
    }
  }
  const serverId = JSON.parse(
    await browser('eval', `decodeURIComponent(location.pathname.split('/')[2] ?? '')`),
  ) as string;
  assert(serverId);
  for (const { name, agent } of [second, first]) {
    await browser(
      'open',
      `http://${host.listen}${buildAgentDeepLinkRoute({ serverId, agentId: agent.id })}`,
    );
    await waitForComposer(`Worktree fixture ${name}`);
  }
  await browser('click', `${explorer} [data-testid="workspace-tab-changes_tree"]`);
  const worktreePicker = '[data-testid="changes-worktree-picker"]';
  await browser('wait', worktreePicker);
  await browser('wait', '--text', 'first-session.txt');
  await browser('click', worktreePicker);
  await browser('find', 'text', 'Original checkout', 'click', '--exact');
  await browser('wait', '[data-testid="changes-branch-switcher"]');
  await clickButton('Worktree fixture second');
  await browser('wait', '--text', 'second-session.txt');
  await clickButton('Worktree fixture first');
  await browser('wait', '[data-testid="changes-branch-switcher"]');
  await browser('click', worktreePicker);
  await browser('find', 'text', 'Follow session', 'click', '--exact');
  await browser('wait', '--text', 'first-session.txt');
  await unlink(path.join(first.checkout, 'first-session.txt'));
  await run('git', ['worktree', 'remove', first.checkout], { cwd: gitWorkspace });
  await browser('wait', '[data-testid="changes-branch-switcher"]');
  await inspectStage('session-worktree-changes');

  await telemetry.exportTrace();
  const trace = JSON.parse(await readFile(tracePath, 'utf8')) as {
    traceEvents: Array<{ name: string; ph: string; dur?: number; ts: number }>;
  };
  for (const operation of [
    'team.catalog',
    'session.open',
    'leader.adopt',
    'member.create',
    'panel.refresh',
    'panel.navigation',
  ]) {
    const events = trace.traceEvents.filter((event) => event.name === operation);
    const complete = events.some(
      (event) => event.ph === 'X' && typeof event.dur === 'number' && event.dur >= 0,
    );
    const start = events.find((event) => event.ph === 'B');
    const finish = events.find((event) => event.ph === 'E');
    assert(
      complete || (start && finish && finish.ts >= start.ts),
      `Existing telemetry measured ${operation}`,
    );
  }
  console.log(
    JSON.stringify({
      result: 'passed',
      desktop: 'new-workspace Team selection and native chat',
      mobile: 'draft Team selection and native chat',
      teamsBrowser: 'reuse and New Session',
      childNavigation: 'native subagent track and contextual panel',
      panels: 'Activity Explorer, Team hierarchy, Task Board, Diagnostics',
      telemetry: 'existing Perfetto timings exported',
      modelCalls,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      failedStage: stage,
      snapshot: await browser('snapshot').catch(() => 'Browser unavailable'),
      console: await browser('console').catch(() => 'Console unavailable'),
      pageErrors: await browser('errors').catch(() => 'Page errors unavailable'),
      touchEvents: await browser('eval', 'window.__ltcookTouchEvents ?? []').catch(
        () => 'Touch events unavailable',
      ),
    }),
  );
  throw error;
} finally {
  await browser('close').catch(() => undefined);
  await memory?.close();
  await host?.close();
  await runtime?.close();
  await evals.close();
  await api.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
}

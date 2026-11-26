import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readDaemonInstance } from '@getpaseo/server/daemon-control';
import { Telemetry } from '../../../runtime/src/diagnostics/telemetry.js';
import { EvalRunService } from '../../../runtime/src/evals/service.js';
import path from 'node:path';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import { createPaseoMemorySource } from '../../../runtime/src/integrations/paseo-memory.js';
import { MemoryStore } from '../../../runtime/src/session-memory/store.js';
import { SessionMemory } from '../../../runtime/src/session-memory/service.js';
import { WorkspaceMcp } from '../../../runtime/src/integrations/mcp.js';
import { ToolCatalog } from '../../../runtime/src/tools/catalog.js';
import { agentBearer, RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import { SessionActivation } from '../../../runtime/src/integrations/session-activation.js';
import { ActivityPreferences } from '../../../runtime/src/integrations/activity-preferences.js';
import {
  createWorktreeScopeResolver,
  SessionWorktrees,
} from '../../../runtime/src/integrations/session-worktrees.js';
import { createColgrepProvider } from '../../../runtime/src/repository/providers/colgrep.js';
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
  LTCOOK_MODEL_LOCAL_CPU: 'fixture-cpu',
  LTCOOK_MODEL_LOCAL_EVALS: 'fixture-evals',
  LTCOOK_GUIDANCE_DIR: path.join(directory, 'guidance'),
  LTCOOK_BROWSER_ENABLED: 'false',
  LTCOOK_CODESEARCH_ENABLED: 'false',
  LTCOOK_CONTEXT7_ENABLED: 'false',
};
const tracePath = path.join(directory, 'gui.perfetto.json');
const telemetry = new Telemetry(path.join(directory, 'gui.events.jsonl'), tracePath);
let runtime: ReturnType<typeof createRuntime> | undefined;
const colgrep = createColgrepProvider();
const preferences = new ActivityPreferences(path.join(directory, 'activity-settings.json'));
const worktrees = new SessionWorktrees(process.env.PATH ?? '');
const resolveScope = createWorktreeScopeResolver((id) => runtime?.snapshot(id));
const activation = new SessionActivation(environment);
const api = new RuntimeApi(undefined, secret, listen, activation, environment, telemetry, {
  activity: { colgrep, preferences },
  worktrees: { store: worktrees, resolveScope },
});
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
const tools = new ToolCatalog([]);
api.setWorkspaceTools(tools);
api.setWorkspaceMcp(new WorkspaceMcp(tools, listen));
await api.listen();
let host: Awaited<ReturnType<typeof startPaseoHost>> | undefined;
let memory: SessionMemory | undefined;
let backgroundSummary = false;
let activityRequests = 0;
const paseoHome = path.join(deployment, 'paseo');
try {
  host = await startPaseoHost({
    node,
    home: paseoHome,
    deploymentRoot: deployment,
    listen: '127.0.0.1:0',
    runtimeApiUrl: endpoint,
    userToken: secret,
    pluginDirectory: path.join(root, 'runtime/dist/paseo-plugin'),
    environment,
    piCommand: path.join(root, 'runtime/dist/integrations/pi-rpc.js'),
  });
  const reserveIdleRestart = host.reserveIdleRestart;
  assert(reserveIdleRestart, 'The staged supervisor and its worker expose idle restart');
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
  activation.setWorkspaceActivator(async (request) =>
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
  api.setPrepareSessionHandler(async (options, leaderAgentId, savedModel) => {
    const prepared = await backend.prepare(options, leaderAgentId, savedModel);
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

  await browser(
    'wait',
    '--fn',
    `(() => {
      const row = document.querySelector('[aria-label^="Adjutant,"]');
      return row && row.getAttribute('aria-expanded') !== 'true';
    })()`,
  );
  await browser('wait', '[aria-label="Open Adjutant conversation"]');
  assert.equal(
    (await browser('get', 'text', '[aria-label="Open Adjutant conversation"]')).trim(),
    'Open',
  );
  await clickButton('Open Adjutant conversation');
  await waitForComposer('Adjutant');
  await browser('set', 'viewport', '1440', '1000');
  await browser(
    'wait',
    '--fn',
    `Boolean(document.querySelector('[aria-label="Adjutant"][aria-selected="true"]'))`,
  );
  assert.equal(
    (
      await browser(
        'eval',
        `document.querySelectorAll('[aria-label="Adjutant"][aria-selected]').length`,
      )
    ).trim(),
    '1',
    'Open reuses the Adjutant tab opened earlier',
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
  const busyRestart = await reserveIdleRestart();
  assert(busyRestart.status === 'busy' && busyRestart.activeTurns > 0);
  await inspectStage('native-activity-parallel-tools');
  await browser('wait', '--text', 'Activity parallel fixture done.');
  await clickButton(`Back to ${mobileLeader.agent.title}`);
  await waitForComposer(mobileLeader.agent.title);
  await browser('wait', '--text', 'RAG Index');

  const selectedGpu = { id: 'CUDA:fixture-4070', label: 'RTX 4070 Ti SUPER', mainGpu: 1 };
  const summaryContent = '## Discoveries\n\n- Background summary fixture';
  const summaryLink = 'https://example.com/cache/replay';
  const showSummary = '[aria-label="Show summary"]';
  const preview = '[data-testid="ltcook-passage-summary-preview"]';
  const completeSummary = '[data-testid="ltcook-passage-summary-complete"]';
  const summaryStart = '## Discoveries\n\n- Live throughput passage summary\n\n';
  const latestSummary =
    summaryStart +
    '- ' +
    'Verified the cache result. '.repeat(41) +
    `[Cache evidence](${summaryLink}).\n\n- Final summary outcome remains visible.`;
  const linkStart = latestSummary.indexOf('[Cache evidence]');
  assert(linkStart < 1200 && latestSummary.indexOf(summaryLink) + summaryLink.length > 1200);
  const longerPrompt =
    ' Keep this Session Memory fixture long enough to qualify for inference.'.repeat(18);
  const ambiguousReason = 'Ollama cannot select this device uniquely.';
  let redoBackgroundContent: string | undefined;
  let deviceProbes = 0;
  const livePlacements: Array<{ cpuOnly?: boolean; mainGpu?: number }> = [];
  memory = new SessionMemory({
    databasePath: path.join(directory, 'activity-memory.sqlite'),
    source: createPaseoMemorySource(host.api, secret),
    inference: {
      hosted: { model: 'gpt-6-luna', reasoning: 'high' },
      local: { model: 'fixture-local-memory', reasoning: 'none' },
    },
    hostedUsage: () => ({
      requests: 1,
      inputTokens: 321,
      cachedInputTokens: 32,
      outputTokens: 123,
      reasoningTokens: 12,
      lastLatencyMs: 250,
    }),
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
      const isBackgroundSummary = input.includes('Summarize without Activity');
      if (isBackgroundSummary) backgroundSummary = true;
      const isLatest = input.includes('Measure live summary throughput');
      if (isLatest) {
        livePlacements.push(placement);
        onProgress?.({ tokensPerSecond: 12.5, estimated: true });
        await Bun.sleep(2100);
        onProgress?.({ tokensPerSecond: 19, estimated: true });
        await Bun.sleep(2100);
      }
      const content = isLatest
        ? latestSummary
        : isBackgroundSummary
          ? (redoBackgroundContent ?? summaryContent)
          : summaryContent;
      return {
        type,
        text: content,
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
    .send('Summarize without Activity' + longerPrompt, { clientMessageId: randomUUID() });
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
  assert.equal(colgrep.isIndexingEnabled(), false);
  await browser('click', indexingSwitch);
  await browser(
    'wait',
    '--fn',
    `document.querySelector(${JSON.stringify(indexingSwitch)})?.checked === true`,
  );
  assert.equal(colgrep.isIndexingEnabled(), true);
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
  assert.equal(memory.status(undefined, mobileSession.id).device?.id, 'cpu');
  await clickButton('Inference device: CPU');
  await clickButton(selectedGpu.label);
  await browser('wait', '[aria-label="Inference device: RTX 4070 Ti SUPER"]');
  assert.equal(memory.status(undefined, mobileSession.id).device?.id, selectedGpu.id);
  stage = 'native-activity-memory-inference';
  await browser(
    'wait',
    '--fn',
    `(() => {
      const button = document.querySelector('[aria-label="Inference mode: Local"]');
      if (!button) return false;
      const bounds = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
    })()`,
  );
  await clickButton('Inference mode: Local');
  await browser(
    'wait',
    '--text',
    'Hosted sends current prompts and included attachment text to OpenAI.',
  );
  await clickButton('Hosted');
  await browser('wait', '[aria-label="Inference mode: Hosted"]');
  await browser(
    'wait',
    '--fn',
    `document.querySelector('[data-testid="ltcook-memory-device-row"]') === null`,
  );
  await browser('wait', '--text', 'gpt-6-luna');
  await browser('wait', '--text', '321 (32 cached)');
  await browser('wait', '--text', '123 (12 reasoning)');
  await browser('click', summarizerSwitch);
  const pausedHostedMemory =
    '[aria-label^="Session Memory,"][aria-label*="gpt-6-luna · Reasoning high"][aria-label$="Paused"]';
  await browser('wait', pausedHostedMemory);
  await browser('click', pausedHostedMemory);
  await browser('wait', '--text', 'Hosted · gpt-6-luna · Reasoning high');
  await browser('click', pausedHostedMemory);
  await clickButton('Inference mode: Hosted');
  await clickButton('Local');
  await browser(
    'wait',
    '[aria-label^="Session Memory,"][aria-label*="fixture-local-memory"][aria-label$="Paused"]',
  );
  await browser('wait', '[aria-label="Inference device: RTX 4070 Ti SUPER"]');
  await browser('click', summarizerSwitch);
  await browser(
    'wait',
    '--fn',
    `document.querySelector(${JSON.stringify(summarizerSwitch)})?.checked === true`,
  );
  stage = 'native-activity-memory-chat-redo';
  await clickButton('Close Explorer sidebar');
  await waitForComposer(mobileLeader.agent.title);
  await browser(
    'wait',
    '--fn',
    `document.querySelectorAll(${JSON.stringify(showSummary)}).length > 0`,
  );
  await browser('click', showSummary);
  await browser('wait', preview);
  await browser('wait', '--text', 'Background summary fixture');
  const firstStored = await memory.readStoredSummaries(mobileSession.id);
  const backgroundRecord = firstStored.summaries.find(({ parts }) =>
    parts.some(({ content }) => JSON.stringify(content) === JSON.stringify(summaryContent)),
  );
  assert(backgroundRecord);
  redoBackgroundContent = `${summaryContent}\n\n- Passage redo regenerated this summary.`;
  await browser('click', `${preview} [aria-label="Redo this passage summary"]`);
  await browser(
    'wait',
    '--fn',
    `document.querySelector(${JSON.stringify(preview)})?.textContent.includes(${JSON.stringify('Redo complete.')}) && document.querySelector(${JSON.stringify(preview)})?.textContent.includes(${JSON.stringify('Passage redo regenerated this summary.')})`,
  );
  const afterPassageRedo = await memory.readStoredSummaries(mobileSession.id);
  assert(
    afterPassageRedo.summaries
      .find(({ id }) => id === backgroundRecord.id)
      ?.parts.some(
        ({ content }) => JSON.stringify(content) === JSON.stringify(redoBackgroundContent),
      ),
  );
  await browser('scrollintoview', `${preview} [aria-label="Hide summary"]`);
  await browser('click', `${preview} [aria-label="Hide summary"]`);
  await browser('wait', preview, '--state', 'hidden');

  await clickButton('Open Explorer sidebar');
  await browser('wait', '--text', 'Recent conversation activity');
  const sessionMemoryHeader = '[aria-label^="Session Memory,"]';
  await browser(
    'eval',
    `(() => { const button = document.querySelector(${JSON.stringify(sessionMemoryHeader)}); if (button?.getAttribute('aria-expanded') !== 'true') button?.click(); })()`,
  );
  const storedAgent = '[aria-label^="Stored for this agent,"]';
  await browser(
    'eval',
    `(() => { const button = document.querySelector(${JSON.stringify(storedAgent)}); if (button?.getAttribute('aria-expanded') !== 'true') button?.click(); })()`,
  );
  await clickButton('Redo summaries from a selected point');
  await browser('wait', '--text', 'Choose where to start.');
  await browser('wait', '[aria-label^="UAMP ·"]');
  await browser(
    'eval',
    `(() => { const choices = [...document.querySelectorAll('button[aria-label^="UAMP ·"]')]; if (!choices.length) throw new Error('Expected a Discussion summary to redo.'); choices.at(-1).click(); })()`,
  );
  redoBackgroundContent = `${summaryContent}\n\n- Sidebar redo regenerated this summary.`;
  await clickButton('Redo from selected summary');
  await browser('wait', '--text', 'Redo complete.');
  const afterSidebarRedo = await memory.readStoredSummaries(mobileSession.id);
  assert(
    afterSidebarRedo.summaries.some(({ parts }) =>
      parts.some(
        ({ content }) => JSON.stringify(content) === JSON.stringify(redoBackgroundContent),
      ),
    ),
  );
  await browser('press', 'Escape');
  await browser('wait', '[role="dialog"]', '--state', 'hidden');
  await browser('click', storedAgent);

  stage = 'native-activity-memory-live-rate';
  await host.api.agents
    .ref(mobileSession.id)
    .send('Measure live summary throughput. Exercise Activity tools.' + longerPrompt, {
      clientMessageId: randomUUID(),
    });
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
  stage = 'native-activity-memory-records-tab';
  await clickButton('Open stored summaries');
  await browser('wait', '--text', 'Live throughput passage summary');
  await browser('wait', '--text', 'Background summary fixture');
  await browser('wait', '--text', 'activity-memory.sqlite');
  const storedRecords = '[data-testid="ltcook-stored-summaries-records"]';
  const headings = await browser(
    'eval',
    `[...document.querySelectorAll(${JSON.stringify(storedRecords + ' h2')})].map(node => node.textContent)`,
  );
  assert.match(headings, /Discoveries/, 'The Stored Summaries tab renders the Markdown heading');
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
  const copiedRecords = JSON.parse(
    await browser('eval', 'JSON.parse(window.__ltcookCopiedSummaries)'),
  ) as { parts: { content: unknown }[] }[];
  assert.equal(copiedRecords[0]?.parts[0]?.content, latestSummary);
  await clickButton(mobileLeader.agent.title);
  await waitForComposer(mobileLeader.agent.title);
  stage = 'native-activity-memory-chat-shortcut';
  await browser('set', 'viewport', '1100', '950');
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
  const recordsBeforePassageRedo = await memory.readStoredSummaries(mobileSession.id);
  const firstSummary = recordsBeforePassageRedo.summaries.find(({ parts }) =>
    parts.some(({ content }) => JSON.stringify(content) === JSON.stringify(redoBackgroundContent)),
  );
  const laterSummary = recordsBeforePassageRedo.summaries.find(({ parts }) =>
    parts.some(({ content }) => JSON.stringify(content) === JSON.stringify(latestSummary)),
  );
  assert(firstSummary && laterSummary);
  redoBackgroundContent = `${summaryContent}\n\n- Passage redo regenerated this summary a second time.`;
  await browser('click', `${preview} [aria-label="Redo this passage summary"]`);
  await browser(
    'wait',
    '--fn',
    `document.querySelector(${JSON.stringify(preview)})?.textContent.includes(${JSON.stringify('Redo complete.')}) && document.querySelector(${JSON.stringify(preview)})?.textContent.includes(${JSON.stringify('Passage redo regenerated this summary a second time.')})`,
  );
  const recordsAfterPassageRedo = await memory.readStoredSummaries(mobileSession.id);
  assert(
    recordsAfterPassageRedo.summaries
      .find(({ id }) => id === firstSummary.id)
      ?.parts.some(
        ({ content }) => JSON.stringify(content) === JSON.stringify(redoBackgroundContent),
      ),
  );
  assert.deepEqual(
    recordsAfterPassageRedo.summaries.find(({ id }) => id === laterSummary.id),
    laterSummary,
  );
  assert(
    memory.status(undefined, mobileSession.id).redos.filter(({ state }) => state === 'completed')
      .length >= 3,
    'Completed redo request statuses remain available to slower UI subscribers.',
  );
  await clickButton('Hide summary');
  await openPassage(1);
  await browser('wait', '--text', 'Live throughput passage summary');
  const later = await browser('get', 'text', preview);
  assert(later.includes('Live throughput passage summary'));
  assert(later.includes('Final summary outcome remains visible.'));
  assert.equal((await browser('get', 'attr', `${preview} a`, 'href')).trim(), summaryLink);
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
  assert(previewLayout.headings.some((heading) => heading.includes('Discoveries')));
  assert(previewLayout.fits, 'Summary fields fit the narrow conversation');
  await browser('screenshot', path.join(directory, 'passage-summary-preview.png'));
  await browser('click', `${preview} [aria-label="Show execution details"]`);
  const execution = `${preview} [data-testid="ltcook-execution-evidence"]`;
  await browser('wait', execution);
  await browser(
    'wait',
    '--fn',
    `document.querySelector(${JSON.stringify(execution)})?.textContent.includes(${JSON.stringify(fixtureSkill)})`,
  );
  const hideDetails = `${preview} [aria-label="Hide execution details"]`;
  await browser('scrollintoview', hideDetails);
  await browser('click', hideDetails);
  await clickButton('Open complete summary');
  await browser('wait', completeSummary);
  const complete = await browser('get', 'text', completeSummary);
  assert(complete.includes('Live throughput passage summary'));
  assert(!complete.includes('Background summary fixture'));
  assert(!complete.includes('"findings"'), 'The complete entry is rendered as fields, not JSON');
  await browser('screenshot', path.join(directory, 'passage-summary-complete.png'));
  assert(complete.includes('Final summary outcome remains visible.'));
  await browser('press', 'Escape');
  await browser('wait', completeSummary, '--state', 'hidden');
  await browser('scrollintoview', `${preview} [aria-label="Hide summary"]`);
  await browser(
    'wait',
    '--fn',
    `(() => {
    const button = document.querySelector(${JSON.stringify(`${preview} [aria-label="Hide summary"]`)});
    if (!button) return false;
    const bounds = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
  })()`,
  );
  await browser('click', `${preview} [aria-label="Hide summary"]`);
  assert(!(await browser('snapshot')).includes('Final summary outcome remains visible.'));

  const memoryStore = new MemoryStore(path.join(directory, 'activity-memory.sqlite'));
  try {
    const catalog = await memory.readStoredSummaries(mobileSession.id);
    const action = catalog.summaries.find(
      ({ type, discussionId }) =>
        type === 'AAB' &&
        discussionId === catalog.summaries.find(({ type }) => type === 'UAMP')?.id,
    );
    assert(action);
    const record = memoryStore.summary(mobileSession.id, action.epoch, action.id);
    assert(record?.action);
    for (let index = 0; index < 8; index++) {
      const checks = [{ seq: action.position, text: `Pagination evidence ${index}` }];
      memoryStore.saveSummary({
        ...record,
        id: `!pagination-${index}`,
        action: { ...record.action, checkCount: checks.length, checks },
      });
    }
  } finally {
    memoryStore.close();
  }
  await openPassage(1);
  await clickButton('Open loaded summaries');
  await browser('wait', completeSummary);
  assert(!(await browser('get', 'text', completeSummary)).includes('Pagination evidence 0'));
  await browser('press', 'Escape');
  await browser('wait', completeSummary, '--state', 'hidden');
  await clickButton('Load older passage records');
  await browser('wait', '--text', 'Pagination evidence 0');
  assert(
    (await browser('get', 'text', preview)).includes('Final summary outcome remains visible.'),
  );
  await clickButton('Open complete summary');
  await browser('wait', completeSummary);
  await browser('press', 'Escape');
  await browser('wait', completeSummary, '--state', 'hidden');
  await clickButton('Hide summary');
  await host.api.agents
    .ref(mobileSession.id)
    .send('Keep this reply short.', { clientMessageId: randomUUID() });
  await browser(
    'wait',
    '--fn',
    `document.querySelectorAll(${JSON.stringify(showSummary)}).length === 3`,
  );
  await openPassage(2);
  await browser('wait', '--text', 'Not summarized, user-agent message pair is below 256 tokens.');
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
  stage = 'native-idle-restart';
  const rejected = await fetch(`http://${host.listen}/api/ltcook/idle-restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'status' }),
  });
  assert.equal(rejected.status, 403);
  const reservation = await reserveIdleRestart();
  assert.equal(reservation.status, 'reserved');
  const priorModelCalls = modelCalls;
  try {
    await assert.rejects(
      host.api.agents.ref(mobileSession.id).send('Prompt blocked by idle restart'),
      /reserved for an LTCook restart/,
    );
    assert.equal(modelCalls, priorModelCalls);
  } finally {
    await reservation.release();
  }
  const committed = await reserveIdleRestart();
  assert.equal(committed.status, 'reserved');
  assert.deepEqual(await committed.commit(), { status: 'committed' });
  const shutdownDeadline = Date.now() + 10_000;
  while ((await readDaemonInstance(paseoHome)) && Date.now() < shutdownDeadline) {
    await Bun.sleep(100);
  }
  assert.equal(await readDaemonInstance(paseoHome), null);
  console.log(
    JSON.stringify({
      result: 'passed',
      desktop: 'new-workspace Team selection and native chat',
      mobile: 'draft Team selection and native chat',
      teamsBrowser: 'reuse and New Session',
      childNavigation: 'native subagent track and contextual panel',
      panels: 'Activity Explorer, Team hierarchy, Task Board, Diagnostics',
      telemetry: 'existing Perfetto timings exported',
      idleRestart: 'busy refusal, admission freeze, release and graceful shutdown',
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

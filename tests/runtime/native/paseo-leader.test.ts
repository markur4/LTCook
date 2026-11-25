import { afterEach, expect, test } from 'bun:test';
import type {
  PluginServerContext,
  PluginHookContext,
  PluginHooks,
  PluginHookPayload,
  PluginHookResult,
} from '@getpaseo/plugin/server';
import contribute from '../../../runtime/src/paseo-plugin/index.server.js';

type Hook<Name extends keyof PluginHooks> = (
  payload: PluginHookPayload<Name>,
  context?: PluginHookContext,
) => Promise<PluginHookResult<Name>>;
const originalFetch = globalThis.fetch;
const oldEndpoint = process.env.LTCOOK_RUNTIME_API_URL;
const oldToken = process.env.LTCOOK_RUNTIME_USER_TOKEN;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (oldEndpoint === undefined) delete process.env.LTCOOK_RUNTIME_API_URL;
  else process.env.LTCOOK_RUNTIME_API_URL = oldEndpoint;
  if (oldToken === undefined) delete process.env.LTCOOK_RUNTIME_USER_TOKEN;
  else process.env.LTCOOK_RUNTIME_USER_TOKEN = oldToken;
});
function hooks() {
  const registered = new Map<string, unknown>();
  contribute({
    addHook(name: string, handler: unknown) {
      registered.set(name, handler);
      return () => registered.delete(name);
    },
    handle() {},
  } as unknown as PluginServerContext);
  return <Name extends keyof PluginHooks>(name: Name) => registered.get(name) as Hook<Name>;
}
const savedModel = {
  alias: 'plan',
  provider: 'openai-codex',
  model: 'gpt-6.2-sol',
  reasoning: 'high',
  preset: 'xhigh',
  reasoningSource: 'team',
} as const;
const openRequest = {
  agentId: 'native-leader',
  workspaceId: 'workspace',
  provider: 'ltcook',
  cwd: '/workspace',
  reason: 'create' as const,
  purpose: 'interactive' as const,
  title: 'Work title',
  background: false,
  labels: {},
  metadata: { 'ltcook.team': 'default', 'ltcook.resolved-model': savedModel },
  tools: [],
  env: {},
  mcpServers: {},
};
test('adopts the actual Leader before obtaining scoped environment without creating an agent', async () => {
  const hook = hooks()('agent.open.before');
  process.env.LTCOOK_RUNTIME_API_URL = 'http://runtime.invalid';
  process.env.LTCOOK_RUNTIME_USER_TOKEN = 'server-secret';
  const calls: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(url), body: JSON.parse(String(init?.body)) });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-secret');
    return String(url).endsWith('/prepare')
      ? Response.json({
          env: { LTCOOK_NATIVE_AGENT_ID: 'native-leader', LTCOOK_MEMBER_KEY: 'leader' },
        })
      : Response.json({ sessionId: 'native-leader' });
  }) as typeof fetch;
  const result = await hook({ request: { ...openRequest, reason: 'resume' } });
  expect(calls.map((call) => call.path)).toEqual([
    'http://runtime.invalid/v1/session/open',
    'http://runtime.invalid/v1/session/prepare',
  ]);
  expect(calls[0]?.body).toEqual({
    sessionId: 'native-leader',
    leaderAgentId: 'native-leader',
    workspaceRoot: '/workspace',
    teamSelection: 'default',
  });
  expect(calls[1]?.body).toMatchObject({ savedModel });
  expect(result?.env.LTCOOK_NATIVE_AGENT_ID).toBe('native-leader');
  expect(result?.title).toBe('Work title');
});
test('ordinary Pi, Codex, and history access never activate a Team', async () => {
  const hook = hooks()('agent.open.before');
  process.env.LTCOOK_RUNTIME_API_URL = 'http://runtime.invalid';
  process.env.LTCOOK_RUNTIME_USER_TOKEN = 'server-secret';
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer server-secret');
    return Promise.resolve(Response.json({ token: 'scoped-to-the-workspace' }));
  }) as typeof fetch;
  for (const provider of ['pi', 'codex']) {
    const prepared = await hook({
      request: { ...openRequest, provider, env: { LTCOOK_RUNTIME_USER_TOKEN: 'server-secret' } },
    });
    expect(prepared?.mcpServers.ltcook_workspace).toMatchObject({
      type: 'http',
      url: 'http://runtime.invalid/mcp',
      headers: { Authorization: 'Bearer scoped-to-the-workspace' },
    });
    expect(JSON.stringify(prepared)).not.toContain('server-secret');
  }
  expect(await hook({ request: { ...openRequest, purpose: 'history' } })).toBeUndefined();
  expect(calls).toEqual(Array(2).fill('http://runtime.invalid/v1/mcp/grant'));
});
test('missing Team selection fails before opening native LTCook', async () => {
  const hook = hooks()('agent.create.before');
  await expect(
    hook({ request: { config: { provider: 'ltcook', cwd: '/workspace' }, metadata: {} } }),
  ).rejects.toThrow('Choose an installed Team');
  expect(
    await hook({ request: { config: { provider: 'pi', cwd: '/workspace' } } }),
  ).toBeUndefined();
});

test('anchors summary shortcuts to each completed turn and current timeline epoch', async () => {
  const hook = hooks()('agent.turn.after');
  process.env.LTCOOK_RUNTIME_API_URL = 'http://runtime.invalid';
  process.env.LTCOOK_RUNTIME_USER_TOKEN = 'server-secret';
  globalThis.fetch = (async () => Response.json({ memoryEnabled: true })) as typeof fetch;
  let epoch = 'before-rewind';
  let resetBefore = false;
  const appended: Array<{
    id: string;
    type: string;
    kind: string;
    version: number;
    data: unknown;
  }> = [];
  const earlier = [
    { seqEnd: 4, turnId: 'previous', item: { type: 'assistant_message', text: 'Earlier' } },
    { seqEnd: 6, turnId: 'turn', item: { type: 'user_message', text: 'First prompt' } },
  ];
  const tail = [
    { seqEnd: 8, turnId: 'turn', item: { type: 'assistant_message', text: 'First response' } },
    {
      seqEnd: 9,
      turnId: 'turn',
      item: { type: 'tool_call', status: 'completed', detail: { type: 'unknown' } },
    },
    { seqEnd: 10, turnId: 'another', item: { type: 'user_message', text: 'Second prompt' } },
    { seqEnd: 11, turnId: 'another', item: { type: 'assistant_message', text: 'Second response' } },
    { seqEnd: 12, turnId: 'another', item: { type: 'assistant_message', text: ' ' } },
  ];
  const timeline = {
    async append(row: (typeof appended)[number]) {
      appended.push(row);
      return { epoch };
    },
    async refetch({ direction }: { direction: 'tail' | 'before' }) {
      const before = direction === 'before';
      return {
        epoch,
        agent: { archivedAt: null },
        startCursor: { epoch, seq: before ? 4 : 8 },
        hasOlder: !before,
        reset: before && resetBefore,
        entries: before ? earlier : [...tail, ...appended.map((item) => ({ item }))],
      };
    },
  };
  const context = {
    signal: new AbortController().signal,
    paseo: { agents: { ref: () => ({ timeline }) } } as unknown as PluginHookContext['paseo'],
  };
  const turn = {
    agent: {
      id: 'native-leader',
      workspaceId: 'workspace',
      parentAgentId: null,
      provider: 'pi',
      cwd: '/workspace',
      title: null,
      background: false,
      metadata: {},
    },
    turnId: 'turn',
    outcome: { kind: 'completed' as const },
    timeline: [],
  };
  await hook(turn, context);
  await hook(turn, context);
  await hook({ ...turn, turnId: 'another' }, context);
  expect(appended).toEqual([
    {
      type: 'plugin',
      id: 'memory-summaries:turn',
      kind: 'memory-summaries',
      version: 1,
      data: { passage: { epoch, start: 6, position: 8 } },
    },
    {
      type: 'plugin',
      id: 'memory-summaries:another',
      kind: 'memory-summaries',
      version: 1,
      data: { passage: { epoch, start: 10, position: 11 } },
    },
  ]);
  epoch = 'after-rewind';
  resetBefore = true;
  await hook(turn, context);
  expect(appended).toHaveLength(2);
  resetBefore = false;
  await hook(turn, context);
  expect(appended).toHaveLength(3);
  expect(appended[2]).toMatchObject({
    id: 'memory-summaries:turn',
    data: { passage: { epoch, start: 6, position: 8 } },
  });
});

test('a real turn fails before inference when native initialization is unavailable', async () => {
  const { createRuntime } = await import('../../../runtime/src/core/runtime.js');
  const { default: team } = await import('../../../teams/default-minimal/src/index.js');
  const runtime = createRuntime({
    databasePath: ':memory:',
    team,
    agents: {
      async list() {
        throw new Error('Native directory unavailable');
      },
      async create() {
        throw new Error('Unexpected native creation');
      },
      async inspect() {
        return null;
      },
      async send() {},
      async close() {},
    },
  });
  try {
    await runtime.openSession({
      id: 'leader-native',
      leaderAgentId: 'leader-native',
      workspaceRoot: '/workspace',
    });
    await expect(
      runtime.execute(
        'leader-native',
        { kind: 'agent', nativeAgentId: 'leader-native' },
        {
          type: 'guidance.loaded',
          inspection: { resources: [], diagnostics: [] },
          waitUntilReady: true,
        },
      ),
    ).rejects.toThrow('Native directory unavailable');
    await expect(
      runtime.execute(
        'leader-native',
        { kind: 'agent', nativeAgentId: 'unbound-native' },
        {
          type: 'guidance.loaded',
          inspection: { resources: [], diagnostics: [] },
          waitUntilReady: true,
        },
      ),
    ).rejects.toThrow('Session must be explicitly opened');
  } finally {
    await runtime.close();
  }
});

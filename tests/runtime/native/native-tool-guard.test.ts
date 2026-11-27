import { Value } from 'typebox/value';
import { afterEach, expect, test } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import activate from '../../../runtime/src/integrations/pi-extension.js';
import { guardEvaluationModelRuntime } from '../../../runtime/src/integrations/pi-rpc.js';
import { bugHunterTeamId } from '../../../runtime/src/services/bughunter-team.js';
import {
  EVAL_CONTEXT_WINDOW,
  EVAL_MODEL,
  EVALUATION_EXECUTION_CONTEXT,
} from '../../../runtime/src/evals/setup.js';
const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

test('BugScan sanitizes native source reads and drops binary data before returning output', async () => {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const pi = {
    on(name: string, handler: (event: unknown) => unknown) {
      handlers.set(name, handler);
    },
    registerTool() {},
  } as unknown as ExtensionAPI;
  Object.assign(process.env, {
    LTCOOK_NATIVE_AGENT_ID: 'native',
    LTCOOK_SESSION_ID: 'session',
    LTCOOK_TEAM_INSTANCE_ID: 'team-instance',
    LTCOOK_TEAM_ID: bugHunterTeamId,
    LTCOOK_MEMBER_KEY: 'leader',
    LTCOOK_RUNTIME_API_URL: 'http://127.0.0.1:1',
    LTCOOK_AGENT_API_TOKEN: 'fixture',
    LTCOOK_TEAM: bugHunterTeamId,
  });
  await activate(pi);
  const sanitize = handlers.get('tool_result');
  expect(
    sanitize?.({
      toolName: 'read',
      content: [
        { type: 'text', text: 'password=seeded-private-password\nexport const status = 200;' },
        { type: 'image', data: 'seeded-private-image', mimeType: 'image/png' },
      ],
      details: { private: 'seeded-private-details' },
    }),
  ).toEqual({
    content: [{ type: 'text', text: 'password=<redacted>\nexport const status = 200;' }],
    details: null,
  });
  expect(
    sanitize?.({
      toolName: 'read',
      content: [{ type: 'image', data: 'seeded-private-image', mimeType: 'image/png' }],
    }),
  ).toMatchObject({ isError: true });
  expect(sanitize?.({ toolName: 'ltcook_team' })).toBeUndefined();
});

test('evaluation stream guard rejects wrong model/provider/endpoint before SDK provider invocation', () => {
  let providerInvocations = 0;
  const invokeProvider = () => {
    providerInvocations++;
    throw new Error('provider invoked');
  };
  const runtime: Pick<ModelRuntime, 'stream' | 'streamSimple'> = {
    stream: invokeProvider,
    streamSimple: invokeProvider,
  };
  const endpoint = 'http://127.0.0.1:11434';
  const model: Model<'openai-completions'> = {
    id: EVAL_MODEL,
    name: 'Evaluation fixture',
    api: 'openai-completions',
    provider: 'ollama',
    baseUrl: `${endpoint}/v1`,
    input: ['text'],
    reasoning: false,
    contextWindow: EVAL_CONTEXT_WINDOW,
    maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const context = { messages: [] };
  expect(() => guardEvaluationModelRuntime(runtime, undefined)).toThrow('endpoint is missing');
  guardEvaluationModelRuntime(runtime, endpoint);
  for (const mismatch of [
    { id: 'another-model' },
    { provider: 'another-provider' },
    { baseUrl: 'http://127.0.0.1:1/v1' },
  ]) {
    const selected = { ...model, ...mismatch };
    expect(() => runtime.stream(selected, context)).toThrow('Evaluation model pin violation');
    expect(() => runtime.streamSimple(selected, context)).toThrow('Evaluation model pin violation');
    expect(() =>
      ModelRuntime.prototype.complete.call(runtime as ModelRuntime, selected, context),
    ).toThrow('Evaluation model pin violation');
    expect(() =>
      ModelRuntime.prototype.completeSimple.call(runtime as ModelRuntime, selected, context),
    ).toThrow('Evaluation model pin violation');
  }
  expect(providerInvocations).toBe(0);
  expect(() => runtime.stream(model, context)).toThrow('provider invoked');
  expect(() => runtime.streamSimple(model, context)).toThrow('provider invoked');
  expect(() =>
    ModelRuntime.prototype.completeSimple.call(runtime as ModelRuntime, model, context),
  ).toThrow('provider invoked');
  expect(providerInvocations).toBe(3);
});
test('every native call requires runtime authorization and runtime failures block calls', async () => {
  const requests: string[] = [];
  const paths: unknown[] = [];
  let allowed = false;
  let failure = false;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as { toolName: string; input?: { path?: unknown } };
      paths.push(body.input?.path);
      requests.push(body.toolName);
      return failure
        ? new Response('Unavailable', { status: 503 })
        : Response.json({ allowed, reason: 'Planning approval required' });
    },
  });
  try {
    Object.assign(process.env, {
      LTCOOK_NATIVE_AGENT_ID: 'native',
      LTCOOK_SESSION_ID: 'session',
      LTCOOK_TEAM_INSTANCE_ID: 'team-instance',
      LTCOOK_TEAM_ID: '@ltcook/team-default-minimal',
      LTCOOK_MEMBER_KEY: 'leader',
      LTCOOK_RUNTIME_API_URL: `http://127.0.0.1:${server.port}`,
      LTCOOK_AGENT_API_TOKEN: 'fixture',
      LTCOOK_TEAM: 'default-minimal',
      LTCOOK_BROWSER_ENABLED: 'false',
    });
    let guard!: (
      event: {
        toolName: string;
        input: Record<string, unknown>;
      },
      ctx?: { cwd: string },
    ) => Promise<{ block: boolean; reason: string } | undefined>;
    const registeredTools = new Map<string, Parameters<ExtensionAPI['registerTool']>[0]>();
    const pi = {
      on(name: string, handler: unknown) {
        if (name === 'tool_call') guard = handler as typeof guard;
      },
      registerTool(tool: Parameters<ExtensionAPI['registerTool']>[0]) {
        registeredTools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI;
    await activate(pi);
    const registered = registeredTools.get('ltcook_team');
    if (!registered) throw new Error('Coordination tool was not registered');
    expect(registeredTools.has('ltcook_ried')).toBe(true);
    expect(
      Value.Check(registered.parameters, {
        command: {
          type: 'decision.answer',
          planId: 'Plan',
          decisionId: 'decision',
          answer: 'Forged',
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(registered.parameters, { command: { type: 'planning.approve', planId: 'Plan' } }),
    ).toBe(false);
    expect(
      Value.Check(registered.parameters, {
        command: {
          type: 'decision.create',
          planId: 'Plan',
          category: 'intent',
          prompt: 'Which result?',
          blocking: true,
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(registered.parameters, {
        command: {
          type: 'planning.submit',
          planId: 'Plan',
          assignmentId: 'assignment',
          summary: 'Ready',
          evidence: 'Document exists',
        },
      }),
    ).toBe(true);
    expect((await guard({ toolName: 'write', input: { path: '/project/file' } }))?.block).toBe(
      true,
    );
    allowed = true;
    expect(
      await guard({ toolName: 'write', input: { path: '/documents/plans/Plan.md' } }),
    ).toBeUndefined();
    expect(
      await guard(
        { toolName: 'write', input: { path: '../plans/Plan.md' } },
        { cwd: '/different/project' },
      ),
    ).toBeUndefined();
    expect(paths.at(-1)).toBe('/different/plans/Plan.md');
    failure = true;
    expect((await guard({ toolName: 'bash', input: { command: 'anything' } }))?.block).toBe(true);
    expect((await guard({ toolName: 'ltcook_worktree', input: {} }))?.block).toBe(true);
    expect(requests).toEqual(['write', 'write', 'write', 'bash', 'ltcook_worktree']);
    server.stop(true);
    expect((await guard({ toolName: 'read', input: { path: '/project/file' } }))?.block).toBe(true);
  } finally {
    server.stop(true);
  }
});

test.each(['explorer', 'explorer-tmp'])(
  'managed Pi lets %s use Session Memory when the runtime authorizes it',
  async (memberKey) => {
    let precheckAllowed = false;
    let invocationAllowed = false;
    const calls: { path: string; toolName: string }[] = [];
    const reason = 'Session native bindings have not been reconciled';
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { toolName: string };
        const path = new URL(request.url).pathname;
        calls.push({ path, toolName: body.toolName });
        if (path === '/v1/tool/authorize')
          return Response.json({ allowed: precheckAllowed, reason });
        return invocationAllowed
          ? Response.json({ matches: [] })
          : Response.json({ error: reason }, { status: 403 });
      },
    });
    try {
      Object.assign(process.env, {
        LTCOOK_NATIVE_AGENT_ID: 'native',
        LTCOOK_SESSION_ID: 'session',
        LTCOOK_TEAM_INSTANCE_ID: 'team-instance',
        LTCOOK_TEAM_ID: '@ltcook/team-default',
        LTCOOK_MEMBER_KEY: memberKey,
        LTCOOK_RUNTIME_API_URL: `http://127.0.0.1:${server.port}`,
        LTCOOK_AGENT_API_TOKEN: 'fixture',
        LTCOOK_TEAM: 'default',
        LTCOOK_BROWSER_ENABLED: 'false',
      });
      delete process.env.LTCOOK_EVAL_ARM;
      let guard!: (event: {
        toolName: string;
        input: Record<string, unknown>;
      }) => Promise<{ block: boolean; reason: string } | undefined>;
      const tools = new Map<string, Parameters<ExtensionAPI['registerTool']>[0]>();
      const pi = {
        on(name: string, handler: unknown) {
          if (name === 'tool_call') guard = handler as typeof guard;
        },
        registerTool(tool: Parameters<ExtensionAPI['registerTool']>[0]) {
          tools.set(tool.name, tool);
        },
      } as unknown as ExtensionAPI;
      await activate(pi);

      const tool = tools.get('session-memory');
      if (!tool) throw new Error('Session Memory was not registered');
      const input = { query: 'prior decisions' };
      expect(await guard({ toolName: tool.name, input })).toEqual({ block: true, reason });
      expect((await guard({ toolName: 'write', input: { path: 'project.ts' } }))?.block).toBe(true);
      expect(calls).toEqual([{ path: '/v1/tool/authorize', toolName: 'session-memory' }]);

      precheckAllowed = true;
      expect(await guard({ toolName: tool.name, input })).toBeUndefined();
      const execute = () => tool.execute('memory-1', input, undefined, undefined, {} as never);
      await expect(execute()).rejects.toThrow(reason);
      invocationAllowed = true;
      expect((await execute()).details).toEqual({ matches: [] });
      expect(calls).toEqual([
        { path: '/v1/tool/authorize', toolName: 'session-memory' },
        { path: '/v1/tool/authorize', toolName: 'session-memory' },
        { path: '/v1/workspace-tool', toolName: 'session-memory' },
        { path: '/v1/workspace-tool', toolName: 'session-memory' },
      ]);
    } finally {
      server.stop(true);
    }
  },
);

test('managed Pi exposes search sources and response IDs in its model-facing tool content', async () => {
  const search = {
    content: 'Search result',
    responseId: 'search-result',
    fetchId: 'fetched-sources',
    queries: [
      {
        query: 'release evidence',
        sources: [{ title: 'Release notes', url: 'https://example.org/release', snippet: 'Notes' }],
      },
      { query: 'startup logs', error: 'Search service unavailable' },
    ],
  };
  const server = Bun.serve({ port: 0, fetch: () => Response.json(search) });
  try {
    Object.assign(process.env, {
      LTCOOK_NATIVE_AGENT_ID: 'native',
      LTCOOK_SESSION_ID: 'session',
      LTCOOK_TEAM_INSTANCE_ID: 'team-instance',
      LTCOOK_TEAM_ID: '@ltcook/team-default-minimal',
      LTCOOK_MEMBER_KEY: 'leader',
      LTCOOK_RUNTIME_API_URL: `http://127.0.0.1:${server.port}`,
      LTCOOK_AGENT_API_TOKEN: 'fixture',
      LTCOOK_TEAM: 'default-minimal',
      LTCOOK_BROWSER_ENABLED: 'false',
    });
    const tools = new Map<string, Parameters<ExtensionAPI['registerTool']>[0]>();
    await activate({
      on() {},
      registerTool(tool: Parameters<ExtensionAPI['registerTool']>[0]) {
        tools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI);
    const tool = tools.get('ltcook_web_search');
    if (!tool) throw new Error('Web search tool was not registered');
    const result = await tool.execute(
      'search-1',
      { queries: ['release evidence', 'startup logs'], includeContent: true },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(search) }]);
    expect(result.details).toEqual(search);
  } finally {
    server.stop(true);
  }
});

test('managed RPC rejects flags which would remove required guidance or guards', async () => {
  const { createPiRpcRuntime } = await import('../../../runtime/src/integrations/pi-rpc.js');
  process.env.LTCOOK_NATIVE_AGENT_ID = 'managed-fixture';
  for (const flag of ['--no-extensions', '--no-skills', '--no-context-files']) {
    await expect(createPiRpcRuntime(['--mode', 'rpc', flag])).rejects.toThrow(
      'Managed LTCook sessions require',
    );
  }
});

test('evaluation standing context requires matching authenticated runtime scope and preserves full guidance', async () => {
  const observed: Array<Record<string, unknown>> = [];
  let confirmation: unknown = { evaluationScope: { sessionId: 'session', passId: 'runtime-pass' } };
  let status = 200;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer fixture-agent-token');
      const body = (await request.json()) as Record<string, unknown>;
      if (new URL(request.url).pathname === '/v1/command') return Response.json({});
      observed.push(body);
      return body.kind === 'scope.request'
        ? Response.json(confirmation, { status })
        : Response.json({});
    },
  });
  try {
    Object.assign(process.env, {
      LTCOOK_NATIVE_AGENT_ID: 'native',
      LTCOOK_SESSION_ID: 'session',
      LTCOOK_TEAM_INSTANCE_ID: 'team-instance',
      LTCOOK_TEAM_ID: '@ltcook/team-default-minimal',
      LTCOOK_MEMBER_KEY: 'leader',
      LTCOOK_RUNTIME_API_URL: `http://127.0.0.1:${server.port}`,
      LTCOOK_AGENT_API_TOKEN: 'fixture-agent-token',
      LTCOOK_TEAM: 'default-minimal',
      LTCOOK_BROWSER_ENABLED: 'false',
    });
    const originalPrompt = 'Full Core, Team, User and Project standing guidance.';
    for (const evaluation of [false, true]) {
      if (evaluation) process.env.LTCOOK_EVAL_ARM = 'complete';
      else delete process.env.LTCOOK_EVAL_ARM;
      const handlers = new Map<string, (event: unknown, context?: unknown) => Promise<unknown>>();
      await activate(
        {
          on(name: string, handler: unknown) {
            handlers.set(name, handler as (event: unknown, context?: unknown) => Promise<unknown>);
          },
          registerTool() {},
        } as unknown as ExtensionAPI,
        () => ({ resources: [], diagnostics: [] }),
      );
      const result = await handlers.get('before_agent_start')!({ systemPrompt: originalPrompt });
      if (!evaluation) {
        expect(result).toBeUndefined();
        expect(observed).toEqual([]);
        continue;
      }
      const prompt = (result as { systemPrompt: string }).systemPrompt;
      expect(prompt).toBe(
        `${originalPrompt}\n\n${EVALUATION_EXECUTION_CONTEXT}\nSession: session. Pass: runtime-pass.`,
      );
      expect(observed[0]).toMatchObject({
        kind: 'scope.request',
        sessionId: 'session',
        nativeAgentId: 'native',
      });
      expect(observed[0]).not.toHaveProperty('passId');
      await handlers.get('agent_start')!({}, { getSystemPrompt: () => prompt });
      expect(observed.find((item) => item.kind === 'prompt')?.prompt).toBe(prompt);
      for (const invalid of [
        {},
        { evaluationScope: { sessionId: 'another-session', passId: 'runtime-pass' } },
        { evaluationScope: { sessionId: 'session', passId: '' } },
        { error: 'private response body' },
      ]) {
        confirmation = invalid;
        status = 'error' in invalid ? 403 : 200;
        await expect(
          handlers.get('before_agent_start')!({ systemPrompt: originalPrompt }),
        ).rejects.toThrow('Authenticated evaluation execution scope confirmation failed');
        expect(observed.at(-1)).toMatchObject({
          kind: 'runtime.error',
          operation: 'evaluation.scope',
          error: 'Authenticated evaluation execution scope confirmation failed',
        });
        expect(JSON.stringify(observed.at(-1))).not.toContain('private response body');
      }
    }
  } finally {
    server.stop(true);
  }
});

test('failed managed activation publishes a source diagnostic after binding retry and still exits failed', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = mkdtempSync(path.join(tmpdir(), 'ltcook-native-failure-'));
  const publications: Array<{
    sessionId: string;
    nativeAgentId: string;
    command: {
      type: string;
      inspection: { resources: unknown[]; diagnostics: Array<{ source: string; reason: string }> };
    };
  }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer fixture-agent-token');
      publications.push((await request.json()) as (typeof publications)[number]);
      return new Response('{}', { status: publications.length === 1 ? 403 : 200 });
    },
  });
  try {
    mkdirSync(path.join(root, 'runtime/resources'), { recursive: true });
    writeFileSync(
      path.join(root, 'runtime/resources/catalog.json'),
      JSON.stringify([{ path: 'rules/missing.md', kind: 'rule', required: true }]),
    );
    const child = spawn(
      process.execPath,
      [
        path.resolve(import.meta.dir, '../../../runtime/src/integrations/pi-rpc.ts'),
        '--mode',
        'rpc',
        '--offline',
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          LTCOOK_PI_AUTH_DIR: path.join(root, 'auth'),
          PI_CODING_AGENT_DIR: path.join(root, 'agent'),
          PI_CODING_AGENT_SESSION_DIR: path.join(root, 'sessions'),
          LTCOOK_JS_ROOT: root,
          LTCOOK_GUIDANCE_DIR: path.join(root, 'user'),
          LTCOOK_NATIVE_AGENT_ID: 'native-failure',
          LTCOOK_SESSION_ID: 'session-failure',
          LTCOOK_MEMBER_KEY: 'leader',
          LTCOOK_TEAM: 'default-minimal',
          LTCOOK_RUNTIME_API_URL: `http://127.0.0.1:${server.port}`,
          LTCOOK_AGENT_API_TOKEN: 'fixture-agent-token',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), 10000);
    let status: number | null;
    try {
      status = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    expect(status).toBe(1);
    expect(publications).toHaveLength(2);
    expect(publications[1]?.sessionId).toBe('session-failure');
    expect(publications[1]?.nativeAgentId).toBe('native-failure');
    expect(publications[1]?.command.type).toBe('guidance.loaded');
    expect(publications[1]?.command.inspection.resources).toEqual([]);
    expect(publications[1]?.command.inspection.diagnostics[0]?.reason).toContain(
      path.join(root, 'runtime/resources/rules/missing.md'),
    );
    expect(stderr).toContain('Required guidance is missing');
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

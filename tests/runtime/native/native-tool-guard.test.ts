import { Value } from 'typebox/value';
import { afterEach, expect, test } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import activate from '../../../runtime/src/integrations/pi-extension.js';
const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});
test('every native call requires runtime authorization and runtime failures block calls', async () => {
  const requests: string[] = [];
  let allowed = false;
  let failure = false;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as { toolName: string };
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
      LTCOOK_MEMBER_KEY: 'main',
      LTCOOK_RUNTIME_API_URL: `http://127.0.0.1:${server.port}`,
      LTCOOK_AGENT_API_TOKEN: 'fixture',
      LTCOOK_TEAM: 'default-minimal',
      LTCOOK_BROWSER_ENABLED: 'false',
    });
    let guard!: (event: {
      toolName: string;
      input: Record<string, unknown>;
    }) => Promise<{ block: boolean; reason: string } | undefined>;
    let registered: Parameters<ExtensionAPI['registerTool']>[0] | undefined;
    const pi = {
      on(name: string, handler: unknown) {
        if (name === 'tool_call') guard = handler as typeof guard;
      },
      registerTool(tool: Parameters<ExtensionAPI['registerTool']>[0]) {
        registered = tool;
      },
    } as unknown as ExtensionAPI;
    await activate(pi);
    if (!registered) throw new Error('Coordination tool was not registered');
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
    failure = true;
    expect((await guard({ toolName: 'bash', input: { command: 'anything' } }))?.block).toBe(true);
    expect(requests).toEqual(['write', 'write', 'bash']);
    server.stop(true);
    expect((await guard({ toolName: 'read', input: { path: '/project/file' } }))?.block).toBe(true);
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
          LTCOOK_JS_ROOT: root,
          LTCOOK_GUIDANCE_DIR: path.join(root, 'user'),
          LTCOOK_NATIVE_AGENT_ID: 'native-failure',
          LTCOOK_SESSION_ID: 'session-failure',
          LTCOOK_MEMBER_KEY: 'main',
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

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
    const pi = {
      on(name: string, handler: unknown) {
        if (name === 'tool_call') guard = handler as typeof guard;
      },
      registerTool() {},
    } as unknown as ExtensionAPI;
    await activate(pi);
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

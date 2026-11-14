import { parseArgs } from '@earendil-works/pi-coding-agent';
import { buildPiLaunch } from '../../../node_modules/@getpaseo/server/dist/server/server/agent/providers/pi/runtime.js';
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { once } from 'node:events';
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface RpcResponse {
  id?: string;
  success?: boolean;
  data?: {
    thinkingLevel?: string;
    sessionId?: string;
    models?: Array<{ provider: string; id: string }>;
    commands?: Array<{ name: string }>;
  };
}

async function startRpc(input: {
  cwd: string;
  agentDir: string;
  authDir: string;
  argv: string[];
}): Promise<RpcResponse[]> {
  const launcher = resolve(import.meta.dir, '../../../runtime/src/integrations/pi-rpc.ts');
  const child = spawn(process.execPath, [launcher, ...input.argv], {
    cwd: input.cwd,
    env: {
      ...process.env,
      HOME: input.authDir,
      LTCOOK_PI_AUTH_DIR: input.authDir,
      PI_CODING_AGENT_DIR: input.agentDir,
      PI_OFFLINE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output: RpcResponse[] = [];
  let stdout = '';
  let stderr = '';
  const { promise, resolve: finish, reject } = Promise.withResolvers<void>();
  const expected = new Set([
    'state',
    'commands',
    'models',
    'model',
    'thinking',
    'abort',
    'new',
    'state-after-new',
  ]);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split('\n');
    stdout = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const response = JSON.parse(line) as RpcResponse;
      output.push(response);
      if (!response.id || !expected.delete(response.id)) continue;
      if (response.id === 'state') {
        child.stdin.write(`${JSON.stringify({ type: 'get_commands', id: 'commands' })}\n`);
      } else if (response.id === 'commands') {
        if (
          !response.data?.commands?.some(
            (command) => command.name === `${basename(input.cwd)}-command`,
          )
        ) {
          reject(new Error('Workspace extension was not loaded from its project path.'));
          child.kill();
          return;
        }
        child.stdin.write(`${JSON.stringify({ type: 'get_available_models', id: 'models' })}\n`);
      } else if (response.id === 'models') {
        const model = response.data?.models?.find((entry) => entry.provider === 'local');
        if (!model) {
          reject(new Error('Workspace model was not loaded from its project agent directory.'));
          child.kill();
          return;
        }
        child.stdin.write(
          `${JSON.stringify({ type: 'set_model', provider: model.provider, modelId: model.id, id: 'model' })}\n`,
        );
      } else if (response.id === 'model') {
        child.stdin.write(
          `${JSON.stringify({ type: 'set_thinking_level', level: 'minimal', id: 'thinking' })}\n`,
        );
      } else if (response.id === 'thinking') {
        child.stdin.write(`${JSON.stringify({ type: 'abort', id: 'abort' })}\n`);
      } else if (response.id === 'abort') {
        child.stdin.write(`${JSON.stringify({ type: 'new_session', id: 'new' })}\n`);
      } else if (response.id === 'new') {
        child.stdin.write(`${JSON.stringify({ type: 'get_state', id: 'state-after-new' })}\n`);
      } else {
        child.stdin.end();
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  child.stdin.write(`${JSON.stringify({ type: 'get_state', id: 'state' })}\n`);
  child.once('error', reject);
  child.on('exit', (code) => {
    if (code === 0) finish();
    else reject(new Error(`Pi RPC exited with ${code}: ${stderr}`));
  });
  const deadline = setTimeout(() => {
    reject(new Error('Timed out waiting for the Pi RPC lifecycle responses.'));
    child.kill('SIGKILL');
  }, 30_000);
  try {
    await promise;
    if (stdout.trim()) output.push(JSON.parse(stdout.trim()) as RpcResponse);
    return output;
  } finally {
    clearTimeout(deadline);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
}
test('parses the pinned Paseo Pi 0.15.4 launch argument forms', () => {
  const session = {
    cwd: '/workspace',
    model: 'local/workspace-model',
    thinkingOptionId: 'high',
    noSession: true,
    mcpConfigPath: '/tmp/paseo-mcp.json',
    extensionPaths: ['/tmp/paseo-extension.mjs'],
    extraArgs: ['--offline'],
  };
  const launch = buildPiLaunch({ command: ['ltcook-pi'], session });
  expect(launch.argv).toEqual([
    'ltcook-pi',
    '--mode',
    'rpc',
    '--offline',
    '--model',
    'local/workspace-model',
    '--thinking',
    'high',
    '--no-session',
    '--mcp-config',
    '/tmp/paseo-mcp.json',
    '--extension',
    '/tmp/paseo-extension.mjs',
  ]);
  const parsed = parseArgs(launch.argv.slice(1));
  expect(parsed.mode).toBe('rpc');
  expect(parsed.model).toBe('local/workspace-model');
  expect(parsed.thinking).toBe('high');
  expect(parsed.noSession).toBe(true);
  expect(parsed.extensions).toEqual(['/tmp/paseo-extension.mjs']);
  expect(parsed.unknownFlags.get('mcp-config')).toBe('/tmp/paseo-mcp.json');
  const resumed = buildPiLaunch({
    command: ['ltcook-pi'],
    session: { cwd: '/workspace', session: '/workspace/.pi/session.jsonl' },
  });
  expect(resumed.argv).toEqual([
    'ltcook-pi',
    '--mode',
    'rpc',
    '--session',
    '/workspace/.pi/session.jsonl',
  ]);
});
test('runs the compiled Pi entry through its npm-style symlink with Node', () => {
  if (process.platform === 'win32') return;
  const node = process.env.LTCOOK_NODE_EXECUTABLE ?? Bun.which('node');
  expect(node, 'Node must be available to verify the installed launcher entry.').toBeTruthy();
  const root = mkdtempSync(join(tmpdir(), 'ltcook-pi-entry-'));
  directories.push(root);
  const appRoot = join(root, 'app');
  const outputDirectory = join(appRoot, 'dist');
  const nodeModules = join(appRoot, 'node_modules');
  const binDirectory = join(nodeModules, '.bin');
  const authDir = join(root, 'native-auth');
  const agentDir = join(root, 'pi-agent');
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(authDir);
  mkdirSync(agentDir);
  const entrypoint = resolve(import.meta.dir, '../../../runtime/src/integrations/pi-rpc.ts');
  const build = Bun.build({
    entrypoints: [entrypoint],
    outdir: outputDirectory,
    target: 'node',
    format: 'esm',
    packages: 'external',
    naming: 'ltcook-pi.mjs',
  });
  return build.then((buildResult) => {
    expect(buildResult.success, buildResult.logs.map((log) => log.message).join('\n')).toBe(true);
    const launcher = join(outputDirectory, 'ltcook-pi.mjs');
    symlinkSync(
      resolve(import.meta.dir, '../../../node_modules/@earendil-works'),
      join(nodeModules, '@earendil-works'),
      'dir',
    );
    symlinkSync(launcher, join(binDirectory, 'ltcook-pi'));
    const result = spawnSync(node!, [join(binDirectory, 'ltcook-pi'), '--version'], {
      cwd: appRoot,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: authDir,
        LTCOOK_PI_AUTH_DIR: authDir,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: '1',
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1.5.2');
  });
});

describe('shared-auth Pi RPC launcher', () => {
  test('runs Pi 1.5.2 RPC with shared auth and isolated project settings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ltcook-pi-rpc-'));
    directories.push(root);
    const authDir = join(root, 'native-auth');
    mkdirSync(authDir);
    writeFileSync(
      join(authDir, 'auth.json'),
      JSON.stringify({ local: { type: 'api_key', key: 'shared-fixture-key' } }),
    );
    const projects = ['first', 'second'].map((name, index) => {
      const cwd = join(root, name);
      const agentDir = join(cwd, 'pi-agent');
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(join(cwd, '.pi'), { recursive: true });
      writeFileSync(
        join(agentDir, 'auth.json'),
        JSON.stringify(index ? { other: { type: 'api_key', key: 'project-only-key' } } : {}),
      );
      new ProjectTrustStore(agentDir).set(cwd, true);
      writeFileSync(
        join(agentDir, 'models.json'),
        JSON.stringify({
          providers: {
            local: {
              baseUrl: `http://127.0.0.1:${index + 1}`,
              api: 'openai-completions',
              models: [
                {
                  id: `workspace-model-${index + 1}`,
                  name: `Workspace model ${index + 1}`,
                  reasoning: true,
                  contextWindow: 8192,
                },
              ],
            },
          },
        }),
      );
      writeFileSync(
        join(cwd, '.pi', 'settings.json'),
        JSON.stringify({ defaultThinkingLevel: index ? 'high' : 'low' }),
      );
      const mcpConfigPath = join(root, `${name}-mcp.json`);
      const extensionPath = join(root, `${name}-paseo-extension.mjs`);
      writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
      writeFileSync(
        extensionPath,
        `export default function extension(pi) { console.log('${name} extension starting'); pi.registerCommand('${name}-command', { handler: async () => {} }); }\n`,
      );
      const launch = buildPiLaunch({
        command: ['ltcook-pi'],
        session: {
          cwd,
          model: `local/workspace-model-${index + 1}`,
          noSession: true,
          mcpConfigPath,
          extensionPaths: [extensionPath],
        },
      });
      return { cwd, agentDir, argv: launch.argv.slice(1) };
    });
    const results = await Promise.all(
      projects.map(({ cwd, agentDir, argv }) => startRpc({ cwd, agentDir, authDir, argv })),
    );
    const states = results.map((responses) =>
      responses.find((response) => response.id === 'state'),
    );
    const modelLists = results.map((responses) =>
      responses.find((response) => response.id === 'models'),
    );
    expect(states.every((response) => response?.success)).toBe(true);
    expect(states.map((response) => response?.data?.thinkingLevel)).toEqual(['low', 'high']);
    expect(
      modelLists.map((response, index) =>
        response?.data?.models?.some(
          (model) => model.provider === 'local' && model.id === `workspace-model-${index + 1}`,
        ),
      ),
    ).toEqual([true, true]);
    for (const responses of results) {
      expect(responses.find((response) => response.id === 'models')?.success).toBe(true);
      expect(responses.find((response) => response.id === 'model')?.success).toBe(true);
      expect(responses.find((response) => response.id === 'thinking')?.success).toBe(true);
      expect(responses.find((response) => response.id === 'abort')?.success).toBe(true);
      expect(responses.find((response) => response.id === 'new')?.success).toBe(true);
      expect(responses.find((response) => response.id === 'state-after-new')?.success).toBe(true);
      expect(responses.find((response) => response.id === 'state')?.data?.sessionId).not.toBe(
        responses.find((response) => response.id === 'state-after-new')?.data?.sessionId,
      );
    }
    expect(projects.map(({ agentDir }) => join(agentDir, 'models.json'))).toEqual([
      join(root, 'first/pi-agent/models.json'),
      join(root, 'second/pi-agent/models.json'),
    ]);
  });
});

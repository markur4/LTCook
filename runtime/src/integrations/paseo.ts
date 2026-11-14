import { createHostClient } from '@getpaseo/client/node';
import { createPaseoApi, type PaseoApi } from '@getpaseo/client';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentBackend, CreateAgentOptions, NativeAgent } from '../workflow-api/index.js';
import { agentEnvironment } from './native-policy.js';
import { configurePiExtensions } from './pi-settings.js';
export interface PaseoHost {
  api: PaseoApi;
  listen: string;
  logPath: string;
  close(): Promise<void>;
}
export interface AgentRpcIdentity {
  agentId: string;
  token: string;
}

async function resolvedPath(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(root: string, candidate: string, allowEqual = false): boolean {
  const relative = path.relative(root, candidate);
  return (
    (allowEqual || relative !== '') &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function piPackageExtensions(appNodeModules: string, packageName: string): Promise<string[]> {
  const packageDirectory = path.join(appNodeModules, ...packageName.split('/'));
  const manifestPath = await realpath(path.join(packageDirectory, 'package.json'));
  const packageRoot = path.dirname(manifestPath);
  const appRoot = path.dirname(await realpath(appNodeModules));
  if (!isWithin(appRoot, packageRoot)) {
    throw new Error(`Installed Pi package ${packageName} is outside the LTCook app.`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    name?: unknown;
    pi?: { extensions?: unknown };
  };
  if (manifest.name !== packageName) {
    throw new Error(`Installed Pi package metadata does not match ${packageName}.`);
  }
  const declarations = manifest.pi?.extensions;
  if (
    !Array.isArray(declarations) ||
    declarations.length === 0 ||
    !declarations.every((item): item is string => typeof item === 'string' && item.length > 0)
  ) {
    throw new Error(`Installed Pi package ${packageName} does not declare Pi extensions.`);
  }
  const extensions = await Promise.all(
    declarations.map(async (item) => {
      const extension = await realpath(path.resolve(packageRoot, item));
      if (!isWithin(packageRoot, extension, true)) {
        throw new Error(`Pi extension declared by ${packageName} is outside its package.`);
      }
      return extension;
    }),
  );
  return extensions;
}
/** Start Paseo's supported supervisor and connect with its native host client. */
export async function startPaseoHost(input: {
  node: string;
  home: string;
  deploymentRoot: string;
  listen: string;
  password?: string;
  runtimeApiUrl: string;
  userToken: string;
  pluginDirectory: string;
}): Promise<PaseoHost> {
  const deploymentRoot = await realpath(input.deploymentRoot);
  const home = await resolvedPath(input.home);
  const appRoot = await resolvedPath(path.join(deploymentRoot, 'app'));
  if (!isWithin(deploymentRoot, home) || isWithin(appRoot, home, true)) {
    throw new Error(
      'PASEO_HOME must resolve inside the LTCook deployment and outside its immutable app directory.',
    );
  }
  const serverEntry = fileURLToPath(import.meta.resolve('@getpaseo/server'));
  const serverRoot = path.resolve(path.dirname(serverEntry), '../../..');
  const supervisor = path.join(serverRoot, 'dist/scripts/supervisor-entrypoint.js');
  const { startDaemonInstance, waitForDaemonReady, stopDaemonInstance, daemonLogPath } =
    await import('@getpaseo/server/daemon-control');
  const { hashDaemonPassword } = await import('@getpaseo/server');
  const appBin = path.join(appRoot, 'node_modules', '.bin');
  const piCommand = path.join(appBin, process.platform === 'win32' ? 'ltcook-pi.cmd' : 'ltcook-pi');
  const pathEntries = [
    ...new Set([path.dirname(input.node), appBin, process.env.PATH].filter(Boolean)),
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: pathEntries.join(path.delimiter),
    PI_COMMAND: piCommand,
    PASEO_HOME: home,
    LTCOOK_RUNTIME_API_URL: input.runtimeApiUrl,
    LTCOOK_RUNTIME_USER_TOKEN: input.userToken,
  };
  delete env.LTCOOK_API_TOKEN;
  delete env.LTCOOK_BACKEND_LOG_PATH;
  delete env.LTCOOK_PASEO_PASSWORD;
  delete env.LTCOOK_SHELL_PROVENANCE;
  delete env.PASEO_DICTATION_ENABLED;
  delete env.PASEO_VOICE_MODE_ENABLED;
  const configuration = {
    daemon: {
      listen: input.listen,
      mcp: { enabled: false, injectIntoAgents: false },
      ...(input.password ? { auth: { password: hashDaemonPassword(input.password) } } : {}),
    },
    agents: {
      providers: {
        pi: { enabled: true, env: { PI_COMMAND: piCommand } },
      },
    },
    features: {
      dictation: { enabled: false },
      voiceMode: { enabled: false },
      webUi: { enabled: true },
    },
    pluginsEnabled: true,
    plugins: { ltcook: { source: 'directory', path: input.pluginDirectory, enabled: true } },
  };
  await mkdir(home, { recursive: true, mode: 0o700 });
  const configFile = path.join(home, 'config.json');
  await writeFile(configFile, JSON.stringify(configuration, null, 2), { mode: 0o600 });
  await chmod(configFile, 0o600);
  const started = await startDaemonInstance({
    home,
    command: input.node,
    args: [supervisor],
    env,
    mode: 'deployment',
  });
  let client: ReturnType<typeof createHostClient> | undefined;
  try {
    const instance = await waitForDaemonReady(home, { instance: started.instance });
    client = createHostClient(instance.listen, {
      clientId: 'ltcook-runtime',
      ...(input.password ? { password: input.password } : {}),
      connectTimeoutMs: 30_000,
      reconnect: { enabled: true },
    });
    await client.connect();
    const connectedClient = client;
    const api = createPaseoApi(connectedClient);
    return {
      api,
      listen: instance.listen,
      logPath: daemonLogPath(home),
      async close() {
        const failures: unknown[] = [];
        for (const cleanup of [
          () => api.dispose(),
          () => connectedClient.close(),
          () =>
            started.spawned
              ? stopDaemonInstance(home, { instance: started.instance })
              : Promise.resolve(),
        ]) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) throw new AggregateError(failures, 'Paseo cleanup failed');
      },
    };
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    if (client) {
      try {
        await client.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (started.spawned) {
      try {
        await stopDaemonInstance(home, { instance: started.instance });
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length) {
      throw new AggregateError([error, ...cleanupFailures], 'Paseo startup and cleanup failed');
    }
    throw error;
  }
}

export async function createPaseoAgentBackend(input: {
  api: PaseoApi;
  python: string;
  runtimeApiUrl: string;
  piHome: string;
  extensionPath: string;
  appNodeModules: string;
  deploymentNode: string;
  browserAvailable: boolean;
  browserExecutable?: string;
  originalShellEnvironment?(
    workspaceRoot: string,
    sessionId: string,
  ): Record<string, string> | undefined;
  identity(agentId: string): AgentRpcIdentity;
}): Promise<AgentBackend> {
  const appRoot = path.dirname(await realpath(input.appNodeModules));
  const extensionPath = await realpath(input.extensionPath);
  if (!isWithin(appRoot, extensionPath)) {
    throw new Error('LTCook Pi extension is outside the installed app.');
  }
  const webAccessExtensions = await piPackageExtensions(input.appNodeModules, 'pi-web-access');
  const codeSearchExtensions = await piPackageExtensions(
    input.appNodeModules,
    '@nicknisi/pi-codesearch',
  );
  const state = (agent: { id: string; status: string | null }): NativeAgent => ({
    id: agent.id,
    status: agent.status ?? 'unknown',
  });
  const helperEnvironment = (workspaceRoot: string, sessionId: string): NodeJS.ProcessEnv => {
    const shell = input.originalShellEnvironment?.(path.resolve(workspaceRoot), sessionId);
    return shell ? { ...process.env, LTCOOK_SHELL_PROVENANCE: JSON.stringify(shell) } : process.env;
  };
  const resolveWorkspaceEnvironment = (
    workspaceRoot: string,
    sessionId: string,
  ): Record<string, string> => {
    const result = spawnSync(
      input.python,
      ['-m', 'ltcook.launch', 'environment', '--workspace', workspaceRoot],
      { encoding: 'utf8', env: helperEnvironment(workspaceRoot, sessionId), windowsHide: true },
    );
    if (result.status !== 0)
      throw new Error('AppRC could not resolve the selected workspace environment');
    const response = JSON.parse(result.stdout) as {
      workspaceRoot: string;
      environment: Record<string, string>;
    };
    if (path.resolve(response.workspaceRoot) !== path.resolve(workspaceRoot))
      throw new Error('AppRC resolved a different native-agent workspace');
    return response.environment;
  };
  return {
    async list() {
      const result = await input.api.agents.list();
      return result.entries.map((entry) => state(entry.agent));
    },
    async create(options: CreateAgentOptions) {
      const workspaceEnv = resolveWorkspaceEnvironment(options.workspaceRoot, options.sessionId);
      const nativeAgentId = randomUUID();
      const identity = input.identity(nativeAgentId);
      const configResult = spawnSync(
        input.python,
        ['-m', 'ltcook.launch', 'write-native-config', '--workspace', options.workspaceRoot],
        {
          encoding: 'utf8',
          env: helperEnvironment(options.workspaceRoot, options.sessionId),
          windowsHide: true,
        },
      );
      if (configResult.status !== 0)
        throw new Error('AppRC could not write LTCook-owned native configuration');
      const agentHome = workspaceEnv.PI_CODING_AGENT_DIR || input.piHome;
      await mkdir(agentHome, { recursive: true, mode: 0o700 });
      const settingsPath = path.join(agentHome, 'settings.json');
      const browserEnabled =
        input.browserAvailable && workspaceEnv.LTCOOK_BROWSER_ENABLED !== 'false';
      const codeSearchEnabled = workspaceEnv.LTCOOK_CODESEARCH_ENABLED === 'true';
      const ownedExtensions = [
        extensionPath,
        ...webAccessExtensions,
        ...(codeSearchEnabled ? codeSearchExtensions : []),
      ];
      const legacyExtensions = [extensionPath, ...webAccessExtensions, ...codeSearchExtensions];
      await configurePiExtensions(settingsPath, ownedExtensions, legacyExtensions);
      const model =
        workspaceEnv[`LTCOOK_MODEL_${options.member.modelAlias.toUpperCase()}`] ||
        workspaceEnv.LTCOOK_MODEL_SMART;
      if (!model) throw new Error(`No model configured for alias ${options.member.modelAlias}`);
      const browserHome =
        workspaceEnv.LTCOOK_BROWSER_HOME || path.join(path.dirname(agentHome), 'browser-home');
      const appBin = path.join(input.appNodeModules, '.bin');
      const pathEntries = [
        ...new Set([path.dirname(input.deploymentNode), appBin, workspaceEnv.PATH].filter(Boolean)),
      ];
      const agentEnv = agentEnvironment({
        ...workspaceEnv,
        PATH: pathEntries.join(path.delimiter),
        LTCOOK_RUNTIME_API_URL: input.runtimeApiUrl,
        LTCOOK_AGENT_API_TOKEN: identity.token,
        LTCOOK_NATIVE_AGENT_ID: nativeAgentId,
        LTCOOK_SESSION: options.sessionId,
        LTCOOK_SESSION_ID: options.sessionId,
        LTCOOK_TEAM_INSTANCE_ID: options.teamInstanceId,
        LTCOOK_TEAM_ID: options.teamId,
        LTCOOK_MEMBER_KEY: options.member.key,
        LTCOOK_READONLY: options.member.readOnly ? '1' : '0',
        LTCOOK_BROWSER_ENABLED: browserEnabled ? 'true' : 'false',
        AGENT_BROWSER_EXECUTABLE_PATH: browserEnabled
          ? input.browserExecutable || workspaceEnv.AGENT_BROWSER_EXECUTABLE_PATH || ''
          : '',
        HOME: browserHome,
        ...(process.platform === 'win32' ? { USERPROFILE: browserHome } : {}),
      });
      const context7Enabled = agentEnv.LTCOOK_CONTEXT7_ENABLED === 'true';
      const context7Url = agentEnv.LTCOOK_CONTEXT7_URL;
      if (context7Enabled && !context7Url) {
        throw new Error('LTCOOK_CONTEXT7_URL must be configured when Context7 is enabled.');
      }
      const mcpServers = context7Enabled
        ? {
            context7: {
              type: 'http' as const,
              url: context7Url,
              ...(agentEnv.CONTEXT7_API_KEY
                ? { headers: { Authorization: `Bearer ${agentEnv.CONTEXT7_API_KEY}` } }
                : {}),
            },
          }
        : undefined;
      const handle = await input.api.agents.create({
        agentId: nativeAgentId,
        idempotencyKey: nativeAgentId,
        cwd: options.workspaceRoot,
        title: options.member.name,
        config: {
          provider: `pi/${model}`,
          thinkingOptionId: options.member.thinking,
          ...(mcpServers ? { mcpServers } : {}),
        },
        env: agentEnv,
        labels: {
          'ltcook.session': options.sessionId,
          'ltcook.team-instance': options.teamInstanceId,
          'ltcook.team': options.teamId,
          'ltcook.member': options.member.key,
        },
      });
      return state(handle);
    },
    async inspect(id: string) {
      const result = await input.api.agents.ref(id).refresh();
      return result ? state(result.agent) : null;
    },
    async send(id: string, message: string) {
      await input.api.agents.ref(id).send(message);
    },
    async close(id: string) {
      await input.api.agents.ref(id).archive();
    },
  };
}

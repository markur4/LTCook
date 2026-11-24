import type { Telemetry } from '../diagnostics/telemetry.js';
import type { PlanningDialogEvent } from './planning-dialogs.js';
import { createHostClient } from '@getpaseo/client/node';
import { createPaseoApi, type PaseoApi } from '@getpaseo/client';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentBackend,
  CreateAgentOptions,
  NativeAgent,
  TeamMember,
} from '../workflow-api/index.js';
import { resolveModel, type ResolvedModel } from '../models/aliases.js';
import { piThinking } from '../models/adapters.js';
import { RESOLVED_MODEL_METADATA_KEY } from '../paseo-plugin/shared/models.js';
import { agentEnvironment } from './native-policy.js';
import { configurePiExtensions } from './pi-settings.js';
import { isWithin } from '../path-containment.js';
import { memoryDispatchId } from './paseo-memory.js';
import { WorkspacePreparationCache } from './workspace-preparation.js';
export interface PaseoHost {
  api: PaseoApi;
  listen: string;
  logPath: string;
  subscribePlanningDialogs(handler: (event: PlanningDialogEvent) => Promise<void>): () => void;
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
  environment?: NodeJS.ProcessEnv;
  piCommand?: string;
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
  const piCommand =
    input.piCommand ??
    path.join(appBin, process.platform === 'win32' ? 'ltcook-pi.cmd' : 'ltcook-pi');
  const pathEntries = [
    ...new Set([path.dirname(input.node), appBin, process.env.PATH].filter(Boolean)),
  ];
  const env: NodeJS.ProcessEnv = {
    ...(input.environment ?? process.env),
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
        ltcook: { enabled: true, extends: 'pi', label: 'LTCook', env: { PI_COMMAND: piCommand } },
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
      subscribePlanningDialogs(handler) {
        const feed = connectedClient.observeEvents([
          'agent_permission_request',
          'agent_permission_resolved',
        ]);
        let sequence = Promise.resolve();
        const unsubscribe = connectedClient.subscribe((event) => {
          if (
            event.type !== 'agent_permission_request' &&
            event.type !== 'agent_permission_resolved'
          )
            return;
          sequence = sequence
            .then(() => handler(event))
            .catch(() => {
              console.error(
                'Native planning dialog could not be correlated; decision remains pending.',
              );
            });
        });
        return () => {
          unsubscribe();
          void feed.release();
        };
      },
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
  memoryProvenanceSecret?: string;
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
  preparedEnvironment?: Record<string, string>;
  thinking?: string;
  telemetry?: Telemetry;
  identity(agentId: string): AgentRpcIdentity;
}): Promise<
  AgentBackend & {
    resolveSelection(
      workspaceRoot: string,
      member: TeamMember,
      alias?: string,
      reasoning?: string,
    ): Promise<ResolvedModel>;
    prepare(
      options: CreateAgentOptions,
      nativeAgentId: string,
      savedModel?: ResolvedModel,
    ): Promise<{
      env: Record<string, string>;
      model: ResolvedModel;
      mcpServers:
        | NonNullable<Parameters<PaseoApi['agents']['create']>[0]['config']['mcpServers']>
        | undefined;
    }>;
  }
> {
  const appRoot = path.dirname(await realpath(input.appNodeModules));
  const extensionPath = await realpath(input.extensionPath);
  if (!isWithin(appRoot, extensionPath)) {
    throw new Error('LTCook Pi extension is outside the installed app.');
  }
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
  const preparations = new WorkspacePreparationCache();
  const environmentFor = async (workspaceRoot: string, sessionId: string) => {
    const helperEnv = helperEnvironment(workspaceRoot, sessionId);
    const shellIdentity = createHash('sha256')
      .update(JSON.stringify(helperEnv.LTCOOK_SHELL_PROVENANCE ?? helperEnv))
      .digest('hex');
    const cacheKey = JSON.stringify([path.resolve(workspaceRoot), sessionId, shellIdentity]);
    return (
      input.preparedEnvironment ??
      (
        await preparations.get(cacheKey, () => {
          const result = spawnSync(
            input.python,
            ['-m', 'ltcook.launch', 'prepare-native', '--workspace', workspaceRoot],
            { encoding: 'utf8', env: helperEnv, windowsHide: true },
          );
          if (result.status !== 0)
            throw new Error('AppRC could not prepare the selected native-agent workspace');
          const response = JSON.parse(result.stdout) as {
            workspaceRoot: string;
            environment: Record<string, string>;
            dependencies: string[];
            identityPaths: string[];
            reusable: boolean;
          };
          if (path.resolve(response.workspaceRoot) !== path.resolve(workspaceRoot))
            throw new Error('AppRC resolved a different native-agent workspace');
          if (
            !Array.isArray(response.dependencies) ||
            !response.dependencies.every((file) => typeof file === 'string') ||
            !Array.isArray(response.identityPaths) ||
            !response.identityPaths.every((file) => typeof file === 'string') ||
            typeof response.reusable !== 'boolean'
          )
            throw new Error('AppRC did not report workspace preparation dependencies');
          return {
            environment: response.environment,
            dependencies: response.dependencies,
            identityPaths: response.identityPaths,
            reusable: response.reusable,
          };
        })
      ).environment
    );
  };
  const prepare = async (
    options: CreateAgentOptions,
    nativeAgentId: string,
    savedModel?: ResolvedModel,
  ) => {
    const workspaceEnv = await environmentFor(options.workspaceRoot, options.sessionId);
    const model =
      savedModel ??
      resolveModel(options.member.modelAlias, workspaceEnv, {
        teamReasoning: options.member.thinking,
        sessionReasoning: input.thinking,
      });
    const identity = input.identity(nativeAgentId);
    const agentHome = workspaceEnv.PI_CODING_AGENT_DIR || input.piHome;
    await mkdir(agentHome, { recursive: true, mode: 0o700 });
    const settingsPath = path.join(agentHome, 'settings.json');
    const browserEnabled =
      input.browserAvailable && workspaceEnv.LTCOOK_BROWSER_ENABLED !== 'false';
    const codeSearchEnabled = workspaceEnv.LTCOOK_CODESEARCH_ENABLED === 'true';
    const ownedExtensions = codeSearchEnabled ? codeSearchExtensions : [];
    await configurePiExtensions(settingsPath, ownedExtensions);
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
      LTCOOK_RESOLVED_MODEL: JSON.stringify(model),
      LTCOOK_SESSION: options.sessionId,
      LTCOOK_SESSION_ID: options.sessionId,
      LTCOOK_TEAM_INSTANCE_ID: options.teamInstanceId,
      LTCOOK_TEAM_ID: options.teamId,
      LTCOOK_TEAM: options.teamId,
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
    return { env: agentEnv, model, mcpServers };
  };
  return {
    prepare,
    async resolveSelection(workspaceRoot, member, alias, reasoning) {
      const environment = await environmentFor(workspaceRoot, '');
      return resolveModel(alias ?? member.modelAlias, environment, {
        teamReasoning: member.thinking,
        sessionReasoning: reasoning,
      });
    },
    async list() {
      const result = await input.api.agents.list();
      return result.entries.map((entry) => state(entry.agent));
    },
    async create(options: CreateAgentOptions) {
      const span = input.telemetry?.begin(
        'member.create',
        undefined,
        `${options.sessionId}:${options.member.key}`,
      );
      try {
        const nativeAgentId = randomUUID();
        const { env: agentEnv, model, mcpServers } = await prepare(options, nativeAgentId);
        const thinkingOptionId = piThinking(model.reasoning);
        const handle = await input.api.agents.create({
          agentId: nativeAgentId,
          idempotencyKey: nativeAgentId,
          cwd: options.workspaceRoot,
          title:
            options.member.key === 'leader'
              ? `${path.basename(options.workspaceRoot)} · ${options.teamId}`
              : options.member.name,
          ...(options.member.key !== 'leader' && options.leaderAgentId
            ? { parent: options.leaderAgentId }
            : {}),
          config: {
            provider: `pi/${model.provider}/${model.model}`,
            ...(thinkingOptionId ? { thinkingOptionId } : {}),
            ...(mcpServers ? { mcpServers } : {}),
          },
          env: agentEnv,
          metadata: { [RESOLVED_MODEL_METADATA_KEY]: model },
          labels: {
            'ltcook.session': options.sessionId,
            'ltcook.team-instance': options.teamInstanceId,
            'ltcook.team': options.teamId,
            'ltcook.member': options.member.key,
          },
        });
        return state(handle);
      } finally {
        span?.end();
      }
    },
    async inspect(id: string) {
      const result = await input.api.agents.ref(id).refresh();
      return result ? state(result.agent) : null;
    },
    async send(id: string, message: string) {
      // > Scheduling may hand work back to an agent inside its current tool turn.
      await input.api.agents.ref(id).send(message, {
        activeTurnBehavior: 'steer',
        ...(input.memoryProvenanceSecret
          ? { messageId: memoryDispatchId(input.memoryProvenanceSecret, id) }
          : {}),
      });
    },
    async close(id: string) {
      await input.api.agents.ref(id).archive();
    },
  };
}

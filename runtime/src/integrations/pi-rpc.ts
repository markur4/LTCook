#!/usr/bin/env node
import { NativeGuidance, NativeGuidanceError, coreGuidanceDirectory } from './native-guidance.js';
import { loadTeam } from './team-loader.js';
import { Console } from 'node:console';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EVAL_MODEL } from '../evals/setup.js';
import { ReasoningEffortSchema } from '@ltcook/model-contracts';
import { ResolvedModelSchema } from '../models/aliases.js';
import { piThinking } from '../models/adapters.js';
import { useCodexOpenAiAuth } from './codex-auth.js';
import { bugHunterTeamId } from '../services/bughunter-team.js';
import { WORKSPACE_MCP_SERVER } from '../paseo-plugin/shared/workspace-tools.js';
import { REPO_SEARCH_TIMEOUT_MS } from '../tools/workspace-tools.js';
import type { ModelsRequestTransforms } from '@earendil-works/pi-ai';
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createMcpExtension,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ModelRuntime,
  parseArgs,
  ProjectTrustStore,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
  runRpcMode,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentSessionRuntime,
  Args,
  CreateAgentSessionRuntimeFactory,
  ExtensionFactory,
} from '@earendil-works/pi-coding-agent';

function absolutePath(value: string, cwd = process.cwd()): string {
  return path.resolve(cwd, value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value);
}
function parseRpcArguments(argv: string[]): { parsed: Args; mcpConfigPaths: string[] } {
  const nativeArgs: string[] = [];
  const mcpConfigPaths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--mcp-config') {
      const configPath = argv[index + 1];
      if (!configPath || configPath.startsWith('-')) {
        throw new Error('--mcp-config requires a file path.');
      }
      mcpConfigPaths.push(configPath);
      index += 1;
    } else if (argument.startsWith('--mcp-config=')) {
      mcpConfigPaths.push(argument.slice('--mcp-config='.length));
    } else {
      nativeArgs.push(argument);
    }
  }
  return { parsed: parseArgs(nativeArgs), mcpConfigPaths };
}

function loadMcpServerConfigs(
  configPaths: string[],
  cwd: string,
): Array<{ name: string; config: unknown }> {
  const servers: Array<{ name: string; config: unknown }> = [];
  for (const configPath of configPaths) {
    const content: unknown = JSON.parse(readFileSync(absolutePath(configPath, cwd), 'utf8'));
    if (typeof content !== 'object' || content === null || Array.isArray(content)) {
      throw new Error('Paseo MCP configuration must contain a JSON object.');
    }
    const config = content as Record<string, unknown>;
    const entries = config.mcpServers ?? config['mcp-servers'];
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
      throw new Error('Paseo MCP configuration must contain an mcpServers object.');
    }
    for (const [name, config] of Object.entries(entries)) {
      servers.push({ name, config });
    }
  }
  return servers;
}

async function sessionManagerFor(
  parsed: Args,
  cwd: string,
  sessionDir: string | undefined,
): Promise<SessionManager> {
  if (parsed.noSession) return SessionManager.inMemory(cwd, { id: parsed.sessionId });
  if (parsed.session || parsed.fork) {
    const reference = parsed.session ?? parsed.fork!;
    let sessionPath = absolutePath(reference, cwd);
    if (!existsSync(sessionPath)) {
      const sessions = await SessionManager.list(cwd, sessionDir);
      const matches = sessions.filter((session) => session.id.startsWith(reference));
      if (matches.length !== 1) throw new Error('Pi session reference is missing or ambiguous.');
      sessionPath = matches[0]!.path;
    }
    return parsed.fork
      ? SessionManager.forkFrom(sessionPath, cwd, sessionDir, { id: parsed.sessionId })
      : SessionManager.open(sessionPath, sessionDir);
  }
  if (parsed.continue) return SessionManager.continueRecent(cwd, sessionDir);
  if (parsed.resume) throw new Error('RPC resume requires --session <path or id>.');
  const existing = parsed.sessionId
    ? SessionManager.findById(cwd, parsed.sessionId, sessionDir)
    : undefined;
  return existing
    ? SessionManager.open(existing, sessionDir)
    : SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

/** Enforce the evaluation model at the SDK stream boundary, including default compaction calls. */
export function guardEvaluationModelRuntime(
  runtime: Pick<ModelRuntime, 'stream' | 'streamSimple'>,
  endpoint: string | undefined,
): void {
  if (!endpoint) throw new Error('Evaluation Ollama endpoint is missing');
  const assertModel = (model: { id: string; provider: string; baseUrl: string }) => {
    if (
      model.id !== EVAL_MODEL ||
      model.provider !== 'ollama' ||
      model.baseUrl !== `${endpoint}/v1`
    )
      throw new Error(
        'Evaluation model pin violation: model, provider and endpoint must match the prepared local Bonsai configuration',
      );
  };
  // > SDK complete methods delegate here; default compaction also uses streamSimple directly.
  const stream = runtime.stream.bind(runtime);
  runtime.stream = (model, context, options) => {
    assertModel(model);
    return stream(model, context, options);
  };
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    assertModel(model);
    return streamSimple(model, context, options);
  };
}

/** Reserve capacity at the SDK request boundary before Pi invokes a model provider. */
export function guardBugHunterModelRuntime(
  runtime: Pick<ModelRuntime, 'stream' | 'streamSimple'>,
  identity: { endpoint: string; token: string; sessionId: string; nativeAgentId: string },
): void {
  const { endpoint, token, sessionId, nativeAgentId } = identity;
  const gatedOptions = <Options extends ModelsRequestTransforms & { signal?: AbortSignal }>(
    options: Options | undefined,
  ) => {
    const transformHeaders: NonNullable<ModelsRequestTransforms['transformHeaders']> = async (
      headers,
    ) => {
      const timeout = globalThis.AbortSignal.timeout(3000);
      const signal = options?.signal
        ? globalThis.AbortSignal.any([options.signal, timeout])
        : timeout;
      let authorized = false;
      try {
        const result = await fetch(`${endpoint}/v1/activity/bughunter-model-request`, {
          method: 'POST',
          redirect: 'error',
          signal: signal as NonNullable<Parameters<typeof fetch>[1]>['signal'],
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, nativeAgentId }),
        });
        authorized = result.status === 204;
      } catch {
        // > Gate failure denies the request without exposing credentials or endpoints.
      }
      if (!authorized)
        throw new Error('BugHunter has no model request capacity for this assignment.');
      return options?.transformHeaders ? options.transformHeaders(headers) : headers;
    };
    return Object.assign({}, options, { transformHeaders });
  };
  const stream = runtime.stream.bind(runtime);
  runtime.stream = (model, context, options) => stream(model, context, gatedOptions(options));
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) =>
    streamSimple(model, context, gatedOptions(options));
}

/** Create native Pi services while keeping credentials outside workspace state. */
export async function createPiRpcRuntime(argv: string[]): Promise<AgentSessionRuntime> {
  const { parsed, mcpConfigPaths } = parseRpcArguments(argv);
  for (const diagnostic of parsed.diagnostics) {
    if (diagnostic.type === 'error') throw new Error(diagnostic.message);
    console.error(diagnostic.message);
  }
  if (parsed.fileArgs.length) throw new Error('@file arguments are not supported in RPC mode.');
  if (parsed.fork && (parsed.session || parsed.continue || parsed.resume || parsed.noSession)) {
    throw new Error(
      '--fork cannot be combined with --session, --continue, --resume, or --no-session.',
    );
  }
  if (parsed.sessionId && (parsed.session || parsed.continue || parsed.resume)) {
    throw new Error('--session-id cannot be combined with --session, --continue, or --resume.');
  }
  const managed = Boolean(process.env.LTCOOK_NATIVE_AGENT_ID);
  const recorded = managed && process.env.LTCOOK_RESOLVED_MODEL;
  const selection = recorded ? ResolvedModelSchema.parse(JSON.parse(recorded)) : undefined;
  if (managed && (parsed.noExtensions || parsed.noSkills || parsed.noContextFiles))
    throw new Error(
      'Managed LTCook sessions require Core extensions, skills, and standing context.',
    );
  const cwd = process.cwd();
  const bugScan = managed && process.env.LTCOOK_TEAM_ID === bugHunterTeamId;
  const budgetIdentity = bugScan
    ? {
        endpoint: process.env.LTCOOK_RUNTIME_API_URL,
        token: process.env.LTCOOK_AGENT_API_TOKEN,
        sessionId: process.env.LTCOOK_SESSION_ID,
        nativeAgentId: process.env.LTCOOK_NATIVE_AGENT_ID,
      }
    : undefined;
  const mcpServers = bugScan ? [] : loadMcpServerConfigs(mcpConfigPaths, cwd);
  const injectedWorkspaceTools =
    !managed &&
    !parsed.noExtensions &&
    !parsed.noMcp &&
    !process.env.LTCOOK_EVAL_ARM &&
    process.env.LTCOOK_WORKSPACE_MCP === WORKSPACE_MCP_SERVER;
  const workspaceMcpExtension = createMcpExtension();
  const agentDir = absolutePath(getAgentDir());
  const authDir = process.env.LTCOOK_PI_AUTH_DIR;
  if (!authDir || !path.isAbsolute(authDir)) {
    throw new Error('LTCOOK_PI_AUTH_DIR must name the resolved absolute shared Pi auth directory.');
  }
  const authPath = path.join(authDir, 'auth.json');
  const startupSettings = SettingsManager.create(cwd, agentDir);
  const configuredSessionDir =
    parsed.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? startupSettings.getSessionDir();
  const sessionDir = configuredSessionDir ? absolutePath(configuredSessionDir, cwd) : undefined;
  const sessionManager = await sessionManagerFor(parsed, cwd, sessionDir);
  if (parsed.name !== undefined) {
    const name = parsed.name.trim();
    if (!name) throw new Error('--name must not be empty.');
    sessionManager.appendSessionInfo(name);
  }
  const resolvePaths = (values: string[] | undefined) =>
    values?.map((value) => absolutePath(value, cwd));
  const extensionPaths = resolvePaths(parsed.extensions);
  const skillPaths = resolvePaths(parsed.skills);
  const promptTemplatePaths = resolvePaths(parsed.promptTemplates);
  const themePaths = resolvePaths(parsed.themes);
  const trustStore = new ProjectTrustStore(agentDir);
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const guidance = managed
      ? new NativeGuidance(
          await loadTeam(process.env.LTCOOK_TEAM ?? ''),
          process.env.LTCOOK_MEMBER_KEY ?? '',
          process.env.LTCOOK_GUIDANCE_DIR ??
            (() => {
              throw new Error('LTCOOK_GUIDANCE_DIR must be resolved before native HOME changes');
            })(),
          coreGuidanceDirectory(),
          process.env.LTCOOK_EVAL_ARM === 'minimal',
          process.env.LTCOOK_SHARED_SKILLS_DIR ?? '',
        )
      : undefined;
    // > Recreate cwd-bound resources on native new/resume/fork, retaining the shared auth path.
    const projectTrusted = process.env.LTCOOK_EVAL_ARM
      ? true
      : (parsed.projectTrustOverride ??
        trustStore.get(cwd) ??
        !hasTrustRequiringProjectResources(cwd));
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
    const modelRuntime = await ModelRuntime.create({
      authPath,
      modelsPath: path.join(agentDir, 'models.json'),
    });
    if (process.env.LTCOOK_EVAL_ARM)
      guardEvaluationModelRuntime(modelRuntime, process.env.LTCOOK_EVAL_ENDPOINT);
    else useCodexOpenAiAuth(modelRuntime);
    if (budgetIdentity) {
      const { endpoint, token, sessionId, nativeAgentId } = budgetIdentity;
      if (!endpoint || !token || !sessionId || !nativeAgentId)
        throw new Error('BugHunter requires authenticated model budget context.');
      guardBugHunterModelRuntime(modelRuntime, { endpoint, token, sessionId, nativeAgentId });
    }
    const paseoMcpExtension: ExtensionFactory = (pi) => {
      // > Pi validates raw configs at registration; its public type describes
      // > validated input. Keep file values unknown until that native boundary.
      const register = pi.registerMcpServer as (name: string, config: unknown) => void;
      for (const { name, config } of mcpServers) register.call(pi, name, config);
    };
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      extensionFlagValues: parsed.unknownFlags,
      resourceLoaderOptions: {
        additionalExtensionPaths: bugScan ? undefined : extensionPaths,
        additionalSkillPaths: [...(skillPaths ?? []), ...(guidance?.skillPaths ?? [])],
        skillsOverride: guidance?.skillsOverride,
        agentsFilesOverride: guidance?.agentsFilesOverride,
        additionalPromptTemplatePaths: promptTemplatePaths,
        additionalThemePaths: themePaths,
        extensionFactories: [
          ...(injectedWorkspaceTools
            ? [
                {
                  name: 'mcp',
                  builtin: true as const,
                  factory: (pi: Parameters<ExtensionFactory>[0]) =>
                    workspaceMcpExtension({
                      ...pi,
                      getMcpServers: () =>
                        pi.getMcpServers().map((server) =>
                          server.name === WORKSPACE_MCP_SERVER
                            ? {
                                ...server,
                                config: {
                                  ...server.config,
                                  exposure: 'direct',
                                  timeout: (REPO_SEARCH_TIMEOUT_MS + 10_000) / 1000,
                                },
                              }
                            : server,
                        ),
                    }),
                },
              ]
            : []),
          ...(managed || !parsed.noExtensions
            ? [
                async (pi: Parameters<ExtensionFactory>[0]) => {
                  const extensionFile = path.join(
                    path.dirname(fileURLToPath(import.meta.url)),
                    import.meta.url.endsWith('.ts') ? 'pi-extension.ts' : 'pi-extension.js',
                  );
                  const {
                    default: activate,
                    activateStandaloneRied,
                    activateStandaloneRepoSearch,
                  } = (await import(
                    pathToFileURL(extensionFile).href
                  )) as typeof import('./pi-extension.js');
                  if (managed) await activate(pi, () => guidance!.inspection);
                  else if (!injectedWorkspaceTools) {
                    const sessionId = sessionManager.getSessionId();
                    activateStandaloneRied(pi, cwd, sessionId);
                    activateStandaloneRepoSearch(pi, cwd, sessionId);
                  }
                },
              ]
            : []),
          ...(mcpServers.length > 0 && !parsed.noExtensions && !parsed.noMcp
            ? [paseoMcpExtension]
            : []),
        ],
        noExtensions: bugScan || Boolean(process.env.LTCOOK_EVAL_ARM) || parsed.noExtensions,
        disabledBuiltinExtensions: bugScan || parsed.noMcp ? ['mcp'] : undefined,
        noSkills: parsed.noSkills,
        noPromptTemplates: parsed.noPromptTemplates,
        noThemes: parsed.noThemes,
        noContextFiles: parsed.noContextFiles,
        systemPrompt: parsed.systemPrompt,
        appendSystemPrompt: parsed.appendSystemPrompt,
      },
    });
    const diagnostics = [
      ...services.diagnostics,
      ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({
        type: 'error' as const,
        message: `Failed to load extension "${path}": ${error}`,
      })),
    ];
    const patterns = parsed.models ?? settingsManager.getEnabledModels();
    const scope = patterns?.length
      ? await resolveModelScopeWithDiagnostics(patterns, modelRuntime)
      : { scopedModels: [], diagnostics: [] };
    const history = sessionManager.buildSessionContext();
    const recordedModel = selection
      ? (history.model ?? { provider: selection.provider, modelId: selection.model })
      : undefined;
    const savedReasoning = ReasoningEffortSchema.safeParse(
      history.thinkingLevel === 'off' ? 'none' : history.thinkingLevel,
    ).data;
    // > Paseo passes its saved effort on resume. Pi's history records any live model change.
    const selectedThinking =
      selection && !history.model
        ? piThinking(selection.reasoning)
        : (parsed.thinking ?? (selection ? piThinking(savedReasoning) : undefined));
    const savedModel = recordedModel
      ? modelRuntime.getModel(recordedModel.provider, recordedModel.modelId)
      : undefined;
    if (recordedModel && !savedModel)
      throw new Error(
        `Pi cannot resolve the saved model ${recordedModel.provider}/${recordedModel.modelId}.`,
      );
    const resolved =
      !selection && parsed.model
        ? resolveCliModel({
            cliProvider: parsed.provider,
            cliModel: parsed.model,
            cliThinking: parsed.thinking,
            inlineApiKey: Boolean(parsed.apiKey),
            modelRuntime,
          })
        : undefined;
    if (resolved?.error) throw new Error(resolved.error);
    if (resolved?.warning) console.error(resolved.warning);
    const scopedDefault =
      history.messages.length === 0
        ? (scope.scopedModels.find(
            ({ model }) =>
              model.provider === settingsManager.getDefaultProvider() &&
              model.id === settingsManager.getDefaultModel(),
          ) ?? scope.scopedModels[0])
        : undefined;
    const model = savedModel ?? resolved?.model ?? scopedDefault?.model;
    const thinkingLevel =
      selectedThinking ?? resolved?.thinkingLevel ?? scopedDefault?.thinkingLevel;
    if (parsed.apiKey) {
      if (!model) throw new Error('--api-key requires an explicitly selected model.');
      await modelRuntime.setRuntimeApiKey(model.provider, parsed.apiKey);
    }
    for (const diagnostic of [...diagnostics, ...scope.diagnostics]) {
      if (diagnostic.type === 'error') throw new Error(diagnostic.message);
      console.error(diagnostic.message);
    }
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      thinkingLevel,
      scopedModels: scope.scopedModels,
      tools: parsed.tools,
      excludeTools: parsed.excludeTools,
      noTools: parsed.noTools ? 'all' : parsed.noBuiltinTools ? 'builtin' : undefined,
    });
    if (
      recordedModel &&
      selectedThinking !== undefined &&
      created.session.thinkingLevel !== selectedThinking
    ) {
      throw new Error(
        `Pi cannot run ${recordedModel.provider}/${recordedModel.modelId} with ${selectedThinking} reasoning.`,
      );
    }
    if (created.session.model && (selectedThinking !== undefined || resolved?.thinkingLevel)) {
      created.session.setThinkingLevel(created.session.thinkingLevel);
    }
    return { ...created, services, diagnostics };
  };
  return createAgentSessionRuntime(createRuntime, {
    cwd: sessionManager.getCwd(),
    agentDir,
    sessionManager,
  });
}

async function runNativeCli(argv: string[]): Promise<void> {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const child = spawn(
    process.execPath,
    [path.join(path.dirname(entry), 'bundle/cli.js'), ...argv],
    {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    },
  );
  const signals: NodeJS.Signals[] =
    process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = signals.map((signal) => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return { signal, handler };
  });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    for (const { signal, handler } of handlers) process.off(signal, handler);
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.code ?? 1;
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
}

/** Preserve native non-RPC commands; only RPC sessions need the separated SDK paths. */
export async function runPiLauncher(argv: string[]): Promise<void> {
  // > Paseo recognizes --mode=rpc too, although Pi 1.5.2's parser requires separate arguments.
  const normalized = argv.flatMap((argument) =>
    argument.startsWith('--mode=') ? ['--mode', argument.slice('--mode='.length)] : [argument],
  );
  const parsed = parseArgs(normalized);
  if (parsed.mode !== 'rpc' || parsed.help || parsed.version || parsed.listModels !== undefined) {
    await runNativeCli(normalized);
    return;
  }
  if (parsed.offline) process.env.PI_OFFLINE = '1';
  // > Pi's RPC stdout guard is installed by runRpcMode, after extensions load.
  // > Keep console output on stderr for startup and every later RPC session reload.
  const stdoutWrite = process.stdout.write;

  const rpcConsole = new Console({ stdout: process.stderr, stderr: process.stderr });
  const originalOutputMethods = {
    debug: console.debug,
    dir: console.dir,
    dirxml: console.dirxml,
    info: console.info,
    log: console.log,
    table: console.table,
    trace: console.trace,
  };
  process.stdout.write = process.stderr.write.bind(process.stderr);
  console.debug = rpcConsole.debug.bind(rpcConsole);
  console.dir = rpcConsole.dir.bind(rpcConsole);
  console.dirxml = rpcConsole.dirxml.bind(rpcConsole);
  console.info = rpcConsole.info.bind(rpcConsole);
  console.log = rpcConsole.log.bind(rpcConsole);
  console.table = rpcConsole.table.bind(rpcConsole);
  console.trace = rpcConsole.trace.bind(rpcConsole);
  let runtime: AgentSessionRuntime;
  try {
    try {
      runtime = await createPiRpcRuntime(normalized);
    } finally {
      process.stdout.write = stdoutWrite;
    }
    if (!parsed.offline && process.env.PI_OFFLINE === undefined) {
      void runtime.services.modelRuntime.refresh().catch(() => {
        console.error('Pi model catalog refresh failed.');
      });
    }
    await runRpcMode(runtime);
  } finally {
    process.stdout.write = stdoutWrite;
    console.debug = originalOutputMethods.debug;
    console.dir = originalOutputMethods.dir;
    console.dirxml = originalOutputMethods.dirxml;
    console.info = originalOutputMethods.info;
    console.log = originalOutputMethods.log;
    console.table = originalOutputMethods.table;
    console.trace = originalOutputMethods.trace;
  }
}

/** Publish activation failure through the same bound-agent inspection command, without authorizing a turn. */
export async function publishPiActivationFailure(error: unknown): Promise<boolean> {
  const endpoint = process.env.LTCOOK_RUNTIME_API_URL;
  const token = process.env.LTCOOK_AGENT_API_TOKEN;
  const nativeAgentId = process.env.LTCOOK_NATIVE_AGENT_ID;
  const sessionId = process.env.LTCOOK_SESSION_ID;
  if (!endpoint || !token || !nativeAgentId || !sessionId) return false;
  const inspection = {
    resources: [],
    diagnostics: [
      {
        source: 'Pi native activation',
        reason:
          error instanceof NativeGuidanceError
            ? error.message
            : 'Pi activation failed; inspect the native agent diagnostics.',
      },
    ],
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/v1/command`, {
        method: 'POST',
        signal: globalThis.AbortSignal.timeout(1000) as NonNullable<
          Parameters<typeof fetch>[1]
        >['signal'],
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          nativeAgentId,
          command: { type: 'guidance.loaded', inspection },
        }),
      });
      if (response.ok) return true;
    } catch {
      // > Creation may not have established a bound identity yet.
    }
    if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

if (import.meta.main) {
  runPiLauncher(process.argv.slice(2)).catch(async (error: unknown) => {
    if (process.env.LTCOOK_NATIVE_AGENT_ID && !(await publishPiActivationFailure(error)))
      console.error(
        'Native loading failure could not be registered; guidance inspection remains unavailable.',
      );
    console.error(error instanceof Error ? error.message : 'Pi launcher failed.');
    process.exitCode = 1;
  });
}

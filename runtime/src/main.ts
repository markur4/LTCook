import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { SessionSnapshot } from './workflow-api/index.js';
import { TeamRegistry } from './integrations/team-loader.js';
import { RiedService } from './repository/discovery.js';
import { createTools } from './tools/catalog.js';
import { WebToolService } from './tools/web.js';
import { WorkspaceMcp } from './integrations/mcp.js';
import { ActivityPreferences } from './integrations/activity-preferences.js';
import { verifyDeployedBuild } from './integrations/deployed-build.js';
import { PaseoWorkspaceServices } from './integrations/paseo-workspace-services.js';
import { createWorktreeScopeResolver, SessionWorktrees } from './integrations/session-worktrees.js';
import { createColgrepProvider } from './repository/providers/colgrep.js';
import type { RepositoryIndexService } from './services/repository-index.js';
import { createSessionWorktreeTool } from './tools/session-worktree.js';
import { isWithin } from './path-containment.js';
import { connectPlanningDialogs } from './integrations/planning-dialogs.js';
import { EvalRunService } from './evals/service.js';
import { createEvalEngine } from './evals/engine.js';
import { createPaseoMemorySource } from './integrations/paseo-memory.js';
import { ConversationRecords } from './session-memory/conversation.js';
import { hostedConversationProvider } from './session-memory/hosted.js';
import { ConversationInference, localConversationProvider } from './session-memory/inference.js';
import { TrackerService } from './session-memory/tracker.js';
import { ServiceInferenceError } from './services/inference-recovery.js';
import { openConversationProductStore } from './session-memory/product-store.js';
import { PastedDocuments } from './session-memory/pasted-documents.js';
import { catalogModelAliases, resolveModel } from './models/aliases.js';
const EX_TEMPFAIL = 75;
const restartResult = z.looseObject({ state: z.string(), message: z.string() });
function isListenAddressInUse(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'EADDRINUSE' &&
    'syscall' in error &&
    error.syscall === 'listen'
  );
}
function safeErrorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return [...error.errors].map(safeErrorMessage).join('; ');
  }
  return error instanceof Error
    ? error.message.replace(/(token|password|api.?key)=?[^\s]*/gi, '$1=<redacted>')
    : 'unknown runtime error';
}

function metadataCommand(argv: string[]): boolean {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'LTCook runtime\nUsage: node runtime/dist/main.js [--help|--version]\nStarts the selected AppRC team in Paseo using the built-in Pi provider.\n',
    );
    return true;
  }
  if (argv.includes('--version')) {
    process.stdout.write('LTCook runtime 0.1.0\n');
    return true;
  }
  return false;
}

async function runServiceAction(action: string | undefined): Promise<void> {
  if (!action || !['start', 'stop', 'status', 'logs'].includes(action))
    throw new Error('Usage: runtime service-action <start|stop|status|logs>');
  const { createServiceController } = await import('./services/controller.js');
  const controller = createServiceController(process.env);
  const output = await controller[action as 'start' | 'stop' | 'status' | 'logs']();
  process.stdout.write(output ? `${output}\n` : 'Service action completed.\n');
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'model-launch') {
    const { launchModel } = await import('./models/launcher.js');
    await launchModel(args.slice(1));
    return;
  }
  if (metadataCommand(args)) return;
  if (args[0] === 'service-action') {
    await runServiceAction(args[1]);
    return;
  }
  const instanceId = args[0] === '--restart-instance-id' ? z.uuid().parse(args[1]) : randomUUID();

  const [
    { createRuntime },
    { RuntimeApi, agentBearer },
    { SessionActivation },
    { captureShellEnvironment },
    { createPaseoAgentBackend, startPaseoHost },
    { Telemetry },
    fs,
    childProcess,
  ] = await Promise.all([
    import('./core/runtime.js'),
    import('./integrations/runtime-api.js'),
    import('./integrations/session-activation.js'),
    import('./integrations/shell-environment.js'),
    import('./integrations/paseo.js'),
    import('./diagnostics/telemetry.js'),
    import('node:fs/promises'),
    import('node:child_process'),
  ]);
  const deployment = process.env.LTCOOK_DEPLOYMENT_DIR;
  const jsRoot = process.env.LTCOOK_JS_ROOT;
  const workspace = process.env.LTCOOK_WORKSPACE;
  const sessionId = process.env.LTCOOK_SESSION;
  const python = process.env.LTCOOK_PYTHON;
  const logs = process.env.LTCOOK_LOGS;
  const traces = process.env.LTCOOK_TRACES;
  const teamSelection = process.env.LTCOOK_TEAM ?? '';
  const serviceConnection = process.env.LTCOOK_SERVICE_CONNECTION;
  const stateDirectory = process.env.LTCOOK_RUNTIME_STATE_DIR;
  const riedCacheDirectory = process.env.LTCOOK_RIED_CACHE_DIR;
  if (
    !deployment ||
    !jsRoot ||
    !python ||
    !logs ||
    !traces ||
    (workspace && !teamSelection) ||
    !serviceConnection ||
    !stateDirectory ||
    !riedCacheDirectory
  ) {
    throw new Error(
      'AppRC did not resolve required runtime configuration; launch through `ltcook launch runtime`.',
    );
  }
  if (Boolean(workspace) !== Boolean(sessionId)) {
    throw new Error('LTCOOK_WORKSPACE and LTCOOK_SESSION must be supplied together.');
  }
  const deploymentRoot = path.resolve(deployment);
  const appRoot = path.resolve(jsRoot);
  const workspaceRoot = workspace ? path.resolve(workspace) : undefined;
  const paseoHome = process.env.PASEO_HOME;
  const piHome = process.env.PI_CODING_AGENT_DIR;
  const node = process.env.LTCOOK_NODE_EXECUTABLE;
  const databasePath = process.env.LTCOOK_DATABASE;
  const apiListen = process.env.LTCOOK_API_LISTEN;
  const paseoListen = process.env.LTCOOK_PASEO_LISTEN;
  const teams = await TeamRegistry.load(appRoot);
  const team = workspaceRoot ? teams.resolve(teamSelection) : undefined;
  const apiToken = process.env.LTCOOK_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      'LTCOOK_API_TOKEN is missing; run the LTCook installer to initialize ' +
        'service credentials, or set LTCOOK_API_TOKEN through AppRC.',
    );
  }
  await fs.mkdir(deploymentRoot, { recursive: true, mode: 0o700 });
  const canonicalDeploymentRoot = await fs.realpath(deploymentRoot);
  let canonicalDatabasePath = databasePath ?? '';
  if (databasePath && databasePath !== ':memory:') {
    const databaseCandidate = path.resolve(databasePath);
    await fs.mkdir(path.dirname(databaseCandidate), { recursive: true, mode: 0o700 });
    try {
      canonicalDatabasePath = await fs.realpath(databaseCandidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      canonicalDatabasePath = path.join(
        await fs.realpath(path.dirname(databaseCandidate)),
        path.basename(databaseCandidate),
      );
    }
  }
  const telemetry = new Telemetry(path.resolve(logs), path.resolve(traces));
  const startup = telemetry.begin('runtime.start');
  let api: InstanceType<typeof RuntimeApi> | undefined;
  let host: Awaited<ReturnType<typeof startPaseoHost>> | undefined;
  let apiListening = false;
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let evals: EvalRunService | undefined;
  let memory: ConversationRecords | undefined;
  let conversationInference: ConversationInference | undefined;
  let conversationProducts: ReturnType<typeof openConversationProductStore> | undefined;
  let tracker: TrackerService | undefined;
  let workspaceServices: PaseoWorkspaceServices | undefined;
  let repositoryIndex: RepositoryIndexService | undefined;
  let initialSnapshot: SessionSnapshot | undefined;
  let stopping = false;
  const nativePreparation = new AbortController();
  let shutdownPromise: Promise<void> | undefined;
  let disconnectPlanningDialogs: (() => void) | undefined;
  let serviceStartup: Promise<unknown> | undefined;
  const ensureProjectServices = async (): Promise<void> => {
    if (serviceConnection !== 'local') return;
    serviceStartup ??= import('./services/controller.js')
      .then(({ createServiceController }) => createServiceController(process.env).start())
      .catch((error) => {
        serviceStartup = undefined;
        throw error;
      });
    await serviceStartup;
  };
  const cleanup = (signal: string, exitCode: number): Promise<void> => {
    stopping = true;
    nativePreparation.abort(new Error('LTCook runtime is stopping.'));
    startup.end();
    shutdownPromise ??= (async () => {
      const failures: unknown[] = [];
      api?.beginShutdown();
      disconnectPlanningDialogs?.();
      const attempt = async (operation: () => Promise<unknown> | unknown): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      await attempt(() =>
        telemetry.log('info', 'runtime.shutdown', {
          signal,
          sessionId: initialSnapshot?.session.id,
        }),
      );
      if (workspaceServices) await attempt(() => workspaceServices!.close());
      if (repositoryIndex) await attempt(() => repositoryIndex!.close());
      if (tracker) await attempt(() => tracker!.close());
      if (conversationInference) await attempt(() => conversationInference!.close());
      if (conversationProducts) await attempt(() => conversationProducts!.close());
      if (memory) await attempt(() => memory!.close());
      if (runtime) await attempt(() => runtime!.close());
      if (evals) await attempt(() => evals!.close());
      if (host) await attempt(() => host!.close());
      if (api && apiListening) await attempt(() => api!.close());
      await attempt(() => telemetry.exportTrace());
      if (failures.length) {
        for (const error of failures) {
          process.stderr.write(`LTCook runtime shutdown failed: ${safeErrorMessage(error)}\n`);
        }
        process.exitCode = 1;
      } else {
        process.exitCode = exitCode;
      }
    })();
    return shutdownPromise;
  };
  process.on('SIGINT', () => {
    void cleanup('SIGINT', 130);
  });
  process.on('SIGTERM', () => {
    void cleanup('SIGTERM', 143);
  });
  try {
    if (!paseoHome || !piHome || !node || !databasePath || !apiListen || !paseoListen) {
      throw new Error(
        'AppRC did not resolve required native runtime paths; launch through `ltcook launch runtime`.',
      );
    }
    const sourceRuntime = process.versions.bun !== undefined;
    const installedRuntime =
      !sourceRuntime && appRoot === path.join(canonicalDeploymentRoot, 'app');
    const receipt = z
      .looseObject({
        app: z.string().optional(),
        browser_available: z.boolean().optional(),
        browser_executable: z.string().optional(),
        fingerprint: z.string().optional(),
      })
      .parse(
        JSON.parse(
          await fs
            .readFile(path.join(canonicalDeploymentRoot, 'runtime.json'), 'utf8')
            .catch((error: unknown) => {
              if (installedRuntime) throw error;
              return '{}';
            }),
        ),
      );
    if (installedRuntime && receipt.app !== appRoot)
      throw new Error('The installed runtime receipt belongs to a different deployment.');
    const buildFingerprint = installedRuntime
      ? await verifyDeployedBuild(appRoot, fileURLToPath(import.meta.url), receipt.fingerprint)
      : undefined;
    let summarizerModel = '';
    try {
      summarizerModel = resolveModel('local-tiny', process.env).model;
    } catch {
      // > A local evaluation model is resolved separately from the active conversation provider.
    }
    const summarization = {
      endpoint: process.env.LTCOOK_OLLAMA_ENDPOINT ?? '',
      model: summarizerModel,
      keepAlive: Number(process.env.LTCOOK_SUMMARIZER_KEEP_ALIVE ?? '-1'),
      generation: process.env.LTCOOK_SUMMARIZER_GENERATION,
    };
    evals = new EvalRunService(
      stateDirectory,
      createEvalEngine({
        resources: path.join(appRoot, 'runtime', 'resources'),
        appRoot,
        nodeExecutable: node,
        python,
        teamSelection,
        summarization,
      }),
    );
    await evals.initialize();
    const workspaceShellEnvironments = new Map<string, Record<string, string>>();
    const ried = new RiedService(riedCacheDirectory, process.env.LTCOOK_BRIEF_EXECUTABLE, (id) =>
      workspaceShellEnvironments.get(id),
    );
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const colgrep = createColgrepProvider({ background: true });
    repositoryIndex = colgrep.indexService;
    const preferences = new ActivityPreferences(
      path.join(stateDirectory, 'activity-settings.json'),
    );
    const worktrees = new SessionWorktrees(process.env.PATH ?? '');
    const resolveScope = createWorktreeScopeResolver((id) => runtime?.snapshot(id));
    const worktreeTool = createSessionWorktreeTool(worktrees, resolveScope);
    const activation = new SessionActivation(process.env, repositoryIndex);
    api = new RuntimeApi(undefined, apiToken, apiListen, activation, process.env, telemetry, {
      activity: { colgrep, preferences },
      worktrees: { store: worktrees, resolveScope },
    });
    const web = new WebToolService(
      python,
      {
        command: sourceRuntime ? process.execPath : node,
        entrypoint: path.join(
          appRoot,
          sourceRuntime ? 'runtime/src/tools/web-mcp.mjs' : 'runtime/dist/tools/web-mcp.js',
        ),
      },
      process.env,
      (id) => workspaceShellEnvironments.get(id),
      ensureProjectServices,
    );
    api.setEval(evals);
    const apiUrl = await api.listen();
    apiListening = true;
    if (stopping) {
      await api.close();
      apiListening = false;
      return;
    }
    if (workspaceRoot) {
      try {
        await promisify(childProcess.execFile)(
          python,
          ['-m', 'ltcook.launch', 'write-native-config', '--workspace', workspaceRoot],
          {
            encoding: 'utf8',
            env: process.env,
            signal: nativePreparation.signal,
            timeout: 15_000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
          },
        );
      } catch (error) {
        if (nativePreparation.signal.aborted) return;
        const stderr =
          error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
            ? error.stderr
            : '';
        const pathError = /PI_CODING_AGENT_DIR must resolve inside the LTCook deployment\./.exec(
          stderr,
        )?.[0];
        throw new Error(
          pathError ?? 'AppRC native configuration adapter failed to write its registered files.',
        );
      }
    }
    if (stopping) return;
    if (!['local', 'direct', 'paseo-tunnel'].includes(serviceConnection)) {
      throw new Error('LTCOOK_SERVICE_CONNECTION must be local, direct, or paseo-tunnel.');
    }
    if (workspaceRoot) await ensureProjectServices();
    if (stopping) return;
    host = await startPaseoHost({
      node,
      home: paseoHome,
      deploymentRoot: canonicalDeploymentRoot,
      listen: paseoListen,
      password: process.env.LTCOOK_PASEO_PASSWORD,
      runtimeApiUrl: apiUrl,
      userToken: apiToken,
      pluginDirectory: path.join(appRoot, 'runtime', 'dist', 'paseo-plugin'),
    });
    if (stopping) {
      await host.close();
      host = undefined;
      return;
    }
    api.setProviderSubagents(host.listProviderSubagents);
    const pastedDocuments = new PastedDocuments(
      path.join(stateDirectory, 'pasted-documents'),
      apiToken,
    );
    api.setPastedDocuments(pastedDocuments);
    const source = createPaseoMemorySource(host.api, apiToken, pastedDocuments);
    memory = new ConversationRecords({
      databasePath: path.join(stateDirectory, 'conversation-records-v1.sqlite'),
      source,
      onObserved: (id) => tracker?.observe(id),
      peers: (agentId, workspace) => runtime?.memoryPeers(agentId, workspace) ?? [],
      onDispatch: (event) => {
        void telemetry.log('info', 'conversation.handoff', event);
      },
      onFailure: (event) => {
        void telemetry.log('warn', 'conversation.observation_failed', event);
      },
    });
    api.setConversationRecords(memory, (id) => runtime?.memoryContext(id));

    const configuredLocal = process.env.LTCOOK_CONVERSATION_LOCAL_MODEL?.trim() || '@local-CPU';
    const inferenceMode = z
      .enum(['hosted', 'local'])
      .safeParse(process.env.LTCOOK_CONVERSATION_INFERENCE?.trim() || 'hosted');
    const conversationInputTokens = z.coerce
      .number()
      .int()
      .positive()
      .safeParse(process.env.LTCOOK_CONVERSATION_INPUT_TOKENS ?? '8000');
    const conversationConfigurationError = !inferenceMode.success
      ? new ServiceInferenceError(
          'configuration',
          'Set LTCOOK_CONVERSATION_INFERENCE to hosted or local.',
        )
      : !conversationInputTokens.success
        ? new ServiceInferenceError(
            'configuration',
            'Set LTCOOK_CONVERSATION_INPUT_TOKENS to a positive integer.',
          )
        : undefined;
    conversationInference = new ConversationInference(
      {
        hosted: hostedConversationProvider(() => resolveModel('tiny', process.env)),
        local: localConversationProvider(() => {
          const local = configuredLocal.startsWith('@')
            ? resolveModel(configuredLocal, process.env)
            : { provider: 'ollama', model: configuredLocal };
          if (local.provider !== 'ollama')
            throw new Error('Set LTCOOK_CONVERSATION_LOCAL_MODEL to an Ollama model.');
          return { ...summarization, model: local.model };
        }),
      },
      inferenceMode.data ?? 'hosted',
      (event) => {
        void telemetry.log('info', 'conversation.inference', { product: 'tracker', ...event });
      },
      conversationConfigurationError,
    );
    api.setConversationInference(conversationInference);
    conversationProducts = openConversationProductStore(
      path.join(stateDirectory, 'conversation-products-v1.sqlite'),
    );
    const inputBudget = conversationInputTokens.data ?? 8000;
    const tracking = new TrackerService(
      conversationProducts,
      source,
      conversationInference,
      inputBudget,
    );
    tracker = tracking;
    api.setTracker(tracking);
    const recording = memory;
    void host.api.agents
      .list()
      .then(({ entries }) => {
        const conversations = entries.flatMap(({ agent }) =>
          ['ltcook', 'pi', 'codex'].includes(agent.provider) ? [agent.id] : [],
        );
        for (const id of conversations) tracking.observe(id, { baseline: true });
        return recording.recover(conversations);
      })
      .catch(() => {});

    if (stopping) return;
    const reserveIdleRestart = buildFingerprint ? host.reserveIdleRestart : undefined;
    const requestRestart =
      reserveIdleRestart && process.env.LTCOOK_PASEO_PASSWORD
        ? (update: boolean): Promise<Record<string, unknown>> =>
            new Promise((resolve, reject) => {
              const args = ['-I', '-m', 'ltcook', 'restart', '--when-idle', '--json'];
              if (update) args.push('--update', '--yes');
              childProcess.execFile(
                python,
                args,
                {
                  cwd: canonicalDeploymentRoot,
                  env: captureShellEnvironment(process.env),
                  timeout: 15_000,
                  maxBuffer: 64 * 1024,
                },
                (error, stdout) => {
                  if (error) {
                    reject(
                      new Error('Could not queue the idle restart. Check ltcook restart --status.'),
                    );
                    return;
                  }
                  try {
                    resolve(restartResult.parse(JSON.parse(stdout)));
                  } catch {
                    reject(new Error('The registered restart command returned an invalid status.'));
                  }
                },
              );
            })
        : undefined;
    const tools = createTools(
      ried,
      summarization,
      web,
      memory,
      colgrep,
      worktreeTool,
      conversationInference,
    );
    const workspaceMcp = new WorkspaceMcp(tools, apiListen, web, requestRestart, repositoryIndex);
    api.setWorkspaceTools(tools);
    api.setWorkspaceMcp(workspaceMcp);
    const backend = await createPaseoAgentBackend({
      telemetry,
      api: host.api,
      memoryProvenanceSecret: apiToken,
      python,
      runtimeApiUrl: apiUrl,
      piHome,
      extensionPath: path.join(appRoot, 'runtime', 'dist', 'integrations', 'pi-extension.js'),
      appNodeModules: path.join(appRoot, 'node_modules'),
      deploymentNode: node,
      browserAvailable: receipt.browser_available === true,
      browserExecutable: receipt.browser_executable,
      workspacePreparationSignal: nativePreparation.signal,
      originalShellEnvironment(_workspace, currentSessionId) {
        return workspaceShellEnvironments.get(currentSessionId);
      },
      identity(agentId) {
        return { agentId, token: agentBearer(apiToken, agentId) };
      },
    });
    if (stopping) return;
    const runtimeController = createRuntime({
      databasePath: canonicalDatabasePath,
      stateDirectory,
      ried,
      ...(team ? { team } : {}),
      teams,
      agents: backend,
      memory,
      memoryDelegation: process.env.LTCOOK_SESSION_MEMORY_DELEGATION === 'true',
      onEvent(event) {
        void telemetry.log('info', 'runtime.event', event);
      },
    });
    runtime = runtimeController;
    const disconnectPlanning = connectPlanningDialogs(host, runtimeController);
    const disconnectRestartApproval = requestRestart
      ? host.subscribePlanningDialogs(async (event) => workspaceMcp.observeRestartApproval(event))
      : undefined;
    disconnectPlanningDialogs = () => {
      disconnectRestartApproval?.();
      disconnectPlanning();
    };
    api.setRuntime(runtimeController);
    if (workspaceRoot && sessionId) {
      workspaceShellEnvironments.set(sessionId, captureShellEnvironment(process.env));
      try {
        initialSnapshot = await runtimeController.openSession({ id: sessionId, workspaceRoot });
      } catch (error) {
        if (nativePreparation.signal.aborted) return;
        throw error;
      }
      if (stopping) return;
      activation.register(workspaceRoot, initialSnapshot.session.id, {
        authorizeRepositoryIndex: true,
      });
    }
    if (stopping) return;
    activation.setWorkspaceActivator(async (request) => {
      const targetWorkspace = path.resolve(request.workspaceRoot);
      const shellEnvironment = { ...request.shellEnvironment };
      delete shellEnvironment.LTCOOK_SHELL_PROVENANCE;
      workspaceShellEnvironments.set(request.sessionId, shellEnvironment);
      try {
        if (!request.leaderAgentId) await ensureProjectServices();
        else
          void ensureProjectServices().catch((error: unknown) =>
            telemetry.log('error', 'runtime.services.unavailable', {
              message: safeErrorMessage(error),
            }),
          );
        return await runtimeController.openSession({
          id: request.sessionId,
          workspaceRoot: targetWorkspace,
          teamSelection: request.teamSelection,
          ...(request.leaderAgentId ? { leaderAgentId: request.leaderAgentId } : {}),
        });
      } catch (error) {
        workspaceShellEnvironments.delete(request.sessionId);
        throw error;
      }
    });
    const leaderFor = (teamSelection: string) => {
      const { definition } = teams.resolve(teamSelection);
      const leader = definition.members.find((member) => member.key === definition.leaderKey);
      if (!leader) throw new Error('Selected Team has no Leader');
      return leader;
    };
    api.setModelSelectionHandlers({
      catalog({ teamSelection }) {
        return catalogModelAliases(leaderFor(teamSelection), process.env);
      },
      async resolve({ teamSelection, workspaceRoot, alias, reasoning }) {
        return backend.resolveSelection(workspaceRoot, leaderFor(teamSelection), alias, reasoning);
      },
    });
    api.setPrepareSessionHandler(async (options, leaderAgentId, savedModel) => {
      const prepared = await backend.prepare(options, leaderAgentId, savedModel);
      return {
        env: prepared.env,
        ...(prepared.mcpServers ? { mcpServers: prepared.mcpServers } : {}),
      };
    });
    let backendLogPath: string | null = null;
    const capturePath = process.env.LTCOOK_BACKEND_LOG_PATH;
    if (capturePath) {
      if (!path.isAbsolute(capturePath)) {
        throw new Error('LTCOOK_BACKEND_LOG_PATH must be an absolute deployment-owned path.');
      }
      const candidate = path.resolve(capturePath);
      const parent = await fs.realpath(path.dirname(candidate));
      const file = await fs.lstat(candidate);
      if (
        file.isSymbolicLink() ||
        !file.isFile() ||
        !isWithin(canonicalDeploymentRoot, parent, true)
      ) {
        throw new Error('LTCOOK_BACKEND_LOG_PATH must be a regular file inside the deployment.');
      }
      backendLogPath = path.join(parent, path.basename(candidate));
    }
    if (stopping) return;
    api.setLifecycle(
      {
        instanceId,
        deploymentRoot: canonicalDeploymentRoot,
        databasePath: canonicalDatabasePath,
        paseoListen: host.listen,
        backendLogPath,
        paseoLogPath: host.logPath,
        telemetryLogPath: path.resolve(logs),
        buildFingerprint,
      },
      () => cleanup('API stop', 0),
      reserveIdleRestart,
    );
    workspaceServices = new PaseoWorkspaceServices({
      api: host.api,
      mutations: host.workspaceMutations,
      naming: host.workspaceNaming,
      archiveWorkspacePreservingFiles: host.archiveWorkspacePreservingFiles,
      listProviderSubagents: host.listProviderSubagents,
      stateDirectory,
      isQueued(agents) {
        const sessions = new Set(
          agents.flatMap((agent) => {
            const id = agent.provider === 'ltcook' ? agent.id : agent.labels['ltcook.session'];
            return id ? [id] : [];
          }),
        );
        for (const id of sessions) {
          try {
            const snapshot = runtimeController.snapshot(id);
            if (
              snapshot.assignments.some(({ status }) => status !== 'reported') ||
              snapshot.tasks.some(
                ({ scheduled, status }) =>
                  scheduled && ['pending', 'running', 'ready'].includes(status),
              ) ||
              snapshot.decisions.some(({ blocking, answeredAt }) => blocking && !answeredAt) ||
              snapshot.planning.some(({ stage }) => stage === 'awaiting-approval')
            )
              return true;
          } catch {
            // A missing managed binding is not evidence that its work has finished.
            return true;
          }
        }
        return false;
      },
      onError(service, error, workspaceId) {
        void telemetry.log('warn', 'workspace-services.update-failed', {
          service,
          workspaceId,
          message: safeErrorMessage(error),
        });
      },
    });
    api.setWorkspaceServices(workspaceServices);
    workspaceServices.start();
    if (stopping) return;
    const summary = initialSnapshot
      ? `${teamSelection}, ${initialSnapshot.members.length} declared members, ` +
        `${
          initialSnapshot.members.filter(
            ({ member, binding }) => member.lifetime === 'persistent' && binding?.state === 'bound',
          ).length
        } persistent native agents connected, ${initialSnapshot.blockers.length} blockers; `
      : teamSelection
        ? `${teamSelection}, no project session; `
        : 'no project session; ';
    process.stdout.write(`LTCook runtime ready: ${summary}Paseo ${host.listen}\n`);
    startup.end();
    await telemetry.log('info', 'runtime.ready', {
      sessionId: initialSnapshot?.session.id,
      teamId: team?.definition.id,
      memberCount: initialSnapshot?.members.length ?? 0,
      connectedPersistentAgentCount:
        initialSnapshot?.members.filter(
          ({ member, binding }) => member.lifetime === 'persistent' && binding?.state === 'bound',
        ).length ?? 0,
      blockerCount: initialSnapshot?.blockers.length ?? 0,
    });
    await new Promise<void>((resolve) => process.once('beforeExit', resolve));
  } catch (error) {
    await cleanup('startup failure', 1);
    throw error;
  } finally {
    startup.end();
    if (stopping) await shutdownPromise;
    else await telemetry.exportTrace();
  }
}

void run().catch((error) => {
  process.stderr.write(`LTCook runtime failed: ${safeErrorMessage(error)}\n`);
  process.exitCode = isListenAddressInUse(error) ? EX_TEMPFAIL : 1;
});

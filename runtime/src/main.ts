import path from 'node:path';
import process from 'node:process';
import type { SessionSnapshot } from './api/team.js';
import { selectedTeam } from './integrations/team-loader.js';
const EX_TEMPFAIL = 75;
function isListenAddressInUse(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'EADDRINUSE' &&
    'syscall' in error &&
    error.syscall === 'listen'
  );
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
  if (metadataCommand(args)) return;
  if (args[0] === 'service-action') {
    await runServiceAction(args[1]);
    return;
  }

  const [
    { createRuntime },
    { RuntimeApi, agentBearer, captureShellEnvironment },
    { createPaseoAgentBackend, startPaseoHost },
    { Telemetry },
    fs,
    childProcess,
  ] = await Promise.all([
    import('./core/runtime.js'),
    import('./integrations/runtime-api.js'),
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
  const teamSelection = process.env.LTCOOK_TEAM;
  const serviceConnection = process.env.LTCOOK_SERVICE_CONNECTION;
  if (
    !deployment ||
    !jsRoot ||
    !python ||
    !logs ||
    !traces ||
    !teamSelection ||
    !serviceConnection
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
  const team = await selectedTeam(teamSelection);
  const apiToken = process.env.LTCOOK_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      'LTCOOK_API_TOKEN is missing; run the LTCook installer to initialize ' +
        'service credentials, or set LTCOOK_API_TOKEN through AppRC.',
    );
  }
  await fs.mkdir(deploymentRoot, { recursive: true, mode: 0o700 });
  const telemetry = new Telemetry(logs, traces);
  const startup = telemetry.begin('runtime.start');
  let api: InstanceType<typeof RuntimeApi> | undefined;
  let host: Awaited<ReturnType<typeof startPaseoHost>> | undefined;
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let stopped = false;
  try {
    if (!paseoHome || !piHome || !node || !databasePath || !apiListen || !paseoListen) {
      throw new Error(
        'AppRC did not resolve required native runtime paths; launch through `ltcook launch runtime`.',
      );
    }
    if (workspaceRoot) {
      const configResult = childProcess.spawnSync(
        python,
        ['-m', 'ltcook.launch', 'write-native-config', '--workspace', workspaceRoot],
        { encoding: 'utf8', env: process.env, windowsHide: true },
      );
      if (configResult.status !== 0) {
        const pathError = /PI_CODING_AGENT_DIR must resolve inside the LTCook deployment\./.exec(
          configResult.stderr ?? '',
        )?.[0];
        throw new Error(
          pathError ?? 'AppRC native configuration adapter failed to write its registered files.',
        );
      }
    }
    if (serviceConnection === 'local') {
      const { createServiceController } = await import('./services/controller.js');
      await createServiceController(process.env).start();
    } else if (serviceConnection !== 'direct' && serviceConnection !== 'paseo-tunnel') {
      throw new Error('LTCOOK_SERVICE_CONNECTION must be local, direct, or paseo-tunnel.');
    }
    api = new RuntimeApi(undefined, apiToken, apiListen);
    const apiUrl = await api.listen();
    host = await startPaseoHost({
      node,
      home: paseoHome,
      deploymentRoot,
      listen: paseoListen,
      password: process.env.LTCOOK_PASEO_PASSWORD,
      runtimeApiUrl: apiUrl,
      userToken: apiToken,
      pluginDirectory: path.join(appRoot, 'runtime', 'dist', 'paseo-plugin'),
    });
    const workspaceShellEnvironments = new Map<string, Record<string, string>>();
    const receipt = JSON.parse(
      await fs.readFile(path.join(deploymentRoot, 'runtime.json'), 'utf8').catch(() => '{}'),
    ) as { browser_available?: boolean; browser_executable?: string };
    const backend = await createPaseoAgentBackend({
      api: host.api,
      python,
      runtimeApiUrl: apiUrl,
      piHome,
      extensionPath: path.join(appRoot, 'runtime', 'dist', 'integrations', 'pi-extension.js'),
      appNodeModules: path.join(appRoot, 'node_modules'),
      deploymentNode: node,
      browserAvailable: receipt.browser_available === true,
      browserExecutable: receipt.browser_executable,
      originalShellEnvironment(_workspace, sessionId) {
        return workspaceShellEnvironments.get(sessionId);
      },
      identity(agentId) {
        return { agentId, token: agentBearer(apiToken, agentId) };
      },
    });
    const runtimeController = createRuntime({
      databasePath,
      team,
      agents: backend,
      onEvent(event) {
        void telemetry.log('info', 'runtime.event', event);
      },
    });
    runtime = runtimeController;
    api.setRuntime(runtimeController);
    let initialSnapshot: SessionSnapshot | undefined;
    if (workspaceRoot && sessionId) {
      workspaceShellEnvironments.set(sessionId, captureShellEnvironment(process.env));
      initialSnapshot = await runtimeController.openSession({ id: sessionId, workspaceRoot });
      api.setSession(workspaceRoot, initialSnapshot.session.id);
    }
    api.setOpenWorkspaceHandler(
      teamSelection,
      async (request) => {
        const targetWorkspace = path.resolve(request.workspaceRoot);
        const shellEnvironment = { ...request.shellEnvironment };
        delete shellEnvironment.LTCOOK_SHELL_PROVENANCE;
        workspaceShellEnvironments.set(request.sessionId, shellEnvironment);
        try {
          return await runtimeController.openSession({
            id: request.sessionId,
            workspaceRoot: targetWorkspace,
          });
        } catch (error) {
          workspaceShellEnvironments.delete(request.sessionId);
          throw error;
        }
      },
      team.definition.id,
    );
    const summary = initialSnapshot
      ? `${teamSelection}, ${initialSnapshot.members.length} declared members, ` +
        `${
          initialSnapshot.members.filter(
            ({ member, binding }) => member.lifetime === 'persistent' && binding?.state === 'bound',
          ).length
        } persistent native agents connected, ${initialSnapshot.blockers.length} blockers; `
      : `${teamSelection}, no project session; `;
    process.stdout.write(`LTCook runtime ready: ${summary}Paseo ${host.listen}\n`);
    startup.end();
    await telemetry.log('info', 'runtime.ready', {
      sessionId: initialSnapshot?.session.id,
      teamId: team.definition.id,
      memberCount: initialSnapshot?.members.length ?? 0,
      connectedPersistentAgentCount:
        initialSnapshot?.members.filter(
          ({ member, binding }) => member.lifetime === 'persistent' && binding?.state === 'bound',
        ).length ?? 0,
      blockerCount: initialSnapshot?.blockers.length ?? 0,
    });
    const shutdown = async (signal: string, exitCode: number) => {
      if (stopped) return;
      stopped = true;
      await telemetry.log('info', 'runtime.shutdown', {
        signal,
        sessionId: initialSnapshot?.session.id,
      });
      await runtime?.close();
      await api?.close();
      await host?.close();
      await telemetry.exportTrace();
      process.exitCode = exitCode;
    };
    process.once('SIGINT', () => {
      void shutdown('SIGINT', 130);
    });
    process.once('SIGTERM', () => {
      void shutdown('SIGTERM', 143);
    });
    await new Promise<void>((resolve) => process.once('beforeExit', resolve));
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    await api?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    throw error;
  } finally {
    startup.end();
    await telemetry.exportTrace();
  }
}

void run().catch((error) => {
  const message =
    error instanceof Error
      ? error.message.replace(/(token|password|api.?key)=?[^\s]*/gi, '$1=<redacted>')
      : 'runtime startup failed';
  process.stderr.write(`LTCook runtime failed: ${message}\n`);
  process.exitCode = isListenAddressInUse(error) ? EX_TEMPFAIL : 1;
});

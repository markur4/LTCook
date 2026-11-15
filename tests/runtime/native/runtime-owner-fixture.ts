import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { CoordinationStore } from '../../../runtime/src/storage/coordination.js';
import { RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the native owner fixture`);
  return value;
}

async function record(event: string, instanceId: string): Promise<void> {
  const eventsPath = process.env.LTCOOK_TEST_OWNER_EVENTS;
  if (eventsPath) {
    await mkdir(path.dirname(eventsPath), { recursive: true, mode: 0o700 });
    await appendFile(eventsPath, `${JSON.stringify({ event, instanceId, pid: process.pid })}\n`, {
      mode: 0o600,
    });
  }
}

async function run(): Promise<void> {
  const deploymentRoot = path.resolve(required('LTCOOK_DEPLOYMENT_DIR'));
  const databasePath =
    required('LTCOOK_DATABASE') === ':memory:'
      ? ':memory:'
      : path.resolve(required('LTCOOK_DATABASE'));
  const paseoHome = path.resolve(required('PASEO_HOME'));
  const paseoListen = required('LTCOOK_PASEO_LISTEN');
  const telemetryLogPath = path.resolve(required('LTCOOK_LOGS'));
  const backendLogPath = process.env.LTCOOK_BACKEND_LOG_PATH
    ? path.resolve(process.env.LTCOOK_BACKEND_LOG_PATH)
    : null;
  const token = required('LTCOOK_API_TOKEN');
  const apiListen = required('LTCOOK_API_LISTEN');
  const instanceId = randomUUID();
  const api = new RuntimeApi(undefined, token, apiListen);
  const endpoint = await api.listen();
  const delay = Number(process.env.LTCOOK_TEST_READY_DELAY_MS ?? '0');
  if (Number.isFinite(delay) && delay > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
  let store: CoordinationStore;
  try {
    store = new CoordinationStore(databasePath);
  } catch (error) {
    await api.close();
    throw error;
  }
  let paseoLogPath: string;
  try {
    await mkdir(paseoHome, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(telemetryLogPath), { recursive: true, mode: 0o700 });
    await appendFile(
      telemetryLogPath,
      `${JSON.stringify({ event: 'fixture.runtime.ready', instanceId })}\n`,
      { mode: 0o600 },
    );
    const paseoDaemon = await import('@getpaseo/server/daemon-control');
    paseoLogPath = paseoDaemon.daemonLogPath(paseoHome);
    await mkdir(path.dirname(paseoLogPath), { recursive: true, mode: 0o700 });
    await appendFile(paseoLogPath, `fixture paseo ready ${instanceId}\n`, { mode: 0o600 });
    if (backendLogPath) {
      await mkdir(path.dirname(backendLogPath), { recursive: true, mode: 0o700 });
      await appendFile(backendLogPath, `fixture runtime ready ${instanceId}\n`, { mode: 0o600 });
    }
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      store.close();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      await api.close();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1)
      throw new AggregateError(failures, 'Fixture startup and cleanup failed');
    throw error;
  }
  const closeApi = api.close.bind(api);
  let shutdown: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    shutdown ??= (async () => {
      api.beginShutdown();
      try {
        store.close();
      } finally {
        await closeApi();
        await record('stopped', instanceId);
      }
    })();
    return shutdown;
  };
  api.setOpenWorkspaceHandler(async () => {
    await record('session-open', instanceId);
    throw new Error('The owner fixture does not open project Sessions');
  });
  api.setLifecycle(
    {
      instanceId,
      deploymentRoot,
      databasePath,
      paseoListen,
      backendLogPath,
      paseoLogPath,
      telemetryLogPath,
    },
    stop,
  );
  try {
    await record('acquired', instanceId);
    process.stdout.write(`fixture endpoint ready ${endpoint}\n`);
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Fixture startup and cleanup failed');
    }
    throw error;
  }
  const shutdownSignals = (): void => {
    void stop().catch((error: unknown) => {
      process.stderr.write(
        `fixture shutdown failed: ${error instanceof Error ? error.message : error}\n`,
      );
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdownSignals);
  process.once('SIGTERM', shutdownSignals);
  await new Promise<void>((resolve) => process.once('beforeExit', resolve));
}

void run().catch((error: unknown) => {
  process.stderr.write(`fixture failed: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode =
    error instanceof Error && 'code' in error && error.code === 'EADDRINUSE' ? 75 : 1;
});

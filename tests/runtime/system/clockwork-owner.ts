import path from 'node:path';
import { createRuntime } from '../../../runtime/src/core/runtime.js';
import { RuntimeApi } from '../../../runtime/src/integrations/runtime-api.js';
import team from '../../../teams/default/src/index.js';
import type {
  AgentBackend,
  RuntimeActor,
  RuntimeCommand,
} from '../../../runtime/src/workflow-api/index.js';

const [directory, listen] = process.argv.slice(2);
if (!directory || !listen || !process.send)
  throw new Error('The system owner requires its parent IPC channel');
const sessionId = 'clockwork-system';
const workspace = path.join(directory, 'workspace');
let sequence = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();
function native(method: string, args: unknown[]): Promise<unknown> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send!({ kind: 'backend', id, method, args });
  });
}
// > Only transport is adapted: the parent implements these calls with real Paseo API operations.
const backend: AgentBackend = {
  list: () => native('list', []) as ReturnType<AgentBackend['list']>,
  create: (...args) => native('create', args) as ReturnType<AgentBackend['create']>,
  inspect: (...args) => native('inspect', args) as ReturnType<AgentBackend['inspect']>,
  send: (...args) => native('send', args) as Promise<void>,
  close: (...args) => native('close', args) as Promise<void>,
};
const runtime = createRuntime({
  databasePath: path.join(directory, 'coordination.sqlite'),
  stateDirectory: path.join(directory, 'state'),
  team,
  agents: backend,
});
const api = new RuntimeApi(runtime, 'offline-system-fixture-token', listen);
let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  stopping ??= (async () => {
    await runtime.close();
    await api.close();
    process.disconnect!();
  })();
  return stopping;
}
process.on(
  'message',
  (message: {
    kind: string;
    id: number;
    value?: unknown;
    error?: string;
    actor?: RuntimeActor;
    command?: RuntimeCommand;
  }) => {
    if (message.kind === 'backend-result') {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error));
      else request?.resolve(message.value);
      return;
    }
    void (async () => {
      try {
        if (message.kind === 'stop') return await stop();
        const value =
          message.kind === 'execute'
            ? await runtime.execute(sessionId, message.actor!, message.command!)
            : undefined;
        process.send!({
          kind: 'owner-result',
          id: message.id,
          value,
          snapshot: runtime.snapshot(sessionId),
        });
      } catch (error) {
        process.send!({ kind: 'owner-result', id: message.id, error: String(error) });
      }
    })();
  },
);
process.on('SIGTERM', () => void stop());
process.on('disconnect', () => void stop());
await api.listen();
await runtime.openSession({ id: sessionId, workspaceRoot: workspace });
api.setSession(workspace, sessionId);
process.send({ kind: 'ready', snapshot: runtime.snapshot(sessionId) });

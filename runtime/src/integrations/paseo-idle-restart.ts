import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  WorkspaceNamingJobSchema,
  type WorkspaceNamingHost,
} from '../services/workspace-metadata.js';

const busy = z.object({ status: z.literal('busy'), activeTurns: z.number().int().nonnegative() });
const reply = z.discriminatedUnion('status', [
  busy,
  z.object({
    status: z.literal('ready'),
    workspaceArchive: z.literal('preserve-directory-v1').optional(),
  }),
  z.object({ status: z.literal('reserved') }),
  z.object({ status: z.literal('committed') }),
  z.object({ status: z.literal('released') }),
]);

type Busy = z.infer<typeof busy>;

export type IdleRestartReservation =
  | Busy
  | {
      status: 'reserved';
      commit(): Promise<Busy | { status: 'committed' }>;
      release(): Promise<void>;
    };

function loopbackControlUrl(listen: string): URL | undefined {
  try {
    const url = new URL(`http://${listen}`);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return;
    const host =
      url.hostname === '0.0.0.0' ? '127.0.0.1' : url.hostname === '[::]' ? '[::1]' : url.hostname;
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(host)) return;
    return new URL(`http://${host}:${url.port}/api/ltcook/idle-restart`);
  } catch {
    return undefined;
  }
}

/** Negotiate the pinned daemon's local maintenance API before advertising it to callers. */
export async function connectPaseoMaintenance(listen: string, token: string) {
  const controlUrl = loopbackControlUrl(listen);
  if (!controlUrl) return undefined;

  const request = async (operation: 'status' | 'reserve' | 'commit' | 'release', id?: string) => {
    const response = await fetch(controlUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(1800) as NonNullable<RequestInit['signal']>,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation, id }),
    });
    if (!response.ok) throw new Error('Paseo idle maintenance request failed.');
    return reply.parse(await response.json());
  };

  const ready = await request('status').catch(() => undefined);
  if (ready?.status !== 'ready') return undefined;
  const reserveIdleRestart = async (): Promise<IdleRestartReservation> => {
    const id = randomUUID();
    const result = await request('reserve', id);
    if (result.status === 'busy') return result;
    if (result.status !== 'reserved') throw new Error('Paseo did not reserve the idle window.');
    return {
      status: 'reserved',
      async commit() {
        const committed = await request('commit', id);
        if (committed.status === 'busy' || committed.status === 'committed') return committed;
        throw new Error('Paseo did not accept the reserved shutdown.');
      },
      async release() {
        await request('release', id);
      },
    };
  };
  const archiveWorkspacePreservingFiles =
    ready.workspaceArchive === 'preserve-directory-v1'
      ? async (workspaceId: string, signal?: AbortSignal): Promise<boolean> => {
          const response = await fetch(new URL('/api/ltcook/workspace-archive', controlUrl), {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.any([
              ...(signal ? [signal] : []),
              AbortSignal.timeout(30_000),
            ]) as NonNullable<RequestInit['signal']>,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId }),
          });
          if (response.status === 409) return false;
          if (!response.ok) throw new Error('Paseo directory-preserving archive is unavailable.');
          const result = z
            .strictObject({
              workspaceId: z.string(),
              archived: z.boolean(),
              preservedDirectory: z.literal(true),
            })
            .parse(await response.json());
          if (result.workspaceId !== workspaceId)
            throw new Error('Paseo archived a different workspace.');
          return result.archived;
        }
      : undefined;
  return { reserveIdleRestart, archiveWorkspacePreservingFiles };
}

export async function connectPaseoWorkspaceNaming(
  listen: string,
  token: string,
): Promise<WorkspaceNamingHost | undefined> {
  const controlUrl = loopbackControlUrl(listen);
  if (!controlUrl) return undefined;
  const url = new URL('/api/ltcook/workspace-naming', controlUrl);
  const request = async (body: object, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(5_000),
      ]) as NonNullable<RequestInit['signal']>,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('Paseo workspace naming is unavailable.');
    return response.json();
  };
  const status = z
    .object({ workspaceNaming: z.literal(true) })
    .safeParse(await request({ operation: 'status' }).catch(() => undefined));
  if (!status.success) return undefined;
  return {
    async pending(workspaceId, signal) {
      const { jobs } = z
        .object({ jobs: z.array(WorkspaceNamingJobSchema) })
        .parse(await request({ operation: 'pending', workspaceId }, signal));
      if (jobs.some((job) => job.workspaceId !== workspaceId))
        throw new Error('Paseo returned naming jobs for a different workspace.');
      return jobs;
    },
    async apply({ workspaceId, agentId, id }, titles, signal) {
      const { applied } = z
        .object({ applied: z.boolean() })
        .parse(await request({ operation: 'apply', workspaceId, agentId, id, ...titles }, signal));
      return applied;
    },
  };
}

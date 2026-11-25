import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const busy = z.object({ status: z.literal('busy'), activeTurns: z.number().int().nonnegative() });
const reply = z.discriminatedUnion('status', [
  busy,
  z.object({ status: z.literal('ready') }),
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
export async function connectIdleRestart(listen: string, token: string) {
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
  return async (): Promise<IdleRestartReservation> => {
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
}

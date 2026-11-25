import { timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const idleRestartPath = '/api/ltcook/idle-restart';
const reservationMs = 30_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createIdleRestartGate(now = () => performance.now()) {
  let reservation;
  let admittedOperations = 0;

  function currentReservation() {
    if (reservation && !reservation.committed && now() >= reservation.expiresAt) {
      reservation = undefined;
    }
    return reservation;
  }

  function assertOpen() {
    if (currentReservation()) {
      throw new Error('Paseo is reserved for an LTCook restart. Try again after the restart.');
    }
  }

  async function run(operation) {
    assertOpen();
    admittedOperations++;
    try {
      return await operation();
    } finally {
      admittedOperations--;
    }
  }

  async function* stream(operation) {
    assertOpen();
    admittedOperations++;
    try {
      yield* operation();
    } finally {
      admittedOperations--;
    }
  }

  function transition(operation, id, countActiveTurns) {
    const current = currentReservation();
    if (operation === 'release') {
      if (current?.id === id && !current.committed) reservation = undefined;
      return { status: 'released' };
    }
    if (current?.id === id && current.committed) return { status: 'committed' };
    if (current && current.id !== id) return { status: 'unavailable' };
    if (operation === 'commit' && !current) return { status: 'unavailable' };
    const activeTurns = Math.max(countActiveTurns(), admittedOperations > 0 ? 1 : 0);
    if (activeTurns > 0) {
      reservation = undefined;
      return { status: 'busy', activeTurns };
    }
    if (operation === 'reserve') {
      reservation ??= { id, expiresAt: now() + reservationMs, committed: false };
      return { status: 'reserved' };
    }
    current.committed = true;
    return { status: 'committed', dispatch: true };
  }

  return { assertOpen, run, stream, transition, isReserved: () => Boolean(currentReservation()) };
}

export const idleRestart = createIdleRestartGate();

export function authorizeIdleRestart(isLoopback, token) {
  const expected = token ? Buffer.from(`Bearer ${token}`) : undefined;
  return (request, response, next) => {
    const authorization = request.headers.authorization;
    if (expected && isLoopback(request.socket.remoteAddress) && typeof authorization === 'string') {
      const candidate = Buffer.from(authorization);
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
        next();
        return;
      }
    }
    response.status(403).json({ error: 'Forbidden' });
  };
}

export function idleRestartHandler(countActiveTurns, dispatchShutdown) {
  return (request, response) => {
    if (!dispatchShutdown) {
      response.status(503).json({ status: 'unavailable' });
      return;
    }
    const { operation, id } = request.body ?? {};
    if (operation === 'status') {
      response.json({ status: 'ready' });
      return;
    }
    if (
      !['reserve', 'release', 'commit'].includes(operation) ||
      typeof id !== 'string' ||
      !uuid.test(id)
    ) {
      response.status(400).json({ error: 'Invalid idle restart request' });
      return;
    }
    const { dispatch, ...result } = idleRestart.transition(operation, id, countActiveTurns);
    if (dispatch) {
      const stop = () => {
        response.off('finish', stop);
        response.off('close', stop);
        dispatchShutdown({
          type: 'shutdown',
          clientId: 'ltcook-runtime',
          requestId: id,
          reason: 'ltcook_idle_restart',
          keepTerminals: false,
        });
      };
      response.once('finish', stop);
      response.once('close', stop);
    }
    response.status(result.status === 'unavailable' ? 409 : 200).json(result);
  };
}

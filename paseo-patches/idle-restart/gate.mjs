import { randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const idleRestartPath = '/api/ltcook/idle-restart';
export const workspaceArchivePath = '/api/ltcook/workspace-archive';
export const workspaceArchiveRequestPrefix = 'ltcook-preserve-workspace-';
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
      throw new Error('Paseo is reserved for LTCook maintenance. Try again after it completes.');
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

  function reserveMaintenance(countActiveTurns) {
    if (currentReservation() || admittedOperations > 0) return undefined;
    const activeTurns = countActiveTurns();
    if (!Number.isFinite(activeTurns) || activeTurns !== 0) return undefined;
    // Unlike a restart handoff, this operation lives in this process and always
    // releases in finally. Expiring its lease during an await would admit a new
    // prompt halfway through archiving that prompt's session.
    const current = { id: randomUUID(), expiresAt: Infinity, committed: false };
    reservation = current;
    return () => {
      if (reservation === current) reservation = undefined;
    };
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

  return {
    assertOpen,
    run,
    stream,
    transition,
    reserveMaintenance,
    isReserved: () => Boolean(currentReservation()),
  };
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

export function idleRestartHandler(countActiveTurns, dispatchShutdown, capabilities = {}) {
  return (request, response) => {
    if (!dispatchShutdown) {
      response.status(503).json({ status: 'unavailable' });
      return;
    }
    const { operation, id } = request.body ?? {};
    if (operation === 'status') {
      response.json({
        status: 'ready',
        ...(capabilities.workspaceArchive === 'preserve-directory-v1'
          ? { workspaceArchive: 'preserve-directory-v1' }
          : {}),
      });
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

export class WorkspaceArchiveBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceArchiveBlockedError';
  }
}

// Only the hash-verified bootstrap registers this route. A capability probe from
// an earlier daemon is never authority to archive through an unpatched daemon.
export function workspaceArchiveHandler({
  getWorkspace,
  isSetupRunning,
  listTerminals,
  countActiveTurns,
  archiveWorkspace,
}) {
  return async (request, response) => {
    const body = request.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof body.workspaceId !== 'string' ||
      !body.workspaceId.trim() ||
      body.workspaceId.length > 512
    ) {
      response.status(400).json({ error: 'Invalid workspace archive request' });
      return;
    }
    const { workspaceId } = body;
    let release;
    try {
      release = idleRestart.reserveMaintenance(countActiveTurns);
      if (!release) {
        throw new WorkspaceArchiveBlockedError('Paseo has active or pending work');
      }
      const archived = await (async () => {
        let workspace = await getWorkspace(workspaceId);
        if (!workspace || workspace.archivedAt) return false;
        const assertEligible = () => {
          if (workspace.pinnedAt) throw new WorkspaceArchiveBlockedError('Workspace is pinned');
          if (isSetupRunning(workspaceId)) {
            throw new WorkspaceArchiveBlockedError('Workspace setup is running');
          }
        };
        assertEligible();
        if ((await listTerminals(workspaceId)).length > 0) {
          throw new WorkspaceArchiveBlockedError('Workspace has open terminals');
        }
        // Re-read after asynchronous terminal enumeration; a new pin wins.
        workspace = await getWorkspace(workspaceId);
        if (!workspace || workspace.archivedAt) return false;
        assertEligible();
        const activeTurns = countActiveTurns();
        if (!Number.isFinite(activeTurns) || activeTurns !== 0) {
          throw new WorkspaceArchiveBlockedError('Paseo has active or pending agent work');
        }
        const result = await archiveWorkspace(
          workspaceId,
          `${workspaceArchiveRequestPrefix}${randomUUID()}`,
        );
        if (result.removedDirectory !== false || !Array.isArray(result.archivedWorkspaceIds)) {
          throw new Error('Unexpected preserving workspace archive result');
        }
        return result.archivedWorkspaceIds.includes(workspaceId);
      })();
      response.json({ archived, workspaceId, preservedDirectory: true });
    } catch (error) {
      response.status(error instanceof WorkspaceArchiveBlockedError ? 409 : 500).json({
        error:
          error instanceof WorkspaceArchiveBlockedError
            ? error.message
            : 'Failed to archive workspace while preserving its directory',
      });
    } finally {
      release?.();
    }
  };
}

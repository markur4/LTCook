import { expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  RepositoryIndexError,
  RepositoryIndexService,
  type RepositoryIndexDiagnostic,
} from '../../../runtime/src/services/repository-index.js';
import { openRepositoryWorkspace } from '../../../runtime/src/repository/workspace.js';

async function withWorkspace(
  operation: (workspace: Awaited<ReturnType<typeof openRepositoryWorkspace>>) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ltcook-index-service-')));
  try {
    await operation(await openRepositoryWorkspace(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(message);
}

test('coalesces requests during a build into one follow-up reconciliation', () =>
  withWorkspace(async (workspace) => {
    const gates = [deferred(), deferred()];
    const started = [deferred(), deferred()];
    let calls = 0;
    const service = new RepositoryIndexService(
      async (_authorizedWorkspace, signal) => {
        const call = calls++;
        started[call]?.resolve();
        await Promise.race([
          gates[call]?.promise,
          new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true })),
        ]);
      },
      { reconcileMs: 20 },
    );
    const release = service.activate(workspace);

    try {
      await started[0]?.promise;
      await Bun.sleep(25);
      service.request(workspace);
      service.request(workspace);
      service.request(workspace);
      gates[0]?.resolve();
      await started[1]?.promise;
      await Bun.sleep(25);
      service.request(workspace);
      service.request(workspace);
      gates[1]?.resolve();
      await service.close();
      expect(calls).toBe(2);
    } finally {
      release();
      await service.close();
    }
  }));

test('pausing checkpoints the current job and resuming queues the authorized worktree', () =>
  withWorkspace(async (workspace) => {
    const firstStarted = deferred();
    const resumed = deferred();
    let calls = 0;
    const service = new RepositoryIndexService(async (_authorizedWorkspace, signal) => {
      calls++;
      if (calls === 1) {
        firstStarted.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', resolve, { once: true }),
        );
      } else {
        resumed.resolve();
      }
    });
    const release = service.activate(workspace);

    try {
      await firstStarted.promise;
      service.setEnabled(false);
      expect(service.status(workspace)).toEqual({ activity: 'paused', diagnostic: null });
      service.setEnabled(true);
      await resumed.promise;
      expect(calls).toBe(2);
    } finally {
      release();
      await service.close();
    }
  }));

test('retries transient failures and reports a permanent error without a retry time', () =>
  withWorkspace(async (workspace) => {
    const retried = deferred();
    let calls = 0;
    const service = new RepositoryIndexService(
      async () => {
        if (calls++ === 0) throw new RepositoryIndexError('Temporary cache lock.', true);
        retried.resolve();
      },
      { reconcileMs: 10_000, retryInitialMs: 20, retryMaximumMs: 20 },
    );
    const release = service.activate(workspace);

    try {
      await waitFor(
        () => service.status(workspace).activity === 'retrying',
        'The transient indexing error was not reported.',
      );
      expect(service.status(workspace)).toMatchObject({
        activity: 'retrying',
        diagnostic: 'Temporary cache lock.',
        retryAt: expect.any(String),
      });
      await retried.promise;
    } finally {
      release();
      await service.close();
    }
  }));

test('releasing the final authorization stops that worktree job', () =>
  withWorkspace(async (workspace) => {
    const started = deferred();
    const cancelled = deferred();
    const service = new RepositoryIndexService(async (_authorizedWorkspace, signal) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', resolve, { once: true }),
      );
      cancelled.resolve();
    });
    const release = service.activate(workspace);

    try {
      await started.promise;
      release();
      await cancelled.promise;
      expect(service.status(workspace)).toEqual({ activity: 'idle', diagnostic: null });
    } finally {
      await service.close();
    }
  }));

test('reports one stalled operation and correlates its eventual completion', () =>
  withWorkspace(async (workspace) => {
    const releaseBuild = deferred();
    const events: RepositoryIndexDiagnostic[] = [];
    const service = new RepositoryIndexService(() => releaseBuild.promise, {
      progressDeadlineMs: 20,
      reconcileMs: 10_000,
      onDiagnostic: (event) => {
        events.push(event);
      },
    });
    service.activate(workspace);

    try {
      await waitFor(
        () => events.length > 0,
        'The pending indexing operation did not report a stall.',
      );
      expect(events).toEqual([
        expect.objectContaining({
          code: 'repository-index.stalled',
          severity: 'error',
          outcome: 'incomplete',
          operationId: expect.any(String),
          workspaceId: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]);
      expect(service.status(workspace)).toEqual({
        activity: 'indexing',
        diagnostic: 'Repository indexing exceeded its progress deadline.',
      });

      releaseBuild.resolve();
      await waitFor(() => events.length > 1, 'The completed operation was not reported.');
      expect(events.map(({ operationId }) => operationId)).toEqual([
        events[0]?.operationId,
        events[0]?.operationId,
      ]);
      expect(events[1]).toMatchObject({ code: 'repository-index.completed', outcome: 'success' });
    } finally {
      releaseBuild.resolve();
      await service.close();
    }
  }));

test('separates writer contention, a later failure, and an expected cancellation', () =>
  withWorkspace(async (workspace) => {
    const events: RepositoryIndexDiagnostic[] = [];
    const failure = new Error('Index storage unavailable');
    const thirdStarted = deferred();
    let attempts = 0;
    const service = new RepositoryIndexService(
      async (_workspace, signal) => {
        attempts++;
        if (attempts === 1) {
          throw new RepositoryIndexError('Waiting for another writer.', true, undefined, 'blocked');
        }
        if (attempts === 2) throw failure;
        thirdStarted.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', resolve, { once: true }),
        );
      },
      {
        retryInitialMs: 20,
        retryMaximumMs: 20,
        onDiagnostic: (event) => {
          events.push(event);
        },
      },
    );
    const release = service.activate(workspace);

    try {
      await thirdStarted.promise;
      release();
      await service.close();
      expect(events).toEqual([
        expect.objectContaining({ code: 'repository-index.blocked', outcome: 'blocked' }),
        expect.objectContaining({
          code: 'repository-index.retrying',
          outcome: 'failure',
          cause: failure,
        }),
        expect.objectContaining({ code: 'repository-index.cancelled', outcome: 'cancelled' }),
      ]);
      expect(new Set(events.map(({ operationId }) => operationId)).size).toBe(3);
      expect(new Set(events.map(({ workspaceId }) => workspaceId)).size).toBe(1);
    } finally {
      await service.close();
    }
  }));

import { expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  RepositoryIndexError,
  RepositoryIndexService,
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

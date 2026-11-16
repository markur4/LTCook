import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fileSystem from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EvalRunService,
  type EvalEngine,
  type EvalBudget,
} from '../../../runtime/src/evals/service.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function service(engine: EvalEngine) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ltcook-checkpoints-'));
  roots.push(root);
  const instance = new EvalRunService(root, engine);
  await instance.initialize();
  return { root, instance };
}
async function finished(instance: EvalRunService, id: string) {
  for (let i = 0; i < 100; i++) {
    if ((await instance.status(id)).summary.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Checkpoint test did not complete');
}

for (const mode of ['failure', 'cancellation'] as const) {
  test(`retains sanitized results and trace after ${mode} and restart`, async () => {
    let ready!: () => void;
    const checkpointed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const { root, instance } = await service(async ({ checkpoint, signal }) => {
      await checkpoint!({
        result: {
          attempts: [
            {
              success: false,
              effectivePrompt: 'private prompt',
              failure: 'Provider rejected Bearer fixture-credential',
            },
          ],
        },
        trace: { traceEvents: [{ name: 'model' }] },
      });
      ready();
      if (mode === 'cancellation')
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      throw new Error('Observed test failure');
    });
    const id = await instance.start({ preset: 'behavior', setup: 'synthetic' });
    await checkpointed;
    if (mode === 'cancellation') await instance.cancel(id);
    await finished(instance, id);
    const report = instance.report(id);
    expect(report.summary.status).toBe(mode === 'failure' ? 'failed' : 'cancelled');
    expect(report.result).toEqual({
      attempts: [{ success: false, failure: 'Provider rejected Bearer <redacted>' }],
    });
    expect(report.trace).toEqual({ traceEvents: [{ name: 'model' }] });
    const restarted = new EvalRunService(root, async () => {
      throw new Error('Must not rerun');
    });
    await restarted.initialize();
    expect(restarted.report(id)).toEqual(report);
  });
}

test('restart does not count progress newer than the last complete evidence checkpoint', async () => {
  const { root, instance } = await service(async ({ progress, checkpoint }) => {
    progress({ event: 'case.completed', suite: 'behavior', completed: 1, total: 3 });
    await checkpoint!({ result: { cases: [1] }, trace: { traceEvents: [1] } });
    progress({ event: 'case.completed', suite: 'behavior', completed: 2, total: 3 });
    throw new Error('Simulated interruption after progress but before evidence checkpoint');
  });
  const id = await instance.start({ preset: 'behavior', setup: 'synthetic' });
  await finished(instance, id);
  const summaryFile = path.join(root, 'evals/runs', id, 'run.json');
  const summary = JSON.parse(await readFile(summaryFile, 'utf8'));
  await writeFile(summaryFile, JSON.stringify({ ...summary, status: 'running' }));
  const disposable = path.join(path.dirname(summaryFile), '.execution-interrupted');
  await mkdir(disposable);
  await writeFile(path.join(disposable, 'output.json'), 'private unfinished prompt');
  await writeFile(path.join(path.dirname(summaryFile), 'retained-note.txt'), 'preserve');
  const restarted = new EvalRunService(root, async () => {
    throw new Error('Must not replay');
  });
  await restarted.initialize();
  expect(restarted.report(id)).toMatchObject({
    summary: { status: 'interrupted', completed: 1 },
    result: { cases: [1] },
    trace: { traceEvents: [1] },
  });
  expect(await readdir(path.dirname(summaryFile))).not.toContain('.execution-interrupted');
  expect(await readFile(path.join(path.dirname(summaryFile), 'retained-note.txt'), 'utf8')).toBe(
    'preserve',
  );
});

test('restart reports failed disposable cleanup and retries it without replaying a terminal run', async () => {
  const { root, instance } = await service(async () => {
    throw new Error('Fixture failed');
  });
  const id = await instance.start({ preset: 'behavior', setup: 'synthetic' });
  await finished(instance, id);
  const disposable = path.join(root, 'evals/runs', id, '.execution-residue');
  await mkdir(disposable);
  await writeFile(path.join(disposable, 'output.json'), 'private unfinished prompt');
  const remove = fileSystem.rm;
  const failure = spyOn(fileSystem, 'rm').mockImplementation(async (target, options) => {
    if (target === disposable) throw new Error('EACCES: private cleanup denied');
    return remove(target, options);
  });
  const restarted = new EvalRunService(root, async () => {
    throw new Error('Must not replay');
  });
  try {
    await restarted.initialize();
    expect(restarted.report(id).summary).toMatchObject({
      status: 'failed',
      limitations: ['Disposable evaluation state cleanup failed: EACCES: private cleanup denied'],
    });
  } finally {
    failure.mockRestore();
  }
  await restarted.initialize();
  expect(await readdir(path.dirname(disposable))).not.toContain('.execution-residue');
});

test('uses last five comparable successes and separates failed, reasoning, and unverified samples', async () => {
  const identity = {
    scenario: 'read-only',
    thinking: 'off' as const,
    provenanceKey: 'verified-fixture-device',
  };
  const observed: EvalBudget[] = [];
  let duration = 100;
  let success = true;
  const engine: EvalEngine = async ({ budget, learned, checkpoint }) => {
    observed.push(budget!(identity));
    expect(budget!({ ...identity, thinking: 'low' }).expectedMs).toBeNull();
    expect(budget!({ ...identity, provenanceKey: 'unverified:device' }).expectedMs).toBeNull();
    await learned!(identity, { elapsedMs: duration, success });
    const output = { result: { success }, trace: { traceEvents: [] } };
    await checkpoint!(output);
    return output;
  };
  const { root, instance } = await service(engine);
  for (const value of [100, 10, 20, 30, 40, 50]) {
    duration = value;
    const id = await instance.start({ preset: 'behavior', setup: 'synthetic' });
    await finished(instance, id);
  }
  expect(observed[0]).toEqual({ timeoutMs: 120000, expectedMs: null, referenceRuns: [] });
  expect(observed[1]!.timeoutMs).toBe(300);
  const restarted = new EvalRunService(root, engine);
  await restarted.initialize();
  duration = 99999;
  success = false;
  let id = await restarted.start({ preset: 'behavior', setup: 'synthetic' });
  await finished(restarted, id);
  expect(observed.at(-1)!.timeoutMs).toBe(150);
  id = await restarted.start({ preset: 'behavior', setup: 'synthetic' });
  await finished(restarted, id);
  expect(observed.at(-1)!.timeoutMs).toBe(150);
  expect(observed.at(-1)!.referenceRuns).toHaveLength(5);
});

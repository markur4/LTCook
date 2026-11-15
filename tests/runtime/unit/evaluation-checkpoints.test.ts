import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  throw new Error('Symbolic checkpoint test did not complete');
}

test.each(['failure', 'cancellation'] as const)(
  'retains sanitized results and trace after %s and restart',
  async (mode) => {
    let ready!: () => void;
    const checkpointed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const { root, instance } = await service(async ({ checkpoint, signal }) => {
      await checkpoint!({
        result: { attempts: [{ success: false, effectivePrompt: 'private prompt' }] },
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
    expect(report.result).toEqual({ attempts: [{ success: false }] });
    expect(report.trace).toEqual({ traceEvents: [{ name: 'model' }] });
    const restarted = new EvalRunService(root, async () => {
      throw new Error('Must not rerun');
    });
    await restarted.initialize();
    expect(restarted.report(id)).toEqual(report);
  },
);

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
  const restarted = new EvalRunService(root, async () => {
    throw new Error('Must not replay');
  });
  await restarted.initialize();
  expect(restarted.report(id)).toMatchObject({
    summary: { status: 'interrupted', completed: 1 },
    result: { cases: [1] },
    trace: { traceEvents: [1] },
  });
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

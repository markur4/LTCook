import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decisionTrackerFixtures } from '../../../runtime/src/evals/decision-tracker-fixtures.js';
import {
  gradeDecisionTrackerCase,
  summarizeDecisionTrackerGrades,
} from '../../../runtime/src/evals/decision-tracker-grading.js';
import { runDecisionTrackerCase } from '../../../runtime/src/evals/decision-tracker.js';
import { createEvalEngine } from '../../../runtime/src/evals/engine.js';
import { EvalRunService } from '../../../runtime/src/evals/service.js';
import { trackerGapReasons } from '../../../runtime/src/paseo-plugin/client/tracker-presentation.js';

async function isolated(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'decision-tracker-eval-test-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('reports an AE failure for the real budget gap and retains pending work across reopen', () =>
  isolated(async (directory) => {
    const result = await runDecisionTrackerCase(
      {
        id: 'oversized-user',
        title: 'An oversized user message followed by a decision',
        mode: 'deterministic',
        expectedDecisions: [],
        steps: [
          {
            messages: [
              { seq: 1, author: 'user', text: 'Keep production in Europe. '.repeat(2000) },
              { seq: 2, author: 'user', text: 'Use separate credentials.' },
            ],
            expect: { coverage: { 1: 'changes', 2: 'changes' } },
          },
          { action: 'reopen' },
        ],
      },
      { directory, inputTokens: 8000, signal: new AbortController().signal },
    );

    expect(result.verdict).toBe('failed');
    expect(result.failureStage).toBe('token-budgeting');
    expect(result.budgetMessage).toBe(trackerGapReasons.budget);
    expect(result.checkpoints).toHaveLength(2);
    for (const checkpoint of result.checkpoints) {
      expect(checkpoint.events).toEqual([
        { seq: 1, status: 'incomplete', reason: 'budget' },
        { seq: 2, status: 'pending', reason: undefined },
      ]);
      expect(checkpoint.cursor).toBe(2);
      expect(checkpoint.requests).toBe(0);
      expect(checkpoint.items).toEqual([]);
      expect(checkpoint.revisions).toEqual([]);
    }
  }));

async function settled(service: EvalRunService, runId: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if ((await service.status(runId)).summary.status !== 'running') return service.report(runId);
    await delay(10);
  }
  throw new Error('Agent Evals service did not finish within the test deadline.');
}

test('deterministic suite dispatches through the shared engine and persists the qualification', () =>
  isolated(async (directory) => {
    const service = new EvalRunService(
      directory,
      createEvalEngine({ resources: path.resolve('runtime/resources') }),
    );
    await service.initialize();
    const runId = await service.start({
      setup: 'synthetic',
      preset: 'behavior',
      scenario: 'decision-tracker',
      deterministicOnly: true,
    });
    const report = await settled(service, runId);
    expect(report.summary.status).toBe('completed');
    expect(report.summary.decisionTrackerQualification).toBe('failed');
    expect(report.result).toMatchObject({
      results: { 'decision-tracker': { verdict: 'failed' } },
    });
    const reopened = new EvalRunService(directory, async () => {
      throw new Error('Reading an existing decision-tracker report must not run a model.');
    });
    await reopened.initialize();
    expect((await reopened.report(runId)).result).toEqual(report.result);
  }));

test('the service deadline preserves a confirmed failure in a partial checkpoint', () =>
  isolated(async (directory) => {
    const service = new EvalRunService(directory, async ({ signal, checkpoint }) => {
      await checkpoint?.({
        metadata: { decisionTrackerQualification: 'failed' },
        result: { results: { 'decision-tracker': { verdict: 'failed' } } },
        trace: null,
      });
      await delay(10_000, undefined, { signal });
      throw new Error('The service must abort the active run.');
    });
    await service.initialize();
    const runId = await service.start({
      setup: 'synthetic',
      preset: 'full',
      scenario: 'decision-tracker',
      deadlineAt: Date.now() + 50,
    });
    const report = await settled(service, runId);
    expect(report.summary.status).toBe('cancelled');
    expect(report.summary.decisionTrackerQualification).toBe('failed');
    expect(report.result).toMatchObject({
      results: { 'decision-tracker': { verdict: 'failed' } },
    });
    const summaryPath = path.join(directory, 'evals/runs', runId, 'run.json');
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    delete summary.decisionTrackerQualification;
    summary.status = 'running';
    await writeFile(summaryPath, JSON.stringify(summary));
    const restarted = new EvalRunService(directory, async () => {
      throw new Error('An interrupted run may only restore persisted evidence.');
    });
    await restarted.initialize();
    expect(restarted.report(runId).summary).toMatchObject({
      status: 'interrupted',
      decisionTrackerQualification: 'failed',
    });
  }));

test('a plausible stored item fails when required proposal evidence was excluded', () =>
  isolated(async (directory) => {
    const fixture = decisionTrackerFixtures.find(
      ({ id }) => id === 'budget-plausible-item-missing-proposal-evidence',
    );
    if (!fixture) throw new Error('Missing the required evidence regression fixture');
    const result = await runDecisionTrackerCase(fixture, {
      directory,
      inputTokens: 8000,
      signal: new AbortController().signal,
    });
    expect(result.checkpoints.at(-1)?.items).toHaveLength(1);
    expect(result.verdict).toBe('failed');
    expect(result.failureStage).toBe('evidence-selection');
    expect(result.checks).toContainEqual(
      expect.objectContaining({ verdict: 'failed', stage: 'evidence-selection' }),
    );
  }));

test('semantic metrics exclude grading with a fabricated source quotation', async () => {
  const text = 'Keep the release artifacts in Europe.';
  const decision = { alias: 'region', kind: 'explicit' as const, sources: [1], facts: [text] };
  function assess(quote: string) {
    return gradeDecisionTrackerCase(
      async () =>
        JSON.stringify({
          decisions: [
            {
              alias: 'region',
              verdict: 'preserved',
              matchedItemIds: ['item-1'],
              facts: [
                {
                  factIndex: 0,
                  verdict: 'preserved',
                  itemEvidence: [{ itemId: 'item-1', quote: text }],
                  sourceEvidence: [{ seq: 1, quote }],
                },
              ],
            },
          ],
          items: [
            {
              itemId: 'item-1',
              verdict: 'supported',
              decisionAliases: ['region'],
              itemQuote: text,
              sourceEvidence: [{ seq: 1, quote }],
            },
          ],
        }),
      {
        fixture: {
          id: 'region',
          title: 'A grounded decision',
          mode: 'live',
          steps: [{ messages: [{ seq: 1, author: 'user', text }] }],
          expectedDecisions: [decision],
        },
        items: [{ id: 'item-1', text, sources: [1] }],
        requests: [{ seq: 1, evidence: [1], sent: true }],
        signal: new AbortController().signal,
      },
    );
  }
  const supported = await assess(text);
  const fabricated = await assess('Move the release artifacts to North America.');
  expect(supported.status).toBe('passed');
  expect(fabricated.status).toBe('blocked');
  const summary = summarizeDecisionTrackerGrades([supported, fabricated], 2);
  expect(summary.status).toBe('blocked');
  expect(summary.blocked).toBe(1);
  expect(summary.metrics.explicitRecall).toEqual({ numerator: 1, denominator: 1, rate: 1 });
});

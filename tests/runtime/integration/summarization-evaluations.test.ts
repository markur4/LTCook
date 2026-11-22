import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEvalEngine } from '../../../runtime/src/evals/engine.js';
import { EvalRunService } from '../../../runtime/src/evals/service.js';
import { EVAL_MODEL } from '../../../runtime/src/evals/setup.js';
import {
  SUMMARY_MAX_INPUT_BYTES,
  summaryInputLimit,
} from '../../../runtime/src/tools/summarize.js';
import type { SummarizationReport } from '../../../runtime/src/evals/summarization.js';
import {
  CORE_SUMMARIZATION_CASES,
  DOWNSTREAM_CASE,
  fullSummarizationCases,
  NEAR_LIMIT_FOCUS,
  REPEAT_SUMMARIZATION_CASES,
  SUMMARIZATION_CALIBRATION,
  type SummarizationCase,
} from '../../../runtime/src/evals/summarization-fixtures.js';

const candidate = 'summary-candidate:latest';
const profile = {
  think: false,
  stream: false as const,
  options: { num_ctx: 4096, num_predict: 128, temperature: 0.1 },
};
const profileLimit = summaryInputLimit(profile, NEAR_LIMIT_FOCUS);
const wrongDecisionSummary =
  'Ada approved read-only smoke checks. Inez approved the production rollout.';

function scriptedGrade(fixture: SummarizationCase, summary: string) {
  const calibration = SUMMARIZATION_CALIBRATION.find((item) => item.summary === summary);
  const expected: Record<string, string> =
    calibration?.expected ?? (summary === wrongDecisionSummary ? { decision: 'contradicted' } : {});
  const sample = summary.slice(0, 36);
  const facts = fixture.facts.map(({ id, sourceQuote }) => ({
    id,
    verdict: expected[id] ?? 'preserved',
    sourceQuote,
    summaryQuote: expected[id] === 'missing' ? null : sample,
  }));
  return {
    facts,
    claims: [
      {
        verdict: Object.values(expected).includes('contradicted') ? 'contradicted' : 'supported',
        sourceQuote: fixture.facts[0]!.sourceQuote,
        summaryQuote: sample,
      },
      ...(calibration?.unsupported
        ? [
            {
              verdict: 'unsupported',
              sourceQuote: null,
              summaryQuote: 'The incident cost $50,000.',
            },
          ]
        : []),
    ],
  };
}

async function runFixture(
  mode:
    | 'pass'
    | 'self-grading'
    | 'unavailable-grader'
    | 'bad-calibration'
    | 'blocked'
    | 'decision'
    | 'profile',
) {
  const fixtures = [
    ...CORE_SUMMARIZATION_CASES,
    ...fullSummarizationCases(mode === 'profile' ? profileLimit : SUMMARY_MAX_INPUT_BYTES),
    DOWNSTREAM_CASE,
  ];
  const findFixture = (source: string, focus?: string) =>
    fixtures.find((item) => item.source === source && item.focus === focus)!;
  const root = await mkdtemp(path.join(os.tmpdir(), 'ltcook-summary-eval-'));
  let graderCalls = 0;
  let decisionCalls = 0;
  const sources: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/tags') {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            models: [
              { name: candidate, digest: 'candidate-digest' },
              ...(mode === 'unavailable-grader'
                ? []
                : [{ name: EVAL_MODEL, digest: 'grader-digest' }]),
            ],
          }),
        );
        return;
      }
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      if (request.url === '/api/show') {
        const usesCandidateWeights = input.model === candidate || mode === 'self-grading';
        response.end(
          JSON.stringify({
            modelfile: 'FROM sha256-' + (usesCandidateWeights ? 'a' : 'b').repeat(64),
          }),
        );
        return;
      }
      if (request.url === '/v1/chat/completions') {
        decisionCalls++;
        const answer = mode === 'decision' && decisionCalls === 1 ? 'PROCEED' : 'HOLD';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, reason] of [
          [{ role: 'assistant', content: answer }, null],
          [{}, 'stop'],
        ]) {
          const event = {
            id: 'decision-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: EVAL_MODEL,
            choices: [{ index: 0, delta, finish_reason: reason }],
          };
          response.write('data: ' + JSON.stringify(event) + '\n\n');
        }
        response.end('data: [DONE]\n\n');
        return;
      }
      if (request.url !== '/api/chat') throw new Error('Unexpected Ollama route.');
      let content: string;
      if (input.model === candidate) {
        if (mode === 'profile') {
          expect({
            think: input.think,
            stream: input.stream,
            options: input.options,
          }).toEqual(profile);
        }
        const material = String(input.messages[1].content);
        const hasFocus = material.startsWith('Focus: ');
        const [header, ...parts] = hasFocus ? material.split('\n\nMaterial:\n') : ['', material];
        const source = parts.join('\n\nMaterial:\n');
        const fixture = findFixture(source, hasFocus ? header!.slice(7) : undefined);
        if (!fixture) throw new Error('Unexpected summarization input.');
        sources.push(fixture.id);
        content = source;
        if (mode === 'self-grading' && fixture.id === 'migration-failure')
          content = 'M-04 failed with exit code 23.';
        if (mode === 'decision' && fixture === DOWNSTREAM_CASE) content = wrongDecisionSummary;
      } else if (input.model === EVAL_MODEL) {
        graderCalls++;
        const data = JSON.parse(input.messages[1].content);
        const fixture = findFixture(data.source, data.focus);
        if (mode === 'blocked' || (mode === 'bad-calibration' && graderCalls === 2)) content = '{}';
        else content = JSON.stringify(scriptedGrade(fixture, data.summary));
      } else throw new Error('Unexpected Ollama model.');
      response.end(
        JSON.stringify({
          model: input.model,
          done: true,
          done_reason: 'stop',
          message: { content },
          ...(mode === 'pass' ? {} : { prompt_eval_count: 124, eval_count: 20 }),
        }),
      );
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No Ollama fixture address.');
  const service = new EvalRunService(
    root,
    createEvalEngine({
      resources: root,
      summarization: {
        endpoint: 'http://127.0.0.1:' + address.port,
        model: candidate,
        keepAlive: 0,
        ...(mode === 'profile' ? { generation: JSON.stringify(profile) } : {}),
      },
    }),
  );
  try {
    await service.initialize();
    const runId = await service.start({
      preset: mode === 'decision' || mode === 'profile' ? 'full' : 'behavior',
      scenario: 'summarization',
      setup: 'synthetic',
    });
    for (let i = 0; i < 1000; i++) {
      const status = await service.status(runId);
      if (
        status.summary.status !== 'running' &&
        status.events.some(({ event }) => event === 'run.completed')
      ) {
        const stored = service.report(runId);
        const result = stored.result as { results: { summarization: SummarizationReport } };
        const copy = new EvalRunService(root, async () => ({ result: null, trace: null }));
        await copy.initialize();
        expect(copy.report(runId)).toEqual(stored);
        return {
          status,
          report: result.results.summarization,
          graderCalls,
          sources,
          decisionCalls,
        };
      }
      await Bun.sleep(5);
    }
    throw new Error(
      'The summarization evaluation did not finish: ' + JSON.stringify(service.report(runId)),
    );
  } finally {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

test('existing Behavior Evaluation service returns a passing verdict with optional token counts absent', async () => {
  const { status, report, sources, graderCalls } = await runFixture('pass');
  expect(status.summary).toMatchObject({
    status: 'completed',
    summarizationQualification: 'passed',
    total: 1,
  });
  expect(report).toMatchObject({ scope: 'core', verdict: 'passed', complete: true, blockers: [] });
  expect(sources).toEqual(CORE_SUMMARIZATION_CASES.map(({ id }) => id));
  expect(graderCalls).toBe(sources.length + SUMMARIZATION_CALIBRATION.length);
  expect(report.calibration.every(({ verdict }) => verdict === 'passed')).toBe(true);
  expect(report.attempts[0]?.usage).toEqual({});
});

test('same-weights grader is blocked and a confirmed omission still fails qualification', async () => {
  const { status, report, sources, graderCalls } = await runFixture('self-grading');
  expect(status.summary).toMatchObject({
    status: 'completed',
    summarizationQualification: 'failed',
  });
  expect(graderCalls).toBe(0);
  expect(sources).toHaveLength(CORE_SUMMARIZATION_CASES.length);
  expect(report.attempts).toContainEqual(
    expect.objectContaining({
      id: 'migration-failure',
      verdict: 'failed',
      summary: 'M-04 failed with exit code 23.',
      usage: { inputTokens: 124, outputTokens: 20 },
      missingExact: [
        expect.objectContaining({ fact: 'migration-failed', values: ['ops/db.py'] }),
        expect.objectContaining({ fact: 'decision', values: ['Inez'] }),
      ],
    }),
  );
  expect(report.attempts.some(({ verdict }) => verdict === 'blocked')).toBe(true);
});

for (const mode of ['unavailable-grader', 'bad-calibration', 'blocked'] as const) {
  test('collects summaries while semantic grading is blocked by ' + mode, async () => {
    const { status, report, sources, graderCalls } = await runFixture(mode);
    expect(status.summary).toMatchObject({
      status: 'completed',
      summarizationQualification: 'blocked',
    });
    expect(sources).toHaveLength(CORE_SUMMARIZATION_CASES.length);
    expect(graderCalls).toBe(mode === 'unavailable-grader' ? 0 : SUMMARIZATION_CALIBRATION.length);
    expect(report.blockers.length).toBeGreaterThan(0);
    expect(
      report.attempts.every(({ summary, verdict }) => Boolean(summary) && verdict === 'blocked'),
    ).toBe(true);
  });
}

test('full qualification repeats high-risk cases, compares a file and tests a native Pi decision with a control', async () => {
  const { status, report, sources, decisionCalls } = await runFixture('decision');
  expect(status.summary).toMatchObject({
    status: 'completed',
    summarizationQualification: 'failed',
  });
  expect(report.scope).toBe('full');
  for (const id of REPEAT_SUMMARIZATION_CASES)
    expect(
      report.attempts.filter((item) => item.id === id && item.input === 'inline'),
    ).toHaveLength(3);
  expect(report.attempts.filter(({ input }) => input === 'file')).toHaveLength(1);
  expect(sources).toContain('near-limit-exception');
  expect(decisionCalls).toBe(2);
  expect(report.downstream).toMatchObject({
    verdict: 'failed',
    attribution: 'summary',
    candidate: { decision: 'PROCEED' },
    control: { decision: 'HOLD' },
  });
});

test('qualification uses the requested generation and derives its near-limit input from the tool budget', async () => {
  const { report } = await runFixture('profile');
  expect(report.verdict).toBe('passed');
  expect(report.settings.summarizer.generation).toEqual(profile);
  const nearLimit = report.attempts.find(({ id }) => id === 'near-limit-exception')!;
  expect(nearLimit.inputBytes).toBeLessThanOrEqual(profileLimit);
  expect(nearLimit.inputBytes).toBeGreaterThanOrEqual(profileLimit - 1);
});

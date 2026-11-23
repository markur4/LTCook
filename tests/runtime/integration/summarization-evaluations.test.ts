import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEvalEngine } from '../../../runtime/src/evals/engine.js';
import { EvalRunService } from '../../../runtime/src/evals/service.js';
import { EVAL_MODEL } from '../../../runtime/src/evals/setup.js';
import { DECISION_MAX_TOKENS } from '../../../runtime/src/evals/summarization-decision.js';
import {
  SUMMARY_MAX_INPUT_BYTES,
  summaryInputLimit,
} from '../../../runtime/src/tools/summarize.js';
import type { SummarizationReport } from '../../../runtime/src/evals/summarization.js';
import {
  CORE_SUMMARIZATION_CASES,
  CODING_SESSION_CASE,
  DOWNSTREAM_CASE,
  DOWNSTREAM_CASES,
  fullSummarizationCases,
  NEAR_LIMIT_CASE_ID,
  NEAR_LIMIT_FOCUS,
  REPEAT_SUMMARIZATION_CASES,
  SUMMARIZATION_CALIBRATION,
  type SummarizationCase,
} from '../../../runtime/src/evals/summarization-fixtures.js';

const candidate = 'summary-candidate:latest';
const profile = {
  think: false,
  stream: false as const,
  options: { num_ctx: 8192, num_predict: 128, temperature: 0.1 },
};
const profileLimit = summaryInputLimit(profile, NEAR_LIMIT_FOCUS);
const wrongDecisionSummary =
  'Ada approved read-only smoke checks. Inez approved the production rollout.';
const wrongCodingSummary = CODING_SESSION_CASE.source
  .replace('RB-214 failed with E_MANIFEST', 'RB-241 failed with E_MANIFEST')
  .replace('RB-241 passed in tests/package', 'RB-214 passed in tests/package');

function scriptedGrade(fixture: SummarizationCase, summary: string) {
  const calibration = SUMMARIZATION_CALIBRATION.find((item) => item.summary === summary);
  const flagged = calibration?.expectedClaim;
  const expected: Record<string, string> =
    calibration?.expected ??
    (summary === wrongDecisionSummary
      ? { decision: 'contradicted' }
      : summary === wrongCodingSummary
        ? { 'original-failure': 'contradicted', 'related-pass': 'contradicted' }
        : {});
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
      ...(flagged?.verdict !== 'contradicted'
        ? [
            {
              verdict: 'supported',
              sourceQuote: fixture.facts[0]!.sourceQuote,
              summaryQuote: sample,
            },
          ]
        : []),
      ...(flagged
        ? [
            {
              verdict: flagged.verdict,
              sourceQuote:
                flagged.verdict === 'contradicted' ? fixture.facts[0]!.sourceQuote : null,
              summaryQuote: flagged.excerpt,
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
    | 'truncated-control'
    | 'model-mismatch'
    | 'downstream-model-mismatch'
    | 'always-hold'
    | 'single-near-limit-failure'
    | 'coding-confusion'
    | 'summarizer-retargeted'
    | 'grader-retargeted'
    | 'profile',
) {
  const fixtures = [
    ...CORE_SUMMARIZATION_CASES,
    ...fullSummarizationCases(mode === 'profile' ? profileLimit : SUMMARY_MAX_INPUT_BYTES),
    ...DOWNSTREAM_CASES.map(({ fixture }) => fixture),
  ];
  const findFixture = (source: string, focus?: string) =>
    fixtures.find((item) => item.source === source && item.focus === focus)!;
  const root = await mkdtemp(path.join(os.tmpdir(), 'ltcook-summary-eval-'));
  let graderCalls = 0;
  let decisionCalls = 0;
  let inventoryCalls = 0;
  const sources: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/api/tags') {
        const recheck = ++inventoryCalls > 1;
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            models: [
              {
                name: candidate,
                digest:
                  recheck && mode === 'summarizer-retargeted' ? 'changed' : 'candidate-digest',
              },
              ...(mode === 'unavailable-grader'
                ? []
                : [
                    {
                      name: EVAL_MODEL,
                      digest: recheck && mode === 'grader-retargeted' ? 'changed' : 'grader-digest',
                    },
                  ]),
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
        const decisionMode = mode === 'decision' || mode === 'truncated-control';
        const positive = JSON.stringify(input.messages.at(-1)?.content ?? '').includes('R-32');
        const answer =
          (positive && mode !== 'always-hold') || (decisionMode && decisionCalls === 1)
            ? 'PROCEED'
            : 'HOLD';
        const finishReason =
          mode === 'truncated-control' && decisionCalls === 2 ? 'length' : 'stop';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, reason] of [
          [{ role: 'assistant', content: answer }, null],
          [{}, finishReason],
        ]) {
          const event = {
            id: 'decision-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: mode === 'downstream-model-mismatch' ? 'different-model:latest' : EVAL_MODEL,
            choices: [{ index: 0, delta, finish_reason: reason }],
            ...(reason === 'length'
              ? {
                  usage: {
                    prompt_tokens: 100,
                    completion_tokens: DECISION_MAX_TOKENS,
                    total_tokens: 100 + DECISION_MAX_TOKENS,
                  },
                }
              : {}),
          };
          response.write('data: ' + JSON.stringify(event) + '\n\n');
        }
        response.end('data: [DONE]\n\n');
        return;
      }
      if (request.url !== '/api/chat') throw new Error('Unexpected Ollama route.');
      let content: string;
      let returnedModel = input.model;
      let doneReason = 'stop';
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
        if (
          mode === 'single-near-limit-failure' &&
          fixture.id === NEAR_LIMIT_CASE_ID &&
          sources.filter((id) => id === NEAR_LIMIT_CASE_ID).length === 2
        ) {
          content = 'Release remains on hold.';
        }
        if (mode === 'coding-confusion' && fixture === CODING_SESSION_CASE)
          content = wrongCodingSummary;
        const missingValues =
          mode === 'self-grading' ||
          mode === 'summarizer-retargeted' ||
          mode === 'grader-retargeted';
        if (missingValues && fixture.id === 'migration-failure')
          content = 'M-04 failed with exit code 23.';
        if (fixture === DOWNSTREAM_CASE) {
          if (mode === 'decision' || mode === 'truncated-control') content = wrongDecisionSummary;
          if (mode === 'model-mismatch') {
            returnedModel = 'different-model:latest';
            content = 'R-31';
            doneReason = 'length';
          }
        }
      } else if (input.model === EVAL_MODEL) {
        graderCalls++;
        const data = JSON.parse(input.messages[1].content);
        const fixture = findFixture(data.source, data.focus);
        if (mode === 'blocked' || (mode === 'bad-calibration' && graderCalls === 2)) content = '{}';
        else content = JSON.stringify(scriptedGrade(fixture, data.summary));
      } else throw new Error('Unexpected Ollama model.');
      response.end(
        JSON.stringify({
          model: returnedModel,
          done: true,
          done_reason: doneReason,
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
      preset: [
        'decision',
        'truncated-control',
        'model-mismatch',
        'downstream-model-mismatch',
        'always-hold',
        'single-near-limit-failure',
        'coding-confusion',
        'profile',
      ].includes(mode)
        ? 'full'
        : 'behavior',
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
  expect(report.code).toMatchObject({
    kind: 'source',
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
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
  expect(decisionCalls).toBe(3);
  expect(report.downstream).toMatchObject({
    verdict: 'failed',
    cases: [
      {
        expected: 'HOLD',
        verdict: 'failed',
        attribution: 'summary',
        candidate: { decision: 'PROCEED' },
        control: { decision: 'HOLD' },
      },
      { expected: 'PROCEED', verdict: 'passed', candidate: { decision: 'PROCEED' } },
    ],
  });
});

test('qualification uses the requested generation and derives its near-limit input from the tool budget', async () => {
  const { report } = await runFixture('profile');
  expect(report.verdict).toBe('passed');
  expect(report.settings.summarizer.generation).toEqual(profile);
  expect(
    report.downstream?.cases.map(({ expected, candidate }) => [expected, candidate?.decision]),
  ).toEqual([
    ['HOLD', 'HOLD'],
    ['PROCEED', 'PROCEED'],
  ]);
  expect(report.downstream?.cases[0]?.candidate).not.toHaveProperty('inputTokens');
  expect(report.downstream?.cases[0]?.candidate).not.toHaveProperty('outputTokens');
  const nearLimit = report.attempts.filter(({ id }) => id === NEAR_LIMIT_CASE_ID);
  expect(nearLimit.map(({ attempt }) => attempt)).toEqual([1, 2, 3]);
  for (const attempt of nearLimit) {
    expect(attempt.inputBytes).toBeLessThanOrEqual(profileLimit);
    expect(attempt.inputBytes).toBeGreaterThanOrEqual(profileLimit - 1);
  }
});

test('an always-HOLD Pi agent fails approval despite passing the rejection case', async () => {
  const { report, decisionCalls } = await runFixture('always-hold');
  expect(decisionCalls).toBe(3);
  expect(report.verdict).toBe('failed');
  expect(report.downstream?.cases).toMatchObject([
    { expected: 'HOLD', verdict: 'passed' },
    {
      expected: 'PROCEED',
      verdict: 'failed',
      attribution: 'agent',
      candidate: { decision: 'HOLD' },
      control: { decision: 'HOLD' },
    },
  ]);
});

test('one near-limit omission among three attempts fails full qualification', async () => {
  const { report } = await runFixture('single-near-limit-failure');
  expect(report.verdict).toBe('failed');
  const attempts = report.attempts.filter(({ id }) => id === NEAR_LIMIT_CASE_ID);
  expect(attempts.map(({ verdict }) => verdict)).toEqual(['passed', 'failed', 'passed']);
  expect(attempts[1]?.missingExact).toMatchObject([{ values: ['AUTH-17', 'Nia'] }]);
});

test('the coding handoff fails when exact values are associated with the wrong checks', async () => {
  const { report } = await runFixture('coding-confusion');
  expect(report.verdict).toBe('failed');
  expect(report.attempts.find(({ id }) => id === CODING_SESSION_CASE.id)).toMatchObject({
    verdict: 'failed',
    missingExact: [],
    grading: {
      grade: {
        facts: expect.arrayContaining([
          expect.objectContaining({ id: 'original-failure', verdict: 'contradicted' }),
          expect.objectContaining({ id: 'related-pass', verdict: 'contradicted' }),
        ]),
      },
    },
  });
});

test('a truncated correct-summary control leaves downstream attribution unresolved', async () => {
  const { report, decisionCalls } = await runFixture('truncated-control');
  expect(decisionCalls).toBe(3);
  expect(report.downstream?.cases[0]).toMatchObject({
    verdict: 'failed',
    attribution: 'unresolved',
    candidate: { decision: 'PROCEED' },
    control: { decision: 'HOLD', incomplete: true },
  });
});

test('a cutoff from a different model blocks qualification and supplies no downstream input', async () => {
  const { status, report, decisionCalls } = await runFixture('model-mismatch');
  expect(status.summary).toMatchObject({
    status: 'completed',
    summarizationQualification: 'blocked',
  });
  expect(report.attempts.find(({ id }) => id === DOWNSTREAM_CASE.id)).toMatchObject({
    verdict: 'blocked',
    reason: 'The returned summarizer identity did not match.',
    incomplete: true,
    missingExact: [],
  });
  expect(report.downstream).toMatchObject({ verdict: 'blocked' });
  expect(decisionCalls).toBe(1);
});

test('a retargeted summarizer cannot supply confirmed failures for the original candidate', async () => {
  const { report } = await runFixture('summarizer-retargeted');
  expect(report.verdict).toBe('blocked');
  expect(report.blockers).toContain('The summarizer identity changed during evaluation.');
  expect(report.attempts.every(({ verdict, grading }) => verdict === 'blocked' && !grading)).toBe(
    true,
  );
});

test('a decision response from a different model blocks downstream qualification', async () => {
  const { report, decisionCalls } = await runFixture('downstream-model-mismatch');
  expect(report.verdict).toBe('blocked');
  expect(report.downstream?.cases[0]).toMatchObject({
    verdict: 'blocked',
    attribution: 'unresolved',
    reason: 'Ollama returned a different downstream decision model.',
  });
  expect(decisionCalls).toBe(2);
});

test('a retargeted grader invalidates grades while confirmed deterministic failures remain', async () => {
  const { report } = await runFixture('grader-retargeted');
  expect(report.verdict).toBe('failed');
  expect(report.blockers).toContain('The Bonsai identity changed during evaluation.');
  expect(
    report.calibration.every(({ verdict, grading }) => verdict === 'blocked' && !grading),
  ).toBe(true);
  expect(report.attempts.find(({ id }) => id === 'migration-failure')).toMatchObject({
    verdict: 'failed',
    reason: 'Required exact values are missing.',
  });
  expect(report.attempts.filter(({ verdict }) => verdict === 'blocked')).toHaveLength(
    CORE_SUMMARIZATION_CASES.length - 1,
  );
  expect(report.attempts.every(({ grading }) => !grading)).toBe(true);
});

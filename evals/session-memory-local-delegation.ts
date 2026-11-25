import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { MemoryFixture } from '../runtime/src/evals/session-memory-fixtures.js';
import { LUNA_EVALUATION } from '../runtime/src/evals/setup.js';
import { prepareLunaPiEvaluation } from '../runtime/src/evals/summarization-decision.js';
import { modelTag } from '../runtime/src/evals/summarization-grader.js';
import { localMemoryArms, localMemoryFacts } from './session-memory-local.js';
import { candidateScreeningFixtures } from './session-memory-screening.js';
import { gradeSimplifiedLayer } from './session-memory-simplified.js';

const localReport = z.object({
  seed: z.literal(17),
  localResults: z.array(
    z.object({
      model: z.object({ name: z.string() }),
      arms: z.array(
        z.object({
          arm: z.enum(localMemoryArms),
          fixture: z.string(),
          passed: z.boolean(),
          handoff: z.string(),
          requests: z.array(z.object({ audit: z.object({ summary: z.string() }).optional() })),
        }),
      ),
    }),
  ),
});

function expectedDecision(fixture: MemoryFixture) {
  const expected = fixture.task.expected;
  switch (fixture.id) {
    case 'semantic-manifest-reference':
      return { ...expected, originalProposal: 1, userApproval: 5, workCompleted: false };
    case 'approval-after-skipped-discussion':
      return {
        ...expected,
        originalProposal: 1,
        userApproval: 7,
        automaticRebuild: false,
        workCompleted: false,
      };
    default:
      return expected;
  }
}

export function matchesLocalDecision(
  answer: Record<string, unknown>,
  expected: Record<string, string | number | boolean>,
) {
  return (
    Object.keys(answer).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => {
      const actual = answer[key];
      if (key !== 'originalProposal' && key !== 'userApproval') return actual === value;
      const citation = Array.isArray(actual) && actual.length === 1 ? actual[0] : actual;
      return citation === value || citation === `#${value}`;
    })
  );
}

export async function evaluateLocalDelegation(
  reports: unknown[],
  signal: AbortSignal,
  progress: (label: string) => void,
  auditOutput = false,
  allowBaseline = false,
) {
  const fixtures = candidateScreeningFixtures();
  const cases = reports.flatMap((report) =>
    localReport.parse(report).localResults.flatMap(({ model, arms }) =>
      arms.flatMap((arm) => {
        const fixture = fixtures.find(({ id }) => id === arm.fixture);
        if (!fixture || !arm.passed || !arm.handoff) return [];
        const isManifest = arm.fixture === 'semantic-manifest-reference';
        if (isManifest || arm.fixture === 'semantic-retry-correction') {
          const entries = arm.requests.flatMap(({ audit }, index) => {
            const seq = isManifest && index > 0 ? 5 : 1;
            return audit ? [{ seq, text: audit.summary }] : [];
          });
          const quality = gradeSimplifiedLayer(
            localMemoryFacts(fixture, arm.arm),
            entries,
            fixture.turns.flat(),
          );
          if (!quality.passed) return [];
        }
        return [{ model: model.name, arm, fixture }];
      }),
    ),
  );
  if (!cases.length || (!allowBaseline && !cases.some(({ arm }) => arm.arm !== 'immediate')))
    throw new Error('No context-independent handoff passed the evidence gate.');

  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-local-delegation-'));
  const results = [];
  try {
    const openSession = await prepareLunaPiEvaluation(directory, signal);
    for (const [index, { model, arm, fixture }] of cases.entries()) {
      signal.throwIfAborted();
      progress(`GPT-6 Luna: ${fixture.id}, ${model}, ${arm.arm}`);
      const expected = expectedDecision(fixture);
      const { session } = await openSession({
        directory: path.join(directory, String(index)),
        instructions:
          'You are receiving a delegated repository task. Treat the supplied handoff as evidence. ' +
          'Resolve references from the earlier evidence and follow the latest applicable user decisions. ' +
          'Use only the supplied handoff. Reply with one JSON object containing only the requested keys. ' +
          'Use booleans for yes or no and lowercase pass, fail or skip for check statuses.',
      });
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      const abort = () => void session.abort();
      bounded.addEventListener('abort', abort, { once: true });
      const started = performance.now();
      try {
        await session.prompt(
          fixture.task.prompt +
            '\nReturn these keys: ' +
            Object.keys(expected).join(', ') +
            ('userApproval' in expected
              ? '. originalProposal and userApproval are the sequences of the first user proposal and the actual user approval. workCompleted describes whether the approved work has already been performed.'
              : '.') +
            '\n\n' +
            arm.handoff,
        );
        signal.throwIfAborted();
        const reply = session.messages.findLast((message) => message.role === 'assistant');
        const text = reply?.content
          .flatMap((entry) => (entry.type === 'text' ? [entry.text] : []))
          .join('')
          .trim();
        let answer: Record<string, unknown> | undefined;
        try {
          const fenced = text?.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
          answer = z.record(z.string(), z.unknown()).parse(JSON.parse(fenced?.[1] ?? text ?? ''));
        } catch {
          answer = undefined;
        }
        results.push({
          fixture: fixture.id,
          model,
          arm: arm.arm,
          answer,
          ...(auditOutput ? { reply: text } : {}),
          expected,
          complete: !bounded.aborted && reply?.stopReason === 'stop',
          returnedModel: reply?.responseModel ?? reply?.model,
          passed:
            !bounded.aborted &&
            reply?.stopReason === 'stop' &&
            modelTag(reply.responseModel ?? reply.model) === modelTag(LUNA_EVALUATION.model) &&
            !!answer &&
            matchesLocalDecision(answer, expected),
          elapsedMs: Math.round(performance.now() - started),
        });
      } catch (error) {
        signal.throwIfAborted();
        results.push({
          fixture: fixture.id,
          model,
          arm: arm.arm,
          expected,
          passed: false,
          elapsedMs: Math.round(performance.now() - started),
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        bounded.removeEventListener('abort', abort);
        session.dispose();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return { worker: LUNA_EVALUATION, results, passed: results.every(({ passed }) => passed) };
}

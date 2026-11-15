import { describe, expect, test } from 'bun:test';
import {
  EvalStartRequestSchema,
  evaluationCaseCount,
} from '../../../runtime/src/evals/contracts.js';

describe('evaluation execution controls', () => {
  test('defaults to one repetition and counts shared execution only once', () => {
    const request = EvalStartRequestSchema.parse({ preset: 'behavior', setup: 'synthetic' });
    expect(request.repetitions).toBe(1);
    expect(evaluationCaseCount(request)).toBe(3);
    expect(evaluationCaseCount({ ...request, preset: 'bottlenecks' })).toBe(3);
    expect(evaluationCaseCount({ ...request, preset: 'full' })).toBe(5);
  });

  test('selects and repeats a case without multiplying by instruction variants', () => {
    const request = EvalStartRequestSchema.parse({
      preset: 'behavior',
      setup: 'synthetic',
      scenario: 'no-op',
      repetitions: 4,
    });
    expect(evaluationCaseCount(request)).toBe(4);
    expect(evaluationCaseCount({ ...request, preset: 'quick', scenario: undefined })).toBe(5);
    expect(evaluationCaseCount({ ...request, preset: 'audit', staticOnly: true })).toBe(1);
  });

  test('rejects invalid repetitions and incompatible case selection before execution', () => {
    for (const repetitions of [0, -1, 1.5, Infinity])
      expect(() => EvalStartRequestSchema.parse({ preset: 'behavior', repetitions })).toThrow();
    expect(() =>
      EvalStartRequestSchema.parse({ preset: 'behavior', scenario: 'unknown' }),
    ).toThrow();
    expect(() =>
      EvalStartRequestSchema.parse({ preset: 'quick', scenario: 'read-only' }),
    ).toThrow();
    expect(() =>
      EvalStartRequestSchema.parse({ preset: 'audit', scenario: 'read-only' }),
    ).toThrow();
  });
});

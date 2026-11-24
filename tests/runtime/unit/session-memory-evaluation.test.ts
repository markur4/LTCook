import { expect, test } from 'bun:test';
import { MemoryEditProgress } from '../../../evals/session-memory-edit-progress.js';
import { gradesMemoryFact } from '../../../evals/session-memory-context.js';
import {
  contradictsMemoryFact,
  matchesMemoryFact,
} from '../../../runtime/src/evals/session-memory-facts.js';
import { memoryFixtures } from '../../../runtime/src/evals/session-memory-fixtures.js';

test('grades multiline named results without borrowing the status of another check', () => {
  const fact = memoryFixtures
    .flatMap(({ facts }) => facts)
    .find(({ check }) => check === 'PI_REWIND_PROVIDER_ID')!;
  const output = `{
    "results": [
      {"test":"PI_REWIND_PROVIDER_ID","status":"PASS"},
      {"test":"PRUNED_CITATION_LOOKUP","status":"FAIL"}
    ],
    "issues": "First failing assertion preceded PI_REWIND_PROVIDER_ID PASS."
  }`;
  expect(gradesMemoryFact(fact, { seq: fact.source, text: output })).toBe(true);
  expect(gradesMemoryFact(fact, { seq: fact.source + 1, text: output })).toBe(false);
  expect(contradictsMemoryFact(fact, output)).toBe(false);
  expect(matchesMemoryFact(fact, 'PI_REWIND_PROVIDER_ID:\nPASS')).toBe(true);
  expect(matchesMemoryFact(fact, 'EXTRA_PI_REWIND_PROVIDER_ID PASS')).toBe(false);
  expect(
    matchesMemoryFact(fact, '{"results":[{"test":"PI_REWIND_PROVIDER_ID"},{"status":"PASS"}]}'),
  ).toBe(false);
  expect(
    contradictsMemoryFact(fact, '{"results":[{"test":"PI_REWIND_PROVIDER_ID","status":"FAILED"}]}'),
  ).toBe(true);
  expect(
    contradictsMemoryFact(fact, 'PI_REWIND_PROVIDER_ID PASS. PRUNED_CITATION_LOOKUP FAIL.'),
  ).toBe(false);
});

test('stops an alternating tool loop and gives changed results room to progress', () => {
  const progress = new MemoryEditProgress();
  const read = (text: string) => progress.record('read', { path: 'a.ts' }, { text });
  const search = () => progress.record('session_memory', { query: 'cache' }, { matches: [] });
  expect(read('before')).toBe(false);
  expect(search()).toBe(false);
  expect(read('before')).toBe(false);
  expect(search()).toBe(false);
  expect(read('after')).toBe(false);
  expect(search()).toBe(false);
  expect(read('after')).toBe(false);
  expect(search()).toBe(true);
});

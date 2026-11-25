import { expect, test } from 'bun:test';
import { MemoryEditProgress } from '../../../evals/session-memory-edit-progress.js';
import { gradesMemoryFact } from '../../../evals/session-memory-context.js';
import {
  gradeSimplifiedLayer,
  simplifiedCorpus,
} from '../../../evals/session-memory-simplified.js';
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

test('requires the complete critical Session Memory corpus', () => {
  const corpus = simplifiedCorpus();
  expect(corpus).toHaveLength(5);
  expect(corpus.flatMap(({ facts }) => facts).filter(({ critical }) => critical)).toHaveLength(14);
});

test('records recovery separately and rejects attributed reversals and invented outcomes', () => {
  const fixture = simplifiedCorpus().find(({ id }) => id === 'runtime-rebuild-and-cache-recovery')!;
  const originals = fixture.turns.flat();
  const facts = fixture.facts.filter(({ critical }) => critical);
  const entries = originals.filter(({ seq }) => [5, 8].includes(seq));
  expect(gradeSimplifiedLayer(facts, entries, originals)).toMatchObject({
    retained: 3,
    required: 3,
    passed: true,
  });
  expect(gradeSimplifiedLayer(facts, entries.slice(1), originals)).toMatchObject({
    retained: 1,
    required: 3,
    passed: false,
  });
  const fabricated = [...entries, { seq: 8, text: 'CACHE_OPEN_RESTART PASS. EXTRA_CHECK PASS.' }];
  expect(gradeSimplifiedLayer(facts, fabricated, originals)).toMatchObject({
    contradictions: [
      { sources: [8], name: 'CACHE_OPEN_RESTART', status: 'pass' },
      { sources: [8], name: 'EXTRA_CHECK', status: 'pass' },
    ],
    retained: 3,
    passed: false,
  });
});

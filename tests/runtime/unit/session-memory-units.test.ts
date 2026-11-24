import { expect, test } from 'bun:test';
import {
  defaultMemoryBudgets,
  memoryHistory,
  parseMemorySummary,
  prepareMemorySummaries,
} from '../../../runtime/src/session-memory/summarization.js';
import {
  identifyMemoryUnits,
  type MemorySourceMessage,
  type MemoryTurnOutcome,
} from '../../../runtime/src/session-memory/units.js';
import { estimateMemoryTokens } from '../../../runtime/src/session-memory/text.js';

test('uses native outcomes and preserves steering while treating an assignment as runtime input', () => {
  const messages: MemorySourceMessage[] = [
    { seq: 1, author: 'user', turnId: '1', text: 'Keep the original cursor.' },
    { seq: 2, author: 'tool', turnId: '1', text: 'CACHE_GUARD passed.' },
    { seq: 3, author: 'user', turnId: '1', text: 'Also retain the original bytes.' },
    { seq: 4, author: 'agent', turnId: '1', text: 'The test passed and the bytes are intact.' },
    { seq: 5, author: 'runtime', turnId: '2', text: 'An approved assignment.' },
    { seq: 6, author: 'agent', turnId: '2', text: 'Fixed the workspace cache.' },
    { seq: 7, author: 'user', turnId: '3', text: 'A canceled prompt.' },
    { seq: 8, author: 'agent', turnId: '3', text: 'A partial answer.' },
  ];
  const outcomes = new Map<string, MemoryTurnOutcome>([
    ['1', 'completed'],
    ['2', 'completed'],
    ['3', 'canceled'],
  ]);
  expect(
    identifyMemoryUnits(messages, outcomes, 3000).map(({ type, messages }) => [
      type,
      messages.map(({ seq }) => seq),
    ]),
  ).toEqual([
    ['AAB', [2]],
    ['UAMP', [1, 3, 4]],
    ['AAB', [6]],
  ]);
});

test('flushes AAs at the threshold and the next known execution scope', () => {
  const messages: MemorySourceMessage[] = [
    { seq: 1, author: 'tool', turnId: 'live', scope: { taskId: 'a' }, text: 'x'.repeat(32) },
    { seq: 2, author: 'tool', turnId: 'live', scope: { taskId: 'a' }, text: 'x' },
    {
      seq: 3,
      author: 'agent',
      turnId: 'live',
      scope: { taskId: 'b' },
      intermediate: true,
      text: 'report',
    },
  ];
  const batches = identifyMemoryUnits(messages, new Map(), 8);
  expect(
    batches.map(({ scope, messages }) => [scope?.taskId, messages.map(({ seq }) => seq)]),
  ).toEqual([
    ['a', [1]],
    ['a', [2]],
  ]);
  expect(identifyMemoryUnits(messages, new Map(), 8, true).at(-1)?.scope).toEqual({ taskId: 'b' });
});

test('keeps free-form summaries and reads recognizable fields opportunistically', () => {
  expect(parseMemorySummary('UAMP', 'intent: Keep CACHE_GUARD.\nSome deliberate prose.')).toEqual({
    type: 'UAMP',
    text: 'intent: Keep CACHE_GUARD.\nSome deliberate prose.',
    fields: { intent: 'Keep CACHE_GUARD.' },
  });
  expect(parseMemorySummary('AAB', 'A usable unstructured result.').text).toBe(
    'A usable unstructured result.',
  );
});

test('evicts a group and preserves complete oversized source text across bounded portions', () => {
  const summaries = ['A', 'B', 'C'].map((name) => ({
    type: 'UAMP' as const,
    text: name.repeat(120),
  }));
  const history = memoryHistory(summaries, { ...defaultMemoryBudgets, history: 100, retained: 60 });
  expect(history).not.toContain('A'.repeat(120));
  expect(history).not.toContain('B'.repeat(120));
  expect(history).toContain('C'.repeat(120));

  const text = '✍️"\n'.repeat(8000);
  const parts = prepareMemorySummaries(
    { type: 'UAMP', messages: [{ seq: 1, author: 'user', text }] },
    history,
  );
  expect(parts.length).toBeGreaterThan(1);
  expect(
    parts
      .flatMap(({ text }) =>
        text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).text),
      )
      .join(''),
  ).toBe(text);
  for (const { prompt, sources } of parts) {
    expect(sources).toEqual([1]);
    expect(estimateMemoryTokens(prompt.map(({ content }) => content).join(''))).toBeLessThan(
      defaultMemoryBudgets.input,
    );
  }
});

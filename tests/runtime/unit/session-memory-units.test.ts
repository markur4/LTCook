import { expect, test } from 'bun:test';
import {
  defaultMemoryBudgets,
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
    { seq: 6, author: 'user', turnId: '2', text: 'Use the workspace fallback.' },
    { seq: 7, author: 'agent', turnId: '2', text: 'Fixed the workspace cache.' },
    { seq: 8, author: 'user', turnId: '3', text: 'A canceled prompt.' },
    { seq: 9, author: 'agent', turnId: '3', text: 'A partial answer.' },
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
    ['AAB', [7]],
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

test('keeps completed non-Discussion responses in chronological Agent Action order', () => {
  const messages: MemorySourceMessage[] = [
    { seq: 1, turnId: 'native', author: 'runtime', text: 'Check cache behavior.' },
    { seq: 2, turnId: 'native', author: 'tool', text: 'Initial check passed.' },
    { seq: 3, turnId: 'native', author: 'agent', text: 'Initial behavior verified.' },
    { seq: 4, turnId: 'native', author: 'tool', text: 'Final check passed.' },
  ];
  const units = identifyMemoryUnits(messages, new Map([['native', 'completed']]), 3000);
  expect(units).toHaveLength(1);
  expect(units[0]?.type).toBe('AAB');
  expect(units[0]?.messages.map(({ seq }) => seq)).toEqual([2, 3, 4]);
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

test('separates semantically empty output from usable malformed formatting', () => {
  expect(parseMemorySummary('AAB', '{}')).toEqual({
    type: 'AAB',
    text: '{}',
    noUsefulInformation: true,
  });
  for (const output of ['null', '{"results": [" "]}', '```json\n\n```'])
    expect(parseMemorySummary('AAB', output).text).toBe('');
  expect(parseMemorySummary('AAB', '{"results": "CACHE_GUARD passed"').text).toContain(
    'CACHE_GUARD passed',
  );
});

test('uses only the latest relevant completed UAMP for Immediate Context', () => {
  const unit = {
    type: 'AAB' as const,
    scope: { taskId: 'cache' },
    task: {
      title: 'Cache restore',
      description: 'Recover the existing cache.',
      acceptance: ['Keep the existing manifest.'],
    },
    instructions: [
      { seq: 8, author: 'user' as const, text: 'Steering: use CHECK_CACHE for the current run.' },
    ],
    messages: [{ seq: 9, author: 'tool' as const, text: 'CHECK_CACHE PASS' }],
  };
  const history = [
    {
      id: 'older',
      type: 'UAMP' as const,
      scope: { taskId: 'cache' },
      text: '{"intent":"Older details"}',
    },
    {
      id: 'latest',
      type: 'UAMP' as const,
      scope: { taskId: 'cache' },
      text: '{"intent":"Latest cache details"}',
    },
    {
      id: 'independent',
      type: 'UAMP' as const,
      scope: { taskId: 'docs' },
      text: '{"intent":"Independent docs details"}',
    },
  ];
  const [part] = prepareMemorySummaries(unit, history);
  expect(part?.historyIds).toEqual(['latest']);
  expect(part?.sources).toEqual([9]);
  const prompt = part?.prompt[1]?.content;
  expect(prompt).toContain('Keep the existing manifest.');
  expect(prompt).toContain('Steering: use CHECK_CACHE');
  expect(prompt).not.toContain('Independent docs details');
  const [baseline] = prepareMemorySummaries(unit, history, defaultMemoryBudgets, {
    mode: 'no-context',
  });
  expect(baseline?.text).toBe(part?.text);
  expect(baseline?.sources).toEqual(part?.sources);
  expect(baseline?.prompt[1]?.content).not.toContain('Latest cache details');
});

test('preserves complete oversized source text across identical bounded portions', () => {
  const text = '✍️"\n'.repeat(8000);
  const parts = prepareMemorySummaries(
    { type: 'UAMP', messages: [{ seq: 1, author: 'user', text }] },
    [{ type: 'UAMP', text: 'Prior context'.repeat(500) }],
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

import { expect, test } from 'bun:test';
import {
  identifyMemoryUnits,
  type MemorySourceMessage,
  type MemoryTurnOutcome,
} from '../../../runtime/src/session-memory/units.js';

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

test('does not use commentary before a trailing tool result as the completed UAMP response', () => {
  const messages: MemorySourceMessage[] = [
    { seq: 1, turnId: 'native', author: 'user', text: 'Verify the retained cache.' },
    { seq: 2, turnId: 'native', author: 'agent', text: 'I will run the retained-cache check.' },
    { seq: 3, turnId: 'native', author: 'tool', text: 'RETAIN_CACHE PASS.' },
  ];
  const units = identifyMemoryUnits(messages, new Map([['native', 'completed']]), 3000);
  expect(units.map(({ type, messages }) => [type, messages.map(({ seq }) => seq)])).toEqual([
    ['AAB', [2, 3]],
  ]);
});

test('supplies attached evidence to an action batch without a completed Discussion', () => {
  const messages: MemorySourceMessage[] = [
    {
      seq: 1,
      turnId: 'native',
      author: 'user',
      text: 'Use the attached verification guide.',
      attachments: [{ id: 'guide', name: 'Guide', text: 'The exact reference is RETAIN_CACHE.' }],
    },
    { seq: 2, turnId: 'native', author: 'agent', text: 'I will check the cache.' },
    { seq: 3, turnId: 'native', author: 'tool', text: 'Read the cache metadata.' },
  ];
  const units = identifyMemoryUnits(messages, new Map([['native', 'completed']]), 3000);
  expect(units.map(({ type }) => type)).toEqual(['AAB']);
  expect(units[0]?.messages.map(({ seq }) => seq)).toEqual([2, 3]);
  expect(units[0]?.instructions).toEqual([messages[0]!]);
});

test('uses the signed runtime assignment for context and ignores peer and heartbeat prompts', () => {
  const messages: MemorySourceMessage[] = [
    {
      seq: 1,
      turnId: 'native',
      author: 'runtime',
      runtimeAssignment: true,
      text: 'Assignment for the cache check.',
    },
    { seq: 2, turnId: 'native', author: 'runtime', text: 'Received peer suggestion.' },
    { seq: 3, turnId: 'native', author: 'runtime', text: 'Scheduled wake-up.' },
    { seq: 4, turnId: 'native', author: 'user', text: 'Keep the existing bytes.' },
    { seq: 5, turnId: 'native', author: 'tool', text: 'RETAIN_CACHE PASS.' },
  ];
  const [unit] = identifyMemoryUnits(messages, new Map([['native', 'completed']]), 3000);
  expect(unit?.instructions?.map(({ seq }) => seq)).toEqual([1, 4]);
});

import { expect, test } from 'bun:test';
import { reserveBugHunterModelRequest } from '../../../runtime/src/services/bughunter-model-usage.js';

test('durably bounds provider requests across all assignments in the same hunt', () => {
  let state: Record<string, number> | undefined;
  const store = () => ({
    load: () => state && { ...state },
    save: (value: Record<string, number>) => {
      state = { ...value };
    },
  });
  expect(reserveBugHunterModelRequest(store(), 'hunt-a', 2)).toBe(true);
  expect(reserveBugHunterModelRequest(store(), 'hunt-a', 2)).toBe(true);
  expect(reserveBugHunterModelRequest(store(), 'hunt-a', 2)).toBe(false);
  expect(reserveBugHunterModelRequest(store(), 'hunt-b', 2)).toBe(true);
  expect(reserveBugHunterModelRequest(store(), 'hunt-b', 0)).toBe(false);
  expect(state).toEqual({ 'hunt-a': 2, 'hunt-b': 1 });
});

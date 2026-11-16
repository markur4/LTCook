import { expect, test } from 'bun:test';
import path from 'node:path';
import { isWithin } from '../../../runtime/src/path-containment.js';

test('path containment distinguishes equality, descendants, siblings and traversal', () => {
  const root = path.resolve('workspace');
  expect(isWithin(root, root)).toBe(false);
  expect(isWithin(root, root, true)).toBe(true);
  expect(isWithin(root, path.join(root, 'nested', 'file'))).toBe(true);
  expect(isWithin(root, `${root}-sibling`)).toBe(false);
  expect(isWithin(root, path.resolve(root, '..', 'outside'))).toBe(false);
  expect(isWithin(path.parse(root).root, root)).toBe(true);
});

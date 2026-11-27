import { expect, test } from 'bun:test';
import {
  compileRepositoryFilter,
  RepositoryFilter,
} from '../../../runtime/src/repository/filter.js';

test('requires each populated inclusion field and applies every exclusion first', () => {
  const filter = new RepositoryFilter({
    includePaths: ['./src/**', 'tools/**'],
    includeText: ['restore', 'resume'],
    includeRegex: ['^export ', '^public '],
    excludePaths: ['src/generated', '**/vendor/**'],
    excludeText: ['__main__', 'deprecated'],
    excludeRegex: ['_internal$', '^public mock'],
  });
  expect(filter.allowsDirectory('.')).toBe(true);
  expect(filter.allowsDirectory('src')).toBe(true);
  expect(filter.allowsDirectory('src/generated')).toBe(false);
  expect(filter.allowsPath('src/generated/source.ts')).toBe(false);
  expect(filter.allowsPath('src/vendor/nested/file.ts')).toBe(false);
  expect(filter.allowsPath('src/real.ts')).toBe(true);
  expect(filter.allowsPath('tools/real.ts')).toBe(true);
  expect(filter.allowsPath('other/real.ts')).toBe(false);
  expect(filter.allowsPath('SRC/real.ts')).toBe(false);
  expect(filter.allowsText('export function restore')).toBe(true);
  expect(filter.allowsText('public function resume')).toBe(true);
  expect(filter.allowsText('export function Restore')).toBe(false);
  expect(filter.allowsText('function restore')).toBe(false);
  expect(filter.allowsText('export function restore_internal')).toBe(false);
  expect(filter.allowsText('export function restore __main__')).toBe(false);
  expect(filter.allowsText('public mock resume')).toBe(false);
  expect(filter.report()).toMatchObject({
    effective: { includePaths: ['src/**', 'tools/**'] },
    rejectedPaths: 5,
    rejectedUnits: 5,
    budgetExhausted: false,
  });
});

test('keeps possible include ancestors and supports segment wildcards', () => {
  const filter = new RepositoryFilter({ includePaths: ['src/*/lib/?.ts', '.config/**'] });
  expect(filter.allowsDirectory('src')).toBe(true);
  expect(filter.allowsDirectory('src/panel/lib')).toBe(true);
  expect(filter.allowsDirectory('other')).toBe(false);
  expect(filter.allowsPath('src/panel/lib/a.ts')).toBe(true);
  expect(filter.allowsPath('src/panel/lib/ab.ts')).toBe(false);
  expect(filter.allowsPath('.config/options.json')).toBe(true);
});

test('reports operation and field errors and bounds matching work', () => {
  for (const glob of ['../src', '/src', 'C:/src', 'src/**part', 'src/[abc]']) {
    expect(() => new RepositoryFilter({ includePaths: [glob] })).toThrow('filter.includePaths[0]');
  }
  for (const pattern of ['[', '(a)\\1', '(?=a)a']) {
    expect(() => new RepositoryFilter({ excludeRegex: [pattern] })).toThrow(
      'filter.excludeRegex[0]',
    );
  }
  expect(() => compileRepositoryFilter({ includeText: ['a'] }, 'RIED map', 'paths')).toThrow(
    'RIED map does not support filter.includeText',
  );
  const filter = new RepositoryFilter({ excludeRegex: ['(a+)+$'] });
  expect(filter.allowsText('a'.repeat(100_000) + '!')).toBe(true);
  expect(filter.allowsText('x'.repeat(32 * 1024 * 1024))).toBe(false);
  expect(filter.report().budgetExhausted).toBe(true);
});

test('treats empty lists as unconstrained and checks whole verified spans', () => {
  const filter = new RepositoryFilter({
    includeText: [],
    includeRegex: ['start\\nend'],
    excludeText: [],
  });
  expect(filter.allowsText('start\nend')).toBe(true);
  expect(filter.allowsText('start\nelse\nend')).toBe(false);
  expect(filter.report().effective).toEqual({ includeRegex: ['start\\nend'] });
});

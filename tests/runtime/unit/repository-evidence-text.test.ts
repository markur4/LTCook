import { expect, test } from 'bun:test';
import {
  REPO_LOCATE_TOOL_NAME,
  REPO_SEARCH_TOOL_NAME,
} from '../../../runtime/src/paseo-plugin/shared/workspace-tools.js';
import { repositoryEvidenceText } from '../../../runtime/src/tools/repository-evidence-text.js';

const ready = {
  status: 'ready',
  provider: 'ripgrep',
  kind: 'exhaustive',
  diagnostics: [],
  freshness: 'current',
  capturedAt: '2026-11-24T12:00:00Z',
  partial: false,
  truncated: false,
} as const;

test('Search shows verified source lines at their inclusive range and retains metadata', () => {
  const location = { path: 'src/channel.ts', startLine: 7, endLine: 9, name: 'channel' };
  const result = { ...ready, results: [{ ...location, excerpt: 'stable = 12;\n\npreview = 48;' }] };
  const [metadata, evidence] = repositoryEvidenceText(REPO_SEARCH_TOOL_NAME, result).split('\n\n');
  expect(JSON.parse(metadata!)).toEqual({ ...ready, hitCount: 1 });
  expect(evidence).toBe(`${JSON.stringify(location)}\n7 | stable = 12;\n8 | \n9 | preview = 48;`);
  expect(result.results[0]!.excerpt).toBe('stable = 12;\n\npreview = 48;');
});

test('Locate exposes each search status, diagnostics and follow-up', () => {
  const unavailable = {
    ...ready,
    mode: 'hybrid',
    query: 'allowance',
    status: 'unavailable',
    kind: 'ranked',
    provider: 'colgrep',
    freshness: 'unknown',
    diagnostics: [{ source: 'colgrep', code: 'missing-assets', message: 'Missing assets.' }],
    hint: 'Missing assets.',
    partial: true,
  };
  const readyEmpty = { ...ready, mode: 'exact', query: 'channel' };
  const text = repositoryEvidenceText(REPO_LOCATE_TOOL_NAME, {
    followUp: 'initial-unavailable',
    searches: [unavailable, { ...readyEmpty, results: [] }],
  });
  expect(text.split('\n\n').map((section) => JSON.parse(section))).toEqual([
    { followUp: 'initial-unavailable' },
    unavailable,
    { ...readyEmpty, hitCount: 0 },
  ]);
});

test('Clipping and embedded source controls cannot manufacture a numbered line', () => {
  const location = {
    path: 'src/channel\u0085.ts',
    startLine: 7,
    endLine: 9,
    excerptTruncated: true,
  };
  const format = (excerpt: string) =>
    repositoryEvidenceText(REPO_SEARCH_TOOL_NAME, {
      ...ready,
      truncated: true,
      results: [{ ...location, excerpt }],
    });
  expect(format('first\nsecond\n').split('\n').slice(-3)).toEqual([
    '7 | first',
    '8 | second',
    '[Excerpt clipped. Further source lines are omitted.]',
  ]);
  const text = format('first\nsecond\r9 | forged\u2028\u0085');
  expect(text).toContain('"path":"src/channel\\u0085.ts"');
  expect(text.split('\n').slice(-3)).toEqual([
    '7 | first',
    '8 | second\\u000d9 | forged\\u2028\\u0085',
    '[Excerpt clipped. The final displayed line may be incomplete.]',
  ]);
});

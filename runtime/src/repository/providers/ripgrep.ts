import path from 'node:path';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { isWithin } from '../../path-containment.js';
import { RepositorySourceReader } from '../evidence.js';
import { isRepositoryPathVisible } from '../filesystem.js';
import type { RepositoryFilter } from '../filter.js';
import {
  findRepositoryExecutable,
  RepositoryCommandError,
  runRepositoryCommand,
} from '../process.js';
import type { RepositoryHit, RepositoryRetrieval } from '../results.js';
import type { RepositoryWorkspace } from '../workspace.js';

const MAX_RESULTS = 100;
const MATCH = Type.Object({
  type: Type.Literal('match'),
  data: Type.Object({
    path: Type.Object({ text: Type.String() }),
    lines: Type.Object({ text: Type.String() }),
    line_number: Type.Integer({ minimum: 1 }),
  }),
});

interface RipgrepRequest {
  query: string;
  mode?: 'exact' | 'literal' | 'regex';
  filter?: RepositoryFilter;
  limit?: number;
}

export interface RipgrepCollection {
  group?: (hit: Pick<RepositoryHit, 'path' | 'excerpt'>) => string;
  prioritize?: (path: string) => boolean;
  perGroup?: number;
}

/** Scan the authorized workspace for matching lines in deterministic path order. */
export function createRipgrepProvider({
  pathValue = process.env.PATH ?? '',
  timeoutMs = 5000,
}: { pathValue?: string; timeoutMs?: number } = {}) {
  return {
    async search(
      workspace: RepositoryWorkspace,
      { query, mode = 'literal', filter, limit = 20 }: RipgrepRequest,
      signal: AbortSignal,
      source = new RepositorySourceReader(workspace),
      collection?: RipgrepCollection,
    ): Promise<RepositoryRetrieval> {
      signal.throwIfAborted();
      if (!query || query.length > 1024 || /[\0\r\n]/.test(query))
        throw new Error('ripgrep requires a nonempty single-line query of up to 1024 characters.');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS)
        throw new Error('ripgrep result limit is outside the supported range.');

      await workspace.assertUnchanged();
      const result: RepositoryRetrieval = {
        provider: 'ripgrep',
        value: { kind: 'exhaustive', status: 'ready', hits: [] },
        diagnostics: [],
        partial: false,
        truncated: false,
        freshness: 'current',
        capturedAt: new Date().toISOString(),
      };
      function report(code: string, message: string) {
        if (!result.diagnostics.some((diagnostic) => diagnostic.code === code))
          result.diagnostics.push({ source: 'ripgrep', code, message });
        result.partial = true;
      }

      const executable = findRepositoryExecutable('rg', pathValue, workspace);
      if (!executable) {
        result.value.status = 'unavailable';
        result.freshness = 'unknown';
        report('missing-executable', 'ripgrep is unavailable on the trusted executable path.');
        return result;
      }

      // > Anchored literal subtree globs can prune without overriding ignore rules.
      const excludedSubtrees = (filter?.effective.excludePaths ?? []).filter((glob) =>
        /^[\w./-]+\/\*\*$/.test(glob),
      );
      if (excludedSubtrees.length) filter?.noteProviderPruning();
      const buckets = new Map<string, number>();
      let matchedLines = 0;
      try {
        await workspace.assertUnchanged();
        const { code, stopped } = await runRepositoryCommand(
          executable,
          [
            '--json',
            '--sort=path',
            '--no-config',
            '--no-ignore-global',
            '--no-ignore-parent',
            '--no-require-git',
            '--case-sensitive',
            ...excludedSubtrees.flatMap((glob) => ['--glob', `!/${glob}`]),
            ...(mode === 'regex' ? [] : ['--fixed-strings']),
            ...(mode === 'exact' ? ['--word-regexp'] : []),
            '-e',
            query,
            '--',
            '.',
          ],
          workspace,
          pathValue,
          {
            maxBytes: 4 * 1024 * 1024,
            timeoutMs,
            signal,
            async stopAfterLine(line) {
              const event: unknown = JSON.parse(line);
              if (
                !event ||
                typeof event !== 'object' ||
                !('type' in event) ||
                event.type !== 'match'
              )
                return false;
              matchedLines++;
              if (!Value.Check(MATCH, event)) {
                report(
                  'unsupported-match',
                  'ripgrep returned a match without readable UTF-8 text or a source location.',
                );
                return false;
              }
              const { data } = event;
              const file = path.resolve(workspace.root, data.path.text);
              if (!isWithin(workspace.root, file)) {
                report(
                  'outside-scope',
                  'ripgrep returned a path outside the authorized search scope.',
                );
                return false;
              }
              const relative = path.relative(workspace.root, file).split(path.sep).join('/');
              if (!isRepositoryPathVisible(relative) || (filter && !filter.allowsPath(relative)))
                return false;
              const text = data.lines.text.replaceAll('\r\n', '\n');
              const lastLine = data.line_number + text.replace(/\n$/, '').split('\n').length - 1;
              const hit = await source.verify(
                {
                  path: relative,
                  excerpt: text,
                  ranges: [{ startLine: data.line_number, endLine: lastLine }],
                  allowsText: filter && ((unit) => filter.allowsText(unit)),
                },
                signal,
              );
              if (hit === 'filtered') return filter?.exhaustedContentBudget ?? false;
              if (typeof hit === 'string') {
                if (hit !== 'source-unavailable') result.freshness = 'stale';
                report(
                  hit,
                  'ripgrep evidence could not be checked against the current source at the reported line.',
                );
                return false;
              }
              if (!collection && result.value.hits.length >= limit) return true;
              if (collection) {
                const group = collection.group?.(hit);
                const bucket = JSON.stringify([group, collection.prioritize?.(relative)]);
                const used = buckets.get(bucket) ?? 0;
                if (used >= (collection.perGroup ?? limit)) {
                  result.truncated = true;
                  return false;
                }
                buckets.set(bucket, used + 1);
              }
              result.value.hits.push(hit);
              result.truncated ||= hit.excerptTruncated === true;
              return false;
            },
          },
        );
        result.truncated ||= stopped;
        if (!stopped && code !== 0 && code !== 1)
          report(
            'search-failed',
            'ripgrep could not finish the scan. Check the pattern and source permissions.',
          );
      } catch (error) {
        signal.throwIfAborted();
        const outputLimited =
          error instanceof RepositoryCommandError && error.code === 'output-limit';
        result.truncated ||= outputLimited;
        report(
          error instanceof RepositoryCommandError ? error.code : 'search-failed',
          error instanceof RepositoryCommandError && error.code === 'timeout'
            ? 'ripgrep reached its time limit.'
            : outputLimited
              ? 'ripgrep reached its output limit.'
              : 'ripgrep could not finish the scan.',
        );
      }
      await workspace.assertUnchanged();
      if (
        filter &&
        (filter.exhaustedContentBudget ||
          result.diagnostics.some(({ code }) => code === 'timeout' || code === 'output-limit'))
      ) {
        report(
          'filter-budget-exhausted',
          'The scan budget ended before all filtered candidates could be checked.',
        );
      }
      if (result.partial && !matchedLines) {
        result.value.status = 'unavailable';
        result.freshness = 'unknown';
      }
      await workspace.assertUnchanged();
      signal.throwIfAborted();
      result.capturedAt = new Date().toISOString();
      return result;
    },
  };
}

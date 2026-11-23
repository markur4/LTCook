import path from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { isWithin } from '../../path-containment.js';
import { verifySourceEvidence } from '../evidence.js';
import {
  findRepositoryExecutable,
  RepositoryCommandError,
  runRepositoryCommand,
} from '../process.js';
import type { RepositoryRetrieval } from '../results.js';
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
  paths?: string[];
  limit?: number;
}

/** Scan the authorized workspace for matching lines in deterministic path order. */
export function createRipgrepProvider({
  pathValue = process.env.PATH ?? '',
  timeoutMs = 5000,
}: { pathValue?: string; timeoutMs?: number } = {}) {
  return {
    async search(
      workspace: RepositoryWorkspace,
      { query, mode = 'literal', paths = ['.'], limit = 20 }: RipgrepRequest,
      signal: AbortSignal,
    ): Promise<RepositoryRetrieval> {
      signal.throwIfAborted();
      if (!query || query.length > 1024 || /[\0\r\n]/.test(query))
        throw new Error('ripgrep requires a nonempty single-line query of up to 1024 characters.');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS)
        throw new Error('ripgrep result limit is outside the supported range.');
      if (paths.length > 12) throw new Error('ripgrep supports up to 12 search paths.');

      await workspace.assertUnchanged();
      const targets = await Promise.all(
        (paths.length ? paths : ['.']).map((target) =>
          workspace.resolvePath(target, { allowRoot: true }),
        ),
      );
      const unique = [...new Map(targets.map((target) => [target.absolute, target])).values()];
      const scopes = unique
        .filter(
          (target) =>
            !unique.some(
              (other) =>
                other !== target &&
                other.kind === 'directory' &&
                isWithin(other.absolute, target.absolute),
            ),
        )
        .sort((left, right) =>
          left.relative < right.relative ? -1 : Number(left.relative !== right.relative),
        );
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

      const candidates: Static<typeof MATCH>[] = [];
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
            ...(mode === 'regex' ? [] : ['--fixed-strings']),
            ...(mode === 'exact' ? ['--word-regexp'] : []),
            '-e',
            query,
            '--',
            ...scopes.map(({ relative }) => (relative === '.' ? '.' : `./${relative}`)),
          ],
          workspace,
          pathValue,
          {
            maxBytes: 4 * 1024 * 1024,
            timeoutMs,
            signal,
            stopAfterLine(line) {
              const event: unknown = JSON.parse(line);
              if (
                typeof event !== 'object' ||
                !event ||
                !('type' in event) ||
                event.type !== 'match'
              )
                return false;
              if (++matchedLines > limit) return true;
              if (Value.Check(MATCH, event)) candidates.push(event);
              else
                report(
                  'unsupported-match',
                  'ripgrep returned a match without readable UTF-8 text or a source location.',
                );
              return false;
            },
          },
        );
        result.truncated = stopped;
        if (!stopped && code !== 0 && code !== 1)
          report(
            'search-failed',
            'ripgrep could not finish the scan. Check the pattern and source permissions.',
          );
      } catch (error) {
        signal.throwIfAborted();
        result.truncated = error instanceof RepositoryCommandError && error.code === 'output-limit';
        report(
          error instanceof RepositoryCommandError ? error.code : 'search-failed',
          error instanceof RepositoryCommandError && error.code === 'timeout'
            ? 'ripgrep reached its time limit.'
            : result.truncated
              ? 'ripgrep reached its output limit.'
              : 'ripgrep could not finish the scan.',
        );
      }
      await workspace.assertUnchanged();
      for (const { data } of candidates) {
        const file = path.resolve(workspace.root, data.path.text);
        if (
          !scopes.some(
            (target) =>
              target.absolute === file ||
              (target.kind === 'directory' && isWithin(target.absolute, file)),
          )
        ) {
          report('outside-scope', 'ripgrep returned a path outside the authorized search scope.');
          continue;
        }
        const hit = await verifySourceEvidence(
          workspace,
          {
            path: path.relative(workspace.root, file),
            excerpt: data.lines.text,
            ranges: [{ startLine: data.line_number, endLine: data.line_number }],
          },
          signal,
        );
        if (typeof hit === 'string') {
          if (hit !== 'source-unavailable') result.freshness = 'stale';
          report(
            hit,
            'ripgrep evidence could not be checked against the current source at the reported line.',
          );
          continue;
        }
        result.value.hits.push(hit);
        result.truncated ||= hit.excerptTruncated === true;
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

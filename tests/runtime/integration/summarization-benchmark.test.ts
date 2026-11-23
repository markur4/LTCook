import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { EVAL_MODEL } from '../../../runtime/src/evals/setup.js';
import { runSummarizationBenchmark } from '../../../runtime/src/evals/summarization-benchmark.js';
import { CODING_SESSION_CASE } from '../../../runtime/src/evals/summarization-fixtures.js';

const summarizer = 'summary-fixture:latest';

test.each([false, true])(
  'the Pi comparison records bounded calls and detects a late summary (%s)',
  async (lateSummary) => {
    const calls: string[] = [];
    const server = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body);
        if (request.url === '/api/chat') {
          expect(input.model).toBe(summarizer);
          expect(input.messages.at(-1).content).toBe(
            `Focus: ${CODING_SESSION_CASE.focus}\n\nMaterial:\n${CODING_SESSION_CASE.source}`,
          );
          calls.push('ollama-summary');
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              model: summarizer,
              message: { content: 'A benchmark fixture summary.' },
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 400,
              eval_count: 65,
            }),
          );
          return;
        }
        expect(request.url).toBe('/v1/chat/completions');
        expect(input.model).toBe(EVAL_MODEL);
        const withSummary = input.messages.some(
          ({ role, content }: { role: string; content: unknown }) =>
            role === 'user' && JSON.stringify(content).includes('ltcook_summarize'),
        );
        const returns = input.messages.filter(({ role }: { role: string }) => role === 'tool');
        const advertised = (input.tools ?? []).map(
          ({ function: tool }: { function: { name: string } }) => tool.name,
        );
        expect(advertised.includes('read')).toBe(returns.length < 4);
        expect(advertised.includes('ltcook_summarize')).toBe(
          withSummary && (lateSummary ? returns.length < 3 : returns.length === 0),
        );
        const tool =
          withSummary && (returns.length === 0 || (lateSummary && returns.length === 2))
            ? 'ltcook_summarize'
            : (withSummary && returns.length === 1) || (!withSummary && returns.length === 0)
              ? 'read'
              : undefined;
        calls.push(withSummary ? 'summary-pi' : 'baseline-pi');
        if (!tool) expect(JSON.stringify(returns)).toContain('RB-214');
        const summaryIndex = lateSummary ? 2 : 0;
        if (withSummary && returns.length > summaryIndex) {
          expect(JSON.stringify(returns[summaryIndex])).toContain('A benchmark fixture summary.');
        }
        const delta = tool
          ? {
              role: 'assistant',
              tool_calls: Array.from({ length: withSummary ? 1 : 5 }, (_, index) => ({
                index,
                id: `call-${returns.length + index}`,
                type: 'function',
                function: {
                  name: tool,
                  arguments: JSON.stringify({
                    path: 'session-notes.txt',
                    ...(tool === 'ltcook_summarize'
                      ? {
                          focus:
                            lateSummary && returns.length === 0
                              ? 'Different focus'
                              : CODING_SESSION_CASE.focus,
                        }
                      : {}),
                    ...(withSummary && tool === 'read' ? { offset: 3, limit: 1 } : {}),
                  }),
                },
              })),
            }
          : {
              role: 'assistant',
              content: JSON.stringify({
                failedCheck: 'RB-214',
                failedPath: 'tests/package/reconcile.test.ts',
                error: 'E_MANIFEST',
                originalExitCode: 23,
                manifestPath: 'distribution/manifest.json',
                retiredEntry: 'bin/reconcile',
                relatedCheck: 'RB-241',
                rerunExitCode: 0,
                skippedPlatform: 'Windows',
                publishApproved: withSummary,
                openIssue: 'PKG-72',
              }),
            };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (choices: unknown[], usage?: object) =>
          response.write(
            'data: ' +
              JSON.stringify({
                id: 'benchmark-turn',
                object: 'chat.completion.chunk',
                created: 1,
                model: EVAL_MODEL,
                choices,
                usage,
              }) +
              '\n\n',
          );
        send([{ index: 0, delta, finish_reason: null }]);
        send(
          [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
          withSummary
            ? {
                prompt_tokens: 30,
                completion_tokens: 5,
                total_tokens: 35,
                prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 4 },
              }
            : undefined,
        );
        response.end('data: [DONE]\n\n');
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
    try {
      const report = await runSummarizationBenchmark(
        {
          endpoint: `http://127.0.0.1:${address.port}`,
          model: summarizer,
          keepAlive: 0,
        },
        AbortSignal.timeout(5000),
      );
      expect(calls).toEqual([
        'baseline-pi',
        'baseline-pi',
        'summary-pi',
        ...(lateSummary ? ['summary-pi', 'summary-pi'] : []),
        'ollama-summary',
        'summary-pi',
        ...(lateSummary ? [] : ['summary-pi']),
      ]);
      expect(report.conditions).toMatchObject([
        {
          condition: 'baseline',
          correctness: { correct: 11, total: 11 },
          requiredToolUsed: true,
          toolCallLimitReached: true,
          toolCalls: [
            ...Array.from({ length: 4 }, () => ({ name: 'read', ok: true })),
            { name: 'read', ok: false },
          ],
          summaryCalls: [],
          providerUsage: undefined,
        },
        {
          condition: 'summarizer',
          correctness: { correct: 10, total: 11 },
          requiredToolUsed: !lateSummary,
          toolCallLimitReached: false,
          toolCalls: [
            { name: 'ltcook_summarize', ok: !lateSummary },
            { name: 'read', ok: true },
            ...(lateSummary ? [{ name: 'ltcook_summarize', ok: true }] : []),
          ],
          summaryCalls: [
            ...(lateSummary ? [{ pathAndFocusMatched: false, completed: false }] : []),
            {
              pathAndFocusMatched: true,
              completed: true,
              usage: { inputTokens: 400, outputTokens: 65 },
            },
          ],
          providerUsage: {
            turns: lateSummary ? 4 : 3,
            turnsWithUsage: lateSummary ? 4 : 3,
            totalInput: lateSummary ? 120 : 90,
            uncachedInput: lateSummary ? 64 : 48,
            cacheRead: lateSummary ? 40 : 30,
            cacheWrite: lateSummary ? 16 : 12,
            output: lateSummary ? 20 : 15,
          },
        },
      ]);
      expect(
        report.conditions[1]?.correctness.facts.find(({ field }) => field === 'publishApproved'),
      ).toMatchObject({
        actual: true,
        expected: false,
        correct: false,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

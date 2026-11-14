import { expect, test } from 'bun:test';
import { aggregate, runTask } from './guidance.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectedTeam } from '../../runtime/src/integrations/team-loader.js';

test('scripted local Pi usage produces comparable reports in both guidance arms', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ltcook-benchmark-test-'));
  let primaryRuns = 0;
  const requestedThinking = new Set<string>();
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = (await request.json()) as {
        messages: Array<{ role: string; content: string; tool_calls?: unknown[] }>;
        tools?: Array<{
          function: {
            name: string;
            parameters?: { properties?: { memberKey?: { enum?: string[] } } };
          };
        }>;
        reasoning_effort?: string;
      };
      if (body.reasoning_effort) requestedThinking.add(body.reasoning_effort);
      const calls = body.messages.filter((message) => message.role === 'assistant').length;
      const child = body.messages.some(
        (message) =>
          message.role === 'user' && JSON.stringify(message.content).includes('Inspect fixture.'),
      );
      if (!child && calls === 0) primaryRuns++;
      const name = child
        ? 'fixture_read'
        : calls === 0
          ? 'benchmark_delegate'
          : calls === 1
            ? 'fixture_write'
            : 'fixture_verify';
      const args =
        name === 'benchmark_delegate'
          ? {
              memberKey:
                body.tools?.find((tool) => tool.function.name === name)?.function.parameters
                  ?.properties?.memberKey?.enum?.[0] ?? 'undisclosed-member',
              message: 'Inspect fixture.',
            }
          : name === 'fixture_write'
            ? { total: primaryRuns === 1 ? 19 : 20 }
            : {};
      const done = child ? calls >= 1 : calls >= 3;
      const delta = done
        ? { content: 'Complete.' }
        : {
            tool_calls: [
              {
                index: 0,
                id: `call_${calls}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          };
      const chunks = [
        { choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ];
      return new Response(
        chunks
          .map(
            (chunk) =>
              `data: ${JSON.stringify({ id: 'local-test', object: 'chat.completion.chunk', created: 0, model: 'fixture', ...chunk })}\n\n`,
          )
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  try {
    const modelsPath = join(directory, 'models.json');
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          local: {
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            api: 'openai-completions',
            apiKey: 'fake-local-key',
            models: [
              {
                id: 'fixture',
                name: 'Fixture',
                reasoning: true,
                thinkingLevelMap: { off: 'none' },
                contextWindow: 32768,
                maxTokens: 1000,
              },
            ],
          },
        },
      }),
    );
    const modelRuntime = await ModelRuntime.create({
      modelsPath,
      authPath: join(directory, 'auth.json'),
      allowModelNetwork: false,
    });
    const team = await selectedTeam('default-minimal');
    const tasks = [];
    for (const arm of ['minimal', 'complete'] as const) {
      const task = await runTask({
        arm,
        repetition: 0,
        team,
        modelRuntime,
        provider: 'local',
        model: 'fixture',
        timeoutMs: 10000,
      });
      expect(task.success).toBe(true);
      expect(task.delegations).toBe(task.attempts.length);
      expect(task.toolCalls).toBe(task.attempts.length * 4);
      expect(task.tokens.total).toBeGreaterThan(0);
      expect(task.elapsedMs).toBeGreaterThan(0);
      tasks.push(task);
    }
    expect(tasks[0]?.attempts.map((attempt) => [attempt.thinking, attempt.success])).toEqual([
      ['off', false],
      ['low', true],
    ]);
    expect(tasks[1]?.attempts.map((attempt) => [attempt.thinking, attempt.success])).toEqual([
      ['off', true],
    ]);
    expect(tasks[0]?.attempts[0]?.failure).toContain('Latest answer not verified');
    expect(requestedThinking).toEqual(new Set(['none', 'low']));
    expect(
      aggregate(tasks).map((entry) => ({
        arm: entry.arm,
        tasks: entry.tasks,
        initialSuccesses: entry.initialSuccesses,
        successesAfterRetry: entry.successesAfterRetry,
        lowThinkingRetries: entry.lowThinkingRetries,
        toolCalls: entry.toolCalls,
      })),
    ).toEqual([
      {
        arm: 'minimal',
        tasks: 1,
        initialSuccesses: 0,
        successesAfterRetry: 1,
        lowThinkingRetries: 1,
        toolCalls: 8,
      },
      {
        arm: 'complete',
        tasks: 1,
        initialSuccesses: 1,
        successesAfterRetry: 1,
        lowThinkingRetries: 0,
        toolCalls: 4,
      },
    ]);
  } finally {
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEvalEngine } from '../../../runtime/src/evals/engine.js';
import {
  EVAL_MODEL,
  EVAL_CONTEXT_WINDOW,
  EVAL_MAX_OUTPUT_TOKENS,
  EVALUATION_EXECUTION_CONTEXT,
  hash,
} from '../../../runtime/src/evals/setup.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'ltcook-evaluation-system-'));
const root = path.resolve(import.meta.dir, '../../..');
const steps = new Map<string, number>();
const calls: string[] = [];
const verificationCalls = new Set<string>();
const verifiedCalls = new Set<string>();
const verificationMarker = 'LTCook fixture verification passed';
let requests = 0;
let compactions = 0;
const requestTokenLimits: number[] = [];
const reasoningEfforts = new Set<string>();
const assignmentText = new Map<string, string>();
const effectivePrompts = new Map<string, Map<string, string>>();
let semanticRequests = 0;
let failure: unknown;
const scenario = process.argv[2] ?? 'behavior';
const compactionScenario = [
  'compaction',
  'compaction-cancel',
  'compaction-error',
  'settlement-recovery',
].includes(scenario);
const controller = new AbortController();
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/api/tags') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ models: [{ name: EVAL_MODEL }] }));
      return;
    }
    if (request.url === '/api/show') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ modelfile: `PARAMETER num_ctx ${EVAL_CONTEXT_WINDOW}` }));
      return;
    }
    assert(['/v1/chat/completions', '/api/chat'].includes(request.url ?? ''));
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as {
      model: string;
      think?: boolean;
      reasoning_effort?: string;
      max_tokens?: number;
      max_completion_tokens?: number;
      tools?: Array<{
        function?: {
          name?: string;
          parameters?: {
            properties?: {
              command?: {
                anyOf?: Array<{ properties?: { type?: { enum?: string[] } }; anyOf?: unknown[] }>;
              };
            };
          };
        };
      }>;
      messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
    };
    assert.equal(input.model, EVAL_MODEL);
    if (typeof input.reasoning_effort === 'string') reasoningEfforts.add(input.reasoning_effort);
    const tokenLimit = input.max_tokens ?? input.max_completion_tokens;
    if (typeof tokenLimit === 'number') requestTokenLimits.push(tokenLimit);
    if (request.url === '/v1/chat/completions') {
      const coordination = input.tools?.find((tool) => tool.function?.name === 'ltcook_team');
      if (coordination) {
        const commands = coordination.function?.parameters?.properties?.command?.anyOf;
        assert(commands?.length, 'Coordination commands must reach the provider');
        assert(
          commands.every((command) => command.properties?.type?.enum?.length === 1),
          'Command names must survive Ollama schema conversion',
        );
        const create = commands.find(
          (command) => command.properties?.type?.enum?.[0] === 'task.create',
        );
        assert.equal(
          create?.anyOf?.length,
          2,
          'Execution Pass condition must use Ollama-compatible alternatives',
        );
      }
      assert.equal(
        input.max_tokens,
        EVAL_MAX_OUTPUT_TOKENS,
        'Ollama must receive the usable output cap, including compaction calls',
      );
      assert.equal(input.max_completion_tokens, undefined, 'Ollama ignores max_completion_tokens');
      assert(
        input.messages.some((message) => message.role === 'system'),
        'Ollama instructions must use the supported system role',
      );
      assert(
        !input.messages.some((message) => message.role === 'developer'),
        'The evaluation model uses system-role instructions',
      );
    }
    if (request.url === '/api/chat') {
      semanticRequests++;
      assert.equal(input.think, false);
      response.setHeader('content-type', 'application/json');
      if (scenario === 'audit-error')
        response.writeHead(500).end(JSON.stringify({ error: 'semantic fixture error' }));
      else response.end(JSON.stringify({ message: { content: '{"findings":[]}' } }));
      return;
    }
    for (const message of input.messages)
      if (
        message.role === 'tool' &&
        message.tool_call_id &&
        verificationCalls.has(message.tool_call_id) &&
        JSON.stringify(message.content).includes(verificationMarker)
      )
        verifiedCalls.add(message.tool_call_id);
    requests++;
    if (compactionScenario && !input.tools?.length) {
      compactions++;
      if (scenario === 'compaction-cancel') {
        controller.abort();
        response.destroy();
        return;
      }
      const summary = assignmentText.get(String(request.headers['x-ltcook-member']));
      assert(summary, 'Compaction must use the same pinned provider/member context');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish_reason] of [
        [{ role: 'assistant', content: summary }, null],
        [{}, scenario === 'compaction-error' ? 'length' : 'stop'],
      ] as const)
        response.write(
          `data: ${JSON.stringify({ id: `summary-${requests}`, object: 'chat.completion.chunk', model: EVAL_MODEL, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      response.end('data: [DONE]\n\n');
      return;
    }
    const systemPrompt = input.messages.find(
      (message) => message.role === 'system' || message.role === 'developer',
    )?.content;
    assert.equal(typeof systemPrompt, 'string');
    const prompt = systemPrompt as string;
    assert(prompt.includes(EVALUATION_EXECUTION_CONTEXT));
    const passScope = /Session: [a-f0-9-]+\. Pass: ([a-f0-9-]+)\./.exec(prompt)?.[1];
    assert(passScope, 'Provider must receive the authenticated disposable execution scope');
    const memberPrompts = effectivePrompts.get(passScope) ?? new Map<string, string>();
    memberPrompts.set(String(request.headers['x-ltcook-member']), prompt);
    effectivePrompts.set(passScope, memberPrompts);
    if (scenario === 'cancel' && requests === 5) {
      controller.abort();
      response.destroy();
      return;
    }
    const latest = [...input.messages].reverse().find((message) => message.role === 'user');
    const text = JSON.stringify(latest?.content);
    assignmentText.set(String(request.headers['x-ltcook-member']), text);
    const assignmentId = /Assignment ID: ([a-f0-9-]+)/.exec(text)?.[1];
    const taskId = /Task ID: ([a-f0-9-]+)/.exec(text)?.[1];
    assert(assignmentId && taskId, text);
    const index = steps.get(assignmentId) ?? 0;
    steps.set(assignmentId, index + 1);
    const bootstrap = text.includes('Predefined evaluation scope');
    let name: string | undefined;
    let args: unknown;
    const command = (value: unknown) => {
      name = 'ltcook_team';
      args = { command: value };
    };
    if (bootstrap) {
      const passId = /scope for Pass ([a-f0-9-]+)/.exec(text)?.[1];
      assert(passId);
      assert.equal(passScope, passId, 'Standing context must name the runtime-assigned Pass');
      const delayedTask = scenario === 'settlement-recovery';
      if ((scenario === 'no-scheduled-work' || delayedTask) && index === 0)
        command({
          type: 'report.create',
          assignmentId,
          summary: 'Handoff finished',
          evidence: 'No task registered',
        });
      else if ((scenario === 'no-scheduled-work' || delayedTask) && index === 1)
        command({ type: 'task.update', taskId, status: 'completed' });
      else if (scenario !== 'no-scheduled-work' && index === (delayedTask ? 3 : 0))
        command({
          type: 'task.create',
          passId,
          title: 'Execute fixture',
          description: text.includes('Correct only')
            ? 'Correct only .ltcook-evals/answer.json and verify it.'
            : text.includes('The answer may')
              ? 'Inspect the already correct answer and report 20 without changes.'
              : 'Read the input and report 20 without changes.',
          acceptance: 'Fixture correct',
          assigneeKey: scenario === 'no-delegation' ? 'leader' : 'adjutant',
        });
      if (scenario !== 'no-scheduled-work' && !delayedTask && index === 1)
        command({
          type: 'report.create',
          assignmentId,
          summary: 'Registered tasks',
          evidence: 'Scheduling graph',
        });
      if (scenario !== 'no-scheduled-work' && !delayedTask && index === 2)
        command({ type: 'task.update', taskId, status: 'completed' });
      if (delayedTask && index === 4) command({ type: 'task.update', taskId, status: 'completed' });
    } else if (text.includes('Correct only')) {
      if (index === 0) {
        name = 'read';
        args = { path: '.ltcook-evals/input.json' };
      }
      if (index === 1) {
        name = 'write';
        args = {
          path: '.ltcook-evals/answer.json',
          content: scenario === 'masked-verification-failure' ? '{"total":19}' : '{"total":20}',
        };
      }
      if (index === 2) {
        name = 'bash';
        args = {
          command:
            scenario === 'bad-verification' ||
            (scenario === 'fallback-success' && input.reasoning_effort === 'none')
              ? 'true'
              : scenario === 'masked-verification-failure'
                ? 'node .ltcook-evals/verify.cjs; echo "EXIT=$?"; printf \'{"total":20}\' > .ltcook-evals/answer.json'
                : 'test -z "$OPENAI_API_KEY" && test -z "$ANTHROPIC_API_KEY" && ! touch /usr/ltcook-evaluation-write-denied 2>/dev/null || exit 1; node .ltcook-evals/verify.cjs; echo "EXIT=$?"',
        };
      }
      if (index === 3 || (scenario === 'validation-recovery' && index === 4))
        command({
          type: 'report.create',
          assignmentId,
          summary: '20',
          evidence: 'Local verification passed',
          outcome: 'success',
          ...(scenario === 'validation-recovery' && index === 3
            ? { planId: 'unsupported-field', coverage: [] }
            : {}),
        });
      if (scenario === 'validation-recovery' && index === 4) {
        const feedback = input.messages
          .filter((message) => message.role === 'tool')
          .map((message) => JSON.stringify(message.content))
          .join('\n');
        assert(feedback.includes('[command.planId] unknown field'));
        assert(feedback.includes('[command.coverage] unknown field'));
        assert(!feedback.includes('[command.title] missing'));
      }
    } else {
      if (index === 0) {
        name = 'read';
        args = { path: '.ltcook-evals/input.json' };
      }
      if (index === 1)
        command({
          type: 'report.create',
          assignmentId,
          summary: '20',
          evidence: 'Read input and computed total',
          outcome: 'success',
        });
    }
    const id =
      scenario === 'validation-recovery'
        ? `fixture-${assignmentId}-${!bootstrap && index === 4 ? 3 : index}`
        : `fixture-${requests}`;
    const triggerCompaction =
      compactionScenario &&
      scenario !== 'settlement-recovery' &&
      bootstrap &&
      index === 0 &&
      (requests === 1 || scenario === 'compaction-error');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: unknown, reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: EVAL_MODEL, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
      );
    const recoverableLength = scenario === 'settlement-recovery' && bootstrap && index === 2;
    if (triggerCompaction || (scenario === 'settlement-recovery' && bootstrap && index === 0)) {
      send({
        role: 'assistant',
        content: 'Discardable context for the maintained compaction boundary. '.repeat(200),
      });
    }
    if (name) {
      assert(
        input.tools?.some((tool) => tool.function?.name === name),
        `Scripted tool ${name} must be declared in the actual model request`,
      );
      calls.push(name);
      if (name === 'bash' && scenario !== 'bad-verification') verificationCalls.add(id);
      send({
        role: 'assistant',
        tool_calls: [
          { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
        ],
      });
      send({}, 'tool_calls');
    } else {
      send({ role: 'assistant', content: 'Done.' });
      send({}, recoverableLength ? 'length' : 'stop');
    }
    if (
      triggerCompaction ||
      recoverableLength ||
      (scenario === 'settlement-recovery' && bootstrap && index < 2)
    ) {
      const promptTokens =
        scenario === 'settlement-recovery' && index < 2 ? 500 : EVAL_CONTEXT_WINDOW - 1024;
      response.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: EVAL_MODEL, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 } })}\n\n`,
      );
    }
    response.end('data: [DONE]\n\n');
  } catch (error) {
    failure = error;
    response.writeHead(500).end('Fixture error');
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const previousOpenAI = process.env.OPENAI_API_KEY;
const previousAnthropic = process.env.ANTHROPIC_API_KEY;
process.env.OPENAI_API_KEY = 'must-not-enter-evaluation';
process.env.ANTHROPIC_API_KEY = 'must-not-enter-evaluation';
try {
  const workspace = path.join(directory, 'current-workspace');
  await mkdir(workspace);
  await writeFile(
    path.join(workspace, 'AGENTS.md'),
    '# Current workspace guidance\nUse only the predefined evaluation scope.',
  );
  await writeFile(path.join(workspace, '.env'), 'PRIVATE_VALUE=must-not-be-snapshotted');
  const engine = createEvalEngine({
    resources: path.join(root, 'runtime/resources'),
    appRoot: root,
    ...(process.env.LTCOOK_TEST_NODE ? { nodeExecutable: process.env.LTCOOK_TEST_NODE } : {}),
    context: {
      teamSelection: 'default-minimal',
      guidanceDirectory: '',
      webConfiguration: {},
      limitations: [],
    },
    endpoint: `http://127.0.0.1:${address.port}`,
  });
  let checkpoint: Awaited<ReturnType<typeof engine>> | undefined;
  const input = {
    preset:
      scenario === 'full'
        ? 'full'
        : scenario === 'audit-error'
          ? 'audit'
          : [
                'quick',
                'current',
                'bad-verification',
                'masked-verification-failure',
                'no-delegation',
                'compaction',
                'compaction-cancel',
                'validation-recovery',
                'fallback-success',
                'no-scheduled-work',
                'settlement-recovery',
                'compaction-error',
              ].includes(scenario)
            ? 'quick'
            : 'behavior',
    setup: scenario === 'current' ? 'current' : 'synthetic',
    ...(scenario === 'current' ? { workspaceRoot: workspace } : {}),
    staticOnly: false,
    repetitions: scenario === 'repeated' ? 2 : 1,
    ...(scenario === 'repeated' ? { scenario: 'targeted-fix' as const } : {}),
    checkpoint: async (value: Awaited<ReturnType<typeof engine>>) => {
      checkpoint = value;
    },
    runDirectory: directory,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
    progress: ({ event }) => {
      if (['case.started', 'case.completed', 'case.failed'].includes(event))
        for (const execution of readdirSync(directory).filter((entry) =>
          entry.startsWith('.execution-'),
        ))
          assert(
            !readdirSync(path.join(directory, execution)).some((entry) =>
              entry.startsWith('case-'),
            ),
            'Release each attempt workspace before reporting completion or starting another case',
          );
    },
  } as const;
  if (scenario === 'audit-error') {
    await assert.rejects(engine(input), /semantic fixture error/);
    assert(checkpoint);
    assert(semanticRequests > 0);
    const saved = checkpoint as {
      result: {
        results: { semantic: { attempts: Array<{ success: boolean; failure?: string }> } };
      };
      trace: { traceEvents: Array<{ name: string; ph: string }> };
    };
    assert.equal(saved.result.results.semantic.attempts[0]?.success, false);
    assert.match(
      saved.result.results.semantic.attempts[0]?.failure ?? '',
      /semantic fixture error/,
    );
    assert(
      saved.trace.traceEvents.some(
        (event) => event.name === 'model.semantic-audit' && event.ph === 'E',
      ),
    );
    console.log(JSON.stringify({ result: 'passed', semanticRequests, failureCapture: true }));
  } else if (scenario === 'cancel' || scenario === 'compaction-cancel') {
    await assert.rejects(engine(input), /abort/i);
    if (scenario === 'compaction-cancel') {
      assert(compactions > 0);
      assert(checkpoint, 'Cancellation during compaction must preserve partial evidence');
      const events = (checkpoint.trace as { traceEvents: Array<{ name: string; ph: string }> })
        .traceEvents;
      assert(events.some((event) => event.name === 'model.compaction' && event.ph === 'B'));
      assert(events.some((event) => event.name === 'model.compaction' && event.ph === 'E'));
    } else assert(requests >= 5);
    console.log(
      JSON.stringify({ result: 'passed', cancellation: 'native model request', requests }),
    );
  } else {
    let result: Awaited<ReturnType<typeof engine>>;
    if (
      scenario === 'bad-verification' ||
      scenario === 'masked-verification-failure' ||
      scenario === 'no-delegation' ||
      scenario === 'compaction-error' ||
      scenario === 'no-scheduled-work'
    ) {
      await assert.rejects(engine(input), /failed after its low-reasoning fallback/);
      assert(checkpoint, 'Failed attempts must be checkpointed before the run rejects');
      result = checkpoint;
    } else result = await engine(input);
    if (failure) throw failure;
    const tasks = (
      result.result as {
        results: {
          behavior: {
            tasks: Array<{
              success: boolean;
              attempts: Array<{
                thinking: string;
                success: boolean;
                failure?: string;
                failureCategory?: string;
                delegations?: number;
                toolCalls: number;
                instructions: { promptSha256?: string; effectivePrompt?: string };
              }>;
            }>;
          };
        };
      }
    ).results.behavior.tasks;
    if (scenario === 'fallback-success') {
      assert.deepEqual(
        tasks[0]?.attempts.map((attempt) => [attempt.thinking, attempt.success]),
        [
          ['off', false],
          ['low', true],
        ],
      );
      assert(
        reasoningEfforts.has('none') && reasoningEfforts.has('low'),
        'Both reasoning settings must reach the provider',
      );
    }
    if (scenario === 'compaction-error') {
      assert.equal(
        compactions,
        2,
        'One failed summary per off/low attempt, not a repeated compaction loop',
      );
      assert(tasks.every((task) => !task.success && task.attempts.length === 2));
      assert(
        tasks.every((task) =>
          task.attempts.every((attempt) => attempt.failure?.includes('context compaction failed')),
        ),
      );
    }
    const observedPromptHashes = new Set(
      [...effectivePrompts.values()].map((prompts) => hash([...prompts.values()].join('\n\n'))),
    );
    for (const task of tasks)
      for (const attempt of task.attempts) {
        assert(attempt.instructions.promptSha256);
        assert(
          observedPromptHashes.has(attempt.instructions.promptSha256),
          'Loaded prompt evidence must hash the complete provider-observed standing context',
        );
      }
    assert.equal(
      tasks.length,
      ['behavior', 'full'].includes(scenario) ? 3 : scenario === 'repeated' ? 2 : 1,
    );
    if (scenario === 'full') {
      assert(semanticRequests > 0);
      assert.equal(
        steps.size,
        tasks.length * 2,
        'Full execution must reuse a behavior prompt instead of launching another task for capture',
      );
    }
    if (scenario === 'compaction') {
      assert(
        compactions > 0,
        'Production Pi must summarize context through the pinned local endpoint',
      );
      const events = (result.trace as { traceEvents: Array<{ name: string; ph: string }> })
        .traceEvents;
      assert(events.some((event) => event.name === 'model.compaction' && event.ph === 'B'));
      assert(events.some((event) => event.name === 'model.compaction' && event.ph === 'E'));
    }
    assert(tasks.every((task) => (task as { arm?: string }).arm === 'complete'));
    if (scenario === 'validation-recovery') {
      const events = (
        result.trace as {
          traceEvents: Array<{ name: string; args?: { status?: number; rawStopReason?: string } }>;
        }
      ).traceEvents;
      assert(
        events.some(
          (event) => event.name === 'evaluation.model.response' && event.args?.status === 200,
        ),
      );
      assert(
        events.some(
          (event) =>
            event.name === 'evaluation.model.stream' && event.args?.rawStopReason === 'tool_calls',
        ),
      );
      assert.equal(
        tasks.reduce(
          (sum, task) =>
            sum + task.attempts.reduce((count, attempt) => count + attempt.toolCalls, 0),
          0,
        ),
        calls.length,
        'Count rejected validation attempts once alongside executed calls',
      );
    }
    assert(
      tasks.every(
        (task) =>
          task.success ===
          ![
            'bad-verification',
            'masked-verification-failure',
            'no-delegation',
            'compaction-error',
            'no-scheduled-work',
          ].includes(scenario),
      ),
      JSON.stringify(
        tasks.map((task) =>
          task.attempts.map(({ failureCategory, failure, toolCalls, delegations }) => ({
            failureCategory,
            failure,
            toolCalls,
            delegations,
          })),
        ),
      ),
    );
    if (
      scenario === 'no-delegation' ||
      scenario === 'bad-verification' ||
      scenario === 'masked-verification-failure' ||
      scenario === 'no-scheduled-work'
    )
      assert(
        tasks.every((task) =>
          task.attempts.every((attempt) => attempt.failureCategory === 'criteria'),
        ),
        JSON.stringify(
          tasks.map((task) =>
            task.attempts.map(({ failureCategory, failure, toolCalls }) => ({
              failureCategory,
              failure,
              toolCalls,
            })),
          ),
        ),
      );
    if (scenario === 'no-delegation') {
      assert(tasks.every((task) => task.attempts.every((attempt) => attempt.delegations === 0)));
      assert(
        tasks.every((task) =>
          task.attempts.every((attempt) => attempt.failure?.includes('not delegated')),
        ),
      );
      assert.equal(
        verifiedCalls.size,
        tasks.reduce((count, task) => count + task.attempts.length, 0),
        'Every non-delegating attempt must successfully verify the corrected fixture',
      );
    }
    if (scenario === 'bad-verification' || scenario === 'masked-verification-failure')
      assert(
        tasks.every((task) =>
          task.attempts.every((attempt) =>
            attempt.failure?.includes('No successful fixture verification'),
          ),
        ),
      );
    if (scenario === 'no-scheduled-work')
      assert(
        tasks.every((task) =>
          task.attempts.every((attempt) =>
            attempt.failure?.includes('without registering a scenario Task'),
          ),
        ),
      );
    if (
      scenario !== 'no-delegation' &&
      scenario !== 'compaction-error' &&
      scenario !== 'no-scheduled-work'
    )
      assert(tasks.some((task) => task.attempts.some((attempt) => (attempt.delegations ?? 0) > 0)));
    assert(calls.includes('ltcook_team'));
    if (scenario === 'settlement-recovery') {
      assert(compactions > 0, 'Recover the completed handoff before declaring it settled');
      const events = (
        result.trace as { traceEvents: Array<{ name: string; args?: Record<string, unknown> }> }
      ).traceEvents;
      const ended = events.findIndex((event) => event.name === 'evaluation.agent.end');
      const compacted = events.findIndex(
        (event) => event.name === 'evaluation.compaction.start' && event.args?.willRetry === true,
      );
      const settled = events.findIndex((event) => event.name === 'evaluation.agent.settled');
      assert(
        ended >= 0 && compacted > ended && settled > compacted,
        'Recovery must occur after agent end and before settlement',
      );
    }
    if (scenario !== 'compaction-error' && scenario !== 'no-scheduled-work') {
      assert(calls.includes('read'));
      assert(calls.includes('write'));
      assert(calls.includes('bash'));
    }
    console.log(
      JSON.stringify({
        result: 'passed',
        requests,
        tasks: tasks.length,
        toolCalls: calls.length,
        requestTokenLimits,
      }),
    );
  }
  assert.deepEqual((await readdir(workspace)).sort(), ['.env', 'AGENTS.md']);
  assert(!(await readdir(directory)).some((entry) => entry.startsWith('.execution-')));
} catch (error) {
  throw failure ?? error;
} finally {
  if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAI;
  if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousAnthropic;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}

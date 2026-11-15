import { afterEach, expect, test } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import activate from '../../../runtime/src/integrations/pi-extension.js';
import { Telemetry } from '../../../runtime/src/diagnostics/telemetry.js';
import { readIncompleteEvaluationResult } from '../../../runtime/src/evals/runner.js';
import {
  EvaluationDiagnosticCollector,
  evaluationModelFailed,
  evaluationToolError,
  sanitizeEvaluationText,
} from '../../../runtime/src/evals/diagnostics.js';

const environment = { ...process.env };
test('provider JSON errors preserve only the sanitized error reason', () => {
  expect(
    sanitizeEvaluationText(
      '500: {"message":"tool parser failed", "type":"server_error", "request":"private"}',
    ),
  ).toBe('500: tool parser failed');
  expect(
    sanitizeEvaluationText('500: {"error":"model stream failed", "request":{"prompt":"private"}}'),
  ).toBe('500: model stream failed');
  expect(
    sanitizeEvaluationText(
      '500 {"error":{"message":"invalid tool call arguments: private", "body":"private"}}',
    ),
  ).toBe('500: invalid tool call arguments=<omitted>');
  expect(sanitizeEvaluationText('500: {not valid JSON')).toBe('500: <structured-data omitted>');
});
afterEach(() => {
  process.env = { ...environment };
});

test('diagnostic error text preserves the reason while excluding credentials, paths and payloads', () => {
  process.env.LTCOOK_AGENT_API_TOKEN = 'fixture-agent-credential';
  const message = sanitizeEvaluationText(
    'HTTP 401: Authorization: Bearer fixture-agent-credential; api_key="fixture-api-key"; password=fixture-password; https://fixture-user:fixture-pass@localhost/error /home/fixture/private/key request={"prompt":"private request text"}\nraw transcript',
  );
  expect(message).toContain('HTTP 401');
  for (const value of [
    'fixture-agent-credential',
    'fixture-api-key',
    'fixture-password',
    'fixture-user',
    'fixture-pass',
    '/home/fixture',
    'private request text',
    'raw transcript',
  ])
    expect(message).not.toContain(value);
  expect(sanitizeEvaluationText('x'.repeat(2000))).toHaveLength(1024);
  expect(sanitizeEvaluationText('Authorization: Basic Zml4dHVyZTpwYXNzd29yZA==')).not.toContain(
    'Zml4dHVyZTpwYXNzd29yZA==',
  );
  expect(
    evaluationToolError({
      content: [
        {
          type: 'text',
          text: 'ENOENT: cannot open "/tmp/fixture/private file"\nprivate file contents',
        },
      ],
      details: { command: 'private-command' },
    }),
  ).toBe('ENOENT: cannot open "<private-path>"');
});

test('Pi schema failures retain field reasons without copying received arguments', () => {
  let message = '';
  try {
    validateToolArguments(
      {
        name: 'validation-fixture',
        description: 'Validate a scheduled task input.',
        parameters: Type.Object({
          command: Type.Object({ title: Type.String(), scheduled: Type.Boolean() }),
        }),
      },
      {
        type: 'toolCall',
        id: 'call-validation',
        name: 'validation-fixture',
        arguments: {
          command: { scheduled: { body: 'private argument payload' }, prompt: 'private prompt' },
        },
      },
    );
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  expect(message).toContain('Received arguments:');
  const summary = evaluationToolError({ content: [{ type: 'text', text: message }] });
  expect(summary).toContain('command.title');
  expect(summary).toContain('missing');
  expect(summary).toContain('command.scheduled');
  expect(summary).toContain('boolean');
  expect(summary).not.toContain('private argument payload');
  expect(summary).not.toContain('private prompt');
  expect(summary).not.toContain('Received arguments:');
  const collector = new EvaluationDiagnosticCollector();
  collector.observe('agent', {
    kind: 'tool.end',
    tool: 'validation-fixture',
    callId: 'call-validation',
    isError: true,
    error: summary,
  });
  expect(collector.snapshot().toolFailures[0]?.error).toContain('command.title');
  expect(collector.snapshot().toolFailures[0]?.error).toContain('boolean');
});

test('length is a terminal model failure without guessing which length limit ended the response', () => {
  for (const reason of ['length', 'error', 'aborted'])
    expect(evaluationModelFailed(reason)).toBe(true);
  for (const reason of ['stop', 'toolUse', undefined])
    expect(evaluationModelFailed(reason)).toBe(false);
  const collector = new EvaluationDiagnosticCollector();
  collector.observe('agent', { kind: 'model.start' });
  collector.observe('agent', {
    kind: 'model.end',
    stopReason: 'length',
    rawStopReason: 'length',
    usage: { input: 5377, output: 62, cacheRead: 2753, totalTokens: 8192 },
  });
  collector.observe('agent', { kind: 'agent.end' });
  const state = collector.snapshot();
  expect(state.modelFailures).toMatchObject([
    {
      stopReason: 'length',
      rawStopReason: 'length',
      usage: { input: 5377, output: 62, cacheRead: 2753, totalTokens: 8192 },
    },
  ]);
  expect(state.modelFailures[0]?.error).toBeUndefined();
  expect(state.activeModels).toEqual([]);
});

test('diagnostics retain failure causes and live work without copying prompts or task content', () => {
  const collector = new EvaluationDiagnosticCollector();
  collector.observe('agent-1', { kind: 'agent.start' });
  collector.observe('agent-1', { kind: 'prompt', prompt: 'private prompt' });
  expect(collector.observe('agent-1', { kind: 'private unknown event body' })).toBeUndefined();
  collector.observe('agent-1', { kind: 'model.start' });
  collector.observe('agent-1', {
    kind: 'model.end',
    stopReason: 'error',
    rawStopReason: 'provider_error',
    error: 'HTTP 400: context limit exceeded',
    usage: { input: 8192, output: 0, cost: { input: 1 }, prompt: 'private usage payload' },
    request: 'private request',
  });
  collector.observe('agent-1', {
    kind: 'tool.start',
    tool: 'bash',
    callId: 'call-1',
    command: 'private command',
  });
  collector.observe('agent-1', {
    kind: 'tool.end',
    tool: 'bash',
    callId: 'call-1',
    isError: true,
    error: 'Command exited with code 1',
    durationMs: 4,
    output: 'private output',
  });
  collector.observe('agent-1', {
    kind: 'runtime.error',
    operation: 'coordination',
    status: 400,
    commandType: 'task.update',
    hasPassId: true,
    passId: 'private-pass-reference',
    error: 'Task has unmet dependencies',
  });
  collector.observe('agent-1', { kind: 'model.start' });
  collector.observe('agent-1', { kind: 'tool.start', tool: 'read', callId: 'call-2' });
  const state = collector.snapshot({
    passes: [{ id: 'pass-1', status: 'running' }],
    tasks: [{ id: 'task-1', status: 'running', phase: 'implementation', assigneeKey: 'main' }],
    assignments: [{ id: 'assignment-1', taskId: 'task-1', memberKey: 'main', status: 'sent' }],
    members: [{ member: { key: 'main' }, binding: { state: 'bound' }, nativeStatus: 'running' }],
    blockers: ['private blocker text'],
  });
  expect(state.modelFailures).toMatchObject([
    {
      stopReason: 'error',
      rawStopReason: 'provider_error',
      error: 'HTTP 400: context limit exceeded',
      usage: { input: 8192, output: 0 },
    },
  ]);
  expect(state.toolFailures).toMatchObject([
    { tool: 'bash', callId: 'call-1', error: 'Command exited with code 1', durationMs: 4 },
  ]);
  expect(state.runtimeFailures).toMatchObject([
    {
      operation: 'coordination',
      status: 400,
      commandType: 'task.update',
      hasPassId: true,
      error: 'Task has unmet dependencies',
    },
  ]);
  expect(state.activeAgents).toEqual(['agent-1']);
  expect(state.activeModels).toEqual(['agent-1']);
  expect(state.activeTools).toEqual([{ agentId: 'agent-1', callId: 'call-2', tool: 'read' }]);
  expect(state.runtime?.tasks).toEqual([
    { id: 'task-1', status: 'running', phase: 'implementation', assigneeKey: 'main' },
  ]);
  expect(state.runtime?.blockerCount).toBe(1);
  expect(JSON.stringify(state)).not.toContain('private');
  collector.observe('agent-1', { kind: 'model.end', stopReason: 'stop' });
  collector.observe('agent-1', { kind: 'tool.end', tool: 'read', callId: 'call-2' });
  collector.observe('agent-1', { kind: 'agent.end' });
  expect(collector.snapshot().activeModels).toEqual([]);
  expect(collector.snapshot().activeAgents).toEqual([]);
  expect(collector.snapshot().activeTools).toEqual([]);
});

test('diagnostic histories remain bounded and retain the latest failures', () => {
  const collector = new EvaluationDiagnosticCollector();
  for (let index = 0; index < 100; index++) {
    collector.observe('agent', {
      kind: 'model.end',
      stopReason: 'aborted',
      error: `failure-${index}`,
    });
    collector.observe('agent', {
      kind: 'tool.end',
      isError: true,
      tool: 'read',
      callId: String(index),
    });
    collector.runtimeEvent({ type: 'scheduler.end', taskId: String(index) });
  }
  const state = collector.snapshot();
  expect(state.recentEvents).toHaveLength(64);
  expect(state.modelFailures).toHaveLength(8);
  expect(state.toolFailures).toHaveLength(16);
  expect(state.modelFailures.at(-1)?.error).toBe('failure-99');
});

test('sanitized failure metadata survives export in the existing Perfetto trace', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ltcook-diagnostic-trace-'));
  try {
    const tracePath = path.join(directory, 'trace.json');
    const telemetry = new Telemetry(path.join(directory, 'events.jsonl'), tracePath);
    const collector = new EvaluationDiagnosticCollector();
    const diagnostic = collector.observe('agent', {
      kind: 'model.end',
      stopReason: 'error',
      error: 'HTTP 503: server startup discovery timeout token=fixture-secret',
      body: 'private body',
    });
    telemetry.instant(
      'evaluation.model.end',
      { ...diagnostic, authorization: 'fixture-authorization' },
      'agent',
    );
    await telemetry.exportTrace();
    const trace = JSON.parse(await readFile(tracePath, 'utf8'));
    expect(trace.traceEvents).toMatchObject([
      {
        name: 'evaluation.model.end',
        ph: 'i',
        s: 't',
        tid: 'agent',
        args: {
          stopReason: 'error',
          error: 'HTTP 503: server startup discovery timeout token=<redacted>',
          authorization: '<redacted>',
        },
      },
    ]);
    expect(JSON.stringify(trace)).not.toContain('fixture-secret');
    expect(JSON.stringify(trace)).not.toContain('private body');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('forced termination recovery keeps available active-attempt evidence explicitly incomplete', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ltcook-diagnostic-recovery-'));
  const state = path.join(directory, 'deployment/state');
  await mkdir(state, { recursive: true });
  try {
    const collector = new EvaluationDiagnosticCollector();
    collector.observe('agent', { kind: 'agent.start' });
    collector.observe('agent', { kind: 'model.start' });
    await writeFile(
      path.join(state, 'diagnostics.json'),
      JSON.stringify({ diagnostics: collector.snapshot(), toolCalls: 3, elapsedMs: 10 }),
    );
    const telemetry = new Telemetry(
      path.join(state, 'events.jsonl'),
      path.join(state, 'trace.json'),
    );
    telemetry.instant('evaluation.tool.start', { tool: 'read' });
    await telemetry.exportTrace();
    const result = await readIncompleteEvaluationResult(directory, 'limits', 25);
    expect(result).toMatchObject({
      success: false,
      failureCategory: 'limits',
      elapsedMs: 25,
      toolCalls: 3,
      diagnostics: { captureIncomplete: true, activeAgents: ['agent'], activeModels: ['agent'] },
      trace: { traceEvents: [{ name: 'evaluation.tool.start', ph: 'i' }] },
    });
    expect(result?.limitations?.[0]).toContain('exported prefix');
    await writeFile(path.join(state, 'diagnostics.json'), 'incomplete JSON');
    const traceOnly = await readIncompleteEvaluationResult(directory, 'cancelled', 30);
    expect(traceOnly).toMatchObject({
      success: false,
      failureCategory: 'cancelled',
      toolCalls: 1,
      diagnostics: { captureIncomplete: true },
    });
    await writeFile(path.join(state, 'trace.json'), 'incomplete JSON');
    expect(await readIncompleteEvaluationResult(directory, 'cancelled', 40)).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pi evaluation observations publish actual sanitized errors and agent lifecycle', async () => {
  const observed: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/v1/command')
        return Response.json(
          { error: 'Task has unmet dependencies token=fixture-secret' },
          { status: 400 },
        );
      observed.push((await request.json()) as Record<string, unknown>);
      return Response.json({});
    },
  });
  try {
    Object.assign(process.env, {
      LTCOOK_NATIVE_AGENT_ID: 'agent',
      LTCOOK_SESSION_ID: 'session',
      LTCOOK_TEAM_INSTANCE_ID: 'instance',
      LTCOOK_TEAM_ID: '@ltcook/team-default-minimal',
      LTCOOK_MEMBER_KEY: 'main',
      LTCOOK_RUNTIME_API_URL: `http://127.0.0.1:${server.port}`,
      LTCOOK_AGENT_API_TOKEN: 'fixture-agent-token',
      LTCOOK_TEAM: 'default-minimal',
      LTCOOK_BROWSER_ENABLED: 'false',
      LTCOOK_EVAL_ARM: 'complete',
    });
    const handlers = new Map<string, (event: unknown, context?: unknown) => Promise<unknown>>();
    const tools = new Map<string, Parameters<ExtensionAPI['registerTool']>[0]>();
    await activate({
      on(name: string, handler: unknown) {
        handlers.set(name, handler as (event: unknown, context?: unknown) => Promise<unknown>);
      },
      registerTool(tool: Parameters<ExtensionAPI['registerTool']>[0]) {
        tools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI);
    const successful = {
      role: 'toolResult',
      isError: false,
      content: [{ type: 'text', text: 'Successful output' }],
    };
    const messages = (await handlers.get('context')!({
      messages: [
        {
          role: 'toolResult',
          isError: true,
          content: [
            {
              type: 'text',
              text:
                'Validation failed for tool "ltcook_team":\n - command.passId: missing\nReceived arguments: ' +
                'private'.repeat(2000),
            },
          ],
        },
        successful,
      ],
    })) as { messages: Array<{ isError: boolean; content: Array<{ text: string }> }> };
    expect(messages.messages[0]!.isError).toBe(true);
    expect(messages.messages[0]!.content[0]!.text).toContain('[command.passId] missing');
    expect(messages.messages[0]!.content[0]!.text).not.toContain('private');
    expect(messages.messages[0]!.content[0]!.text.length).toBeLessThan(1025);
    expect(messages.messages[1]).toBe(successful);
    await handlers.get('agent_start')!({}, { getSystemPrompt: () => 'private prompt' });
    await handlers.get('message_end')!({
      message: {
        role: 'assistant',
        stopReason: 'error',
        rawStopReason: 'provider_error',
        errorMessage: 'HTTP 400: context limit api_key=fixture-key',
        usage: {},
      },
    });
    await handlers.get('tool_execution_end')!({
      toolName: 'bash',
      toolCallId: 'call-1',
      durationMs: 2,
      isError: true,
      result: {
        content: [{ type: 'text', text: 'Command exited with code 1\nprivate command output' }],
      },
    });
    const tool = tools.get('ltcook_team')!;
    await expect(
      tool.execute(
        'command-1',
        { command: { type: 'task.update', taskId: 'task-1', status: 'completed' } },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(
      'Coordination request failed (400): Task has unmet dependencies token=<redacted>',
    );
    await handlers.get('agent_end')!({});
    expect(observed.filter(({ kind }) => kind !== 'prompt')).toMatchObject([
      { kind: 'agent.start' },
      {
        kind: 'model.end',
        stopReason: 'error',
        rawStopReason: 'provider_error',
        error: 'HTTP 400: context limit api_key=<redacted>',
      },
      { kind: 'tool.end', error: 'Command exited with code 1', isError: true },
      {
        kind: 'runtime.error',
        status: 400,
        commandType: 'task.update',
        hasPassId: false,
        error: 'Task has unmet dependencies token=<redacted>',
      },
      { kind: 'agent.end' },
    ]);
    expect(JSON.stringify(observed.filter(({ kind }) => kind !== 'prompt'))).not.toContain(
      'private',
    );
  } finally {
    server.stop(true);
  }
});

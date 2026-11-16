import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { evaluationToolError } from '../../../runtime/src/evals/diagnostics.js';
import {
  ollamaCoordinationPayload,
  ollamaCoordinationSchema,
} from '../../../runtime/src/evals/ollama-schema.js';
import { compile } from '@earendil-works/pi-schema';
import {
  AgentRuntimeCommandInputSchema,
  RuntimeCommandInputSchema,
} from '../../../runtime/src/workflow-api/commands.js';

test('agent execution task schema requires a Pass while user backlog and nonexecution tasks remain valid', () => {
  const task = {
    type: 'task.create',
    title: 'Task',
    description: 'Fixture work',
    acceptance: 'Correct result',
  };
  expect(Value.Check(AgentRuntimeCommandInputSchema, { command: task })).toBe(false);
  expect(
    Value.Check(AgentRuntimeCommandInputSchema, { command: { ...task, workType: 'task.execute' } }),
  ).toBe(false);
  expect(
    Value.Check(AgentRuntimeCommandInputSchema, { command: { ...task, passId: 'active-pass' } }),
  ).toBe(true);
  expect(Value.Check(AgentRuntimeCommandInputSchema, { command: { ...task, passId: '' } })).toBe(
    false,
  );
  expect(Value.Check(RuntimeCommandInputSchema, { command: task })).toBe(true);
  for (const workType of ['design', 'task.investigate'])
    expect(Value.Check(AgentRuntimeCommandInputSchema, { command: { ...task, workType } })).toBe(
      true,
    );
  expect(
    Value.Check(AgentRuntimeCommandInputSchema, {
      command: { type: 'planning.approve', planId: 'plan' },
    }),
  ).toBe(false);
  const newPass = { command: { type: 'pass.create', title: 'New work' } };
  expect(Value.Check(AgentRuntimeCommandInputSchema, newPass)).toBe(false);
  expect(Value.Check(RuntimeCommandInputSchema, newPass)).toBe(true);
});

test('native report validation identifies the report fields instead of unrelated task requirements', () => {
  const report = {
    type: 'report.create',
    assignmentId: 'assigned-work',
    summary: 'Work complete',
    evidence: 'Observed result',
    outcome: 'success',
  };
  expect(Value.Check(AgentRuntimeCommandInputSchema, { command: report })).toBe(true);
  let message = '';
  try {
    validateToolArguments(
      {
        name: 'ltcook_team',
        description: 'Coordination',
        parameters: AgentRuntimeCommandInputSchema,
      },
      {
        type: 'toolCall',
        id: 'bad-report',
        name: 'ltcook_team',
        arguments: { command: { ...report, planId: 'private-plan', coverage: [] } },
      },
    );
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  expect(message).toContain('Validation failed');
  const reason = evaluationToolError({ content: [{ type: 'text', text: message }] });
  expect(reason).toContain('[command.planId] unknown field');
  expect(reason).toContain('[command.coverage] unknown field');
  expect(reason).not.toContain('command.title');
  expect(reason).not.toContain('private-plan');
});

test('an unknown native coordination command identifies the allowed command types without task fields', () => {
  let message = '';
  try {
    validateToolArguments(
      {
        name: 'ltcook_team',
        description: 'Coordination',
        parameters: AgentRuntimeCommandInputSchema,
      },
      {
        type: 'toolCall',
        id: 'unknown-command',
        name: 'ltcook_team',
        arguments: { command: { type: 'inspection', inspection: 'private argument' } },
      },
    );
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  const reason = evaluationToolError({ content: [{ type: 'text', text: message }] });
  expect(reason).toContain('[command.type] expected one of');
  expect(reason).toContain('guidance.inspect');
  expect(reason).not.toContain('command.title');
  expect(reason).not.toContain('private argument');
});

test('evaluation feedback identifies a rejected command without exposing its arguments', () => {
  let message = '';
  try {
    validateToolArguments(
      {
        name: 'ltcook_team',
        description: 'Coordination',
        parameters: AgentRuntimeCommandInputSchema,
      },
      {
        type: 'toolCall',
        id: 'bad-task',
        name: 'ltcook_team',
        arguments: {
          command: { type: 'task.create', taskId: 'private-task-id', status: 'completed' },
        },
      },
    );
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  const feedback = evaluationToolError({ content: [{ type: 'text', text: message }] });
  expect(feedback).toContain('Command type: task.create.');
  expect(feedback).toContain('Present fields: taskId, status.');
  expect(feedback).toContain('Status: completed.');
  expect(feedback).not.toContain('private-task-id');
  const unsafe = evaluationToolError({
    content: [
      {
        type: 'text',
        text:
          'Validation failed for tool "ltcook_team":\n  - command.status: unknown field\n\nReceived arguments:\n' +
          JSON.stringify({ command: { type: 'task.create', status: 'private-payload' } }),
      },
    ],
  });
  expect(unsafe).toContain('Status value type: string.');
  expect(unsafe).not.toContain('private-payload');
});

test('Ollama coordination schema preserves commands and execution Pass requirements', () => {
  const original = JSON.parse(JSON.stringify(AgentRuntimeCommandInputSchema));
  const projected = ollamaCoordinationSchema(original) as typeof original;
  const originalValidator = compile(original);
  const projectedValidator = compile(projected);
  const task = { type: 'task.create', title: 'T', description: 'D', acceptance: 'A' };
  const cases = [
    task,
    { ...task, passId: 'pass' },
    { ...task, passId: '' },
    { ...task, workType: 'task.execute' },
    { ...task, workType: 'task.execute', passId: 'pass' },
    { ...task, workType: 'design' },
    { ...task, workType: 'task.investigate', passId: '' },
    { type: 'task.update', taskId: 'task', status: 'completed' },
    { type: 'task.update', taskId: 'task', status: 'ready' },
    { type: 'planning.approve', planId: 'plan' },
  ];
  for (const command of cases)
    expect(projectedValidator.check({ command })).toBe(originalValidator.check({ command }));
  for (const branch of AgentRuntimeCommandInputSchema.properties.command.anyOf) {
    const command = Value.Create(branch) as Record<string, unknown>;
    if (command.type === 'task.create') command.passId = 'pass';
    expect(originalValidator.check({ command })).toBe(true);
    expect(projectedValidator.check({ command })).toBe(true);
    for (const field of branch.required ?? []) {
      const incomplete = { ...command };
      delete incomplete[field];
      expect(projectedValidator.check({ command: incomplete })).toBe(
        originalValidator.check({ command: incomplete }),
      );
    }
    const extra = { ...command, unrelatedField: 'not accepted' };
    expect(projectedValidator.check({ command: extra })).toBe(
      originalValidator.check({ command: extra }),
    );
  }
  const branches = projected.properties.command.anyOf;
  expect(branches).toHaveLength(original.properties.command.anyOf.length);
  expect(branches.every((branch: any) => branch.properties.type.enum?.length === 1)).toBe(true);
  const create = branches.find((branch: any) => branch.properties.type.enum?.[0] === 'task.create');
  expect(create.anyOf).toHaveLength(2);
  expect(create.anyOf[0].properties.passId.description).toContain('must not be empty');
  expect(create.properties.requestId.description).toContain('must not be empty');
  expect(original.properties.command.anyOf[0].properties.type.const).toBe('planning.show');
  const payload = {
    tools: [
      { type: 'function', function: { name: 'ltcook_team', parameters: original } },
      { type: 'function', function: { name: 'read', parameters: { const: 'unchanged' } } },
    ],
  };
  const converted = ollamaCoordinationPayload(payload) as typeof payload;
  expect(converted.tools[0]?.function.parameters).toEqual(projected);
  expect(converted.tools[1]).toBe(payload.tools[1]);
  expect(payload.tools[0]?.function.parameters).toBe(original);
});

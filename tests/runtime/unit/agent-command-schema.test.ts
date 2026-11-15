import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { evaluationToolError } from '../../../runtime/src/evals/diagnostics.js';
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

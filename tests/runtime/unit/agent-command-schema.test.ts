import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
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

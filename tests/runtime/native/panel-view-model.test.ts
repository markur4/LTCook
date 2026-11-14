import { expect, test } from 'bun:test';
import {
  acceptPanelResponse,
  completeSessionOpen,
  progress,
  currentAssignments,
  taskGroups,
} from '../../../runtime/src/paseo-plugin/shared/view-model';
import {
  panelDetail,
  type PanelDetailSource,
} from '../../../runtime/src/paseo-plugin/shared/panel-details';

test('a completed open refreshes returned-to workspace without clearing another pending open', () => {
  expect(acceptPanelResponse('B', 2, 'A', 1)).toBe(false);
  expect(acceptPanelResponse('A', 3, 'A', 1)).toBe(false);
  const pending = new Set(['A', 'B']);
  expect(completeSessionOpen(pending, 'A', 'A', true, true)).toEqual({
    pendingRoots: new Set(['B']),
    refreshRoot: 'A',
  });
  expect(pending).toEqual(new Set(['A', 'B']));
  expect(completeSessionOpen(pending, 'A', 'B', true, true).refreshRoot).toBeNull();
  expect(completeSessionOpen(pending, 'A', 'A', false, true).refreshRoot).toBeNull();
  expect(completeSessionOpen(pending, 'A', 'A', true, false).refreshRoot).toBeNull();
  expect(progress([])).toEqual({ completed: 0, total: 0 });
});

test('details are selected by identity and reports follow owned assignments across native handles', () => {
  const source: PanelDetailSource = {
    tasks: [
      {
        id: 't',
        title: 'Task',
        status: 'blocked',
        description: 'details',
        acceptance: 'acceptance',
        blocker: '',
      },
    ],
    members: [
      { member: { key: 'main' }, binding: { nativeAgentId: null, blocker: 'model unavailable' } },
    ],
    assignments: [
      { id: 'old', memberKey: 'main', taskId: 't', status: 'reported', handoff: 'owned handoff' },
      { id: 'other', memberKey: 'other', taskId: 't', status: 'sent', handoff: 'PRIVATE_OTHER' },
    ],
    reports: [
      { id: 'report', assignmentId: 'old', taskId: 't', summary: 'owned report' },
      { id: 'other-report', assignmentId: 'other', taskId: 't', summary: 'PRIVATE_OTHER' },
    ],
    blockers: ['coordination'],
  };
  const member = panelDetail(source, { kind: 'member', memberKey: 'main' });
  expect(member).toMatchObject({
    latestHandoff: { handoff: 'owned handoff' },
    latestReport: { summary: 'owned report' },
    bindingBlocker: 'model unavailable',
  });
  expect(JSON.stringify(member)).not.toContain('PRIVATE_OTHER');
  expect(panelDetail(source, { kind: 'issues' })).toEqual({
    kind: 'issues',
    blockers: ['coordination'],
    taskIssues: [{ taskId: 't', taskTitle: 'Task', status: 'blocked', blocker: '' }],
  });
  expect(panelDetail(source, { kind: 'task', taskId: 'missing' })).toBeNull();
  expect(panelDetail(source, { kind: 'task', taskId: 't' })).toMatchObject({
    description: 'details',
    phase: null,
    blocker: '',
  });
});

test('board preserves unknown states and current assignments use identity and nonterminal work', () => {
  const snapshot = {
    teamId: 'team',
    teamName: 'Team',
    members: [],
    passes: [],
    issues: [],
    tasks: ['running', 'failed', 'blocked', 'completed', 'custom'].map((status, index) => ({
      taskId: String(index),
      title: 'Same title',
      status,
      passId: null,
      passTitle: null,
      steps: [],
    })),
    assignments: [
      {
        assignmentId: 'reported',
        taskId: '0',
        taskTitle: 'Same title',
        memberName: 'Same name',
        memberKey: 'main',
        status: 'reported',
      },
      {
        assignmentId: 'failed-task',
        taskId: '1',
        taskTitle: 'Same title',
        memberName: 'Same name',
        memberKey: 'main',
        status: 'sent',
      },
      {
        assignmentId: 'uncertain',
        taskId: '2',
        taskTitle: 'Same title',
        memberName: 'Same name',
        memberKey: 'worker',
        status: 'uncertain',
      },
      {
        assignmentId: 'completed-task',
        taskId: '3',
        taskTitle: 'Same title',
        memberName: 'Same name',
        memberKey: 'main',
        status: 'pending',
      },
      {
        assignmentId: 'active',
        taskId: '0',
        taskTitle: 'Same title',
        memberName: 'Same name',
        memberKey: 'main',
        status: 'sent',
      },
    ],
  };
  expect(currentAssignments(snapshot, 'main').map((item) => item.assignmentId)).toEqual(['active']);
  expect(currentAssignments(snapshot, 'worker').map((item) => item.assignmentId)).toEqual([
    'uncertain',
  ]);
  expect(
    taskGroups(snapshot)
      .find((group) => group.status === 'Other')
      ?.tasks.map((task) => task.taskId),
  ).toEqual(['4']);
  expect(progress(snapshot.tasks)).toEqual({ completed: 1, total: 5 });
});

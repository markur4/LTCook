import { describe, expect, test } from 'bun:test';
import { panelSnapshot } from '../../../runtime/src/paseo-plugin/shared/panel-snapshot.js';

describe('Paseo panel snapshot', () => {
  test('projects readable work titles and ordered Steps without private work content', () => {
    const input = {
      session: { teamId: 'team' },
      definition: { name: 'Test team' },
      members: [
        {
          member: {
            key: 'main',
            name: 'Main',
            modelAlias: 'smart',
            thinking: 'high',
            readOnly: false,
            lifetime: 'persistent' as const,
          },
          binding: { nativeAgentId: 'native-main' },
          nativeStatus: 'idle',
        },
      ],
      passes: [
        {
          id: 'pass-1',
          title: 'Release integration',
          status: 'running' as const,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      tasks: [
        {
          id: 'task-1',
          passId: 'pass-1',
          title: 'Integrate runtime',
          status: 'running' as const,
          description: 'PRIVATE_DESCRIPTION',
          acceptance: 'PRIVATE_ACCEPTANCE',
          report: 'PRIVATE_REPORT',
          blocker: 'PRIVATE_BLOCKER',
        },
        {
          id: 'task-2',
          title: 'Update docs',
          status: 'completed' as const,
          description: 'PRIVATE_STANDALONE_DESCRIPTION',
          acceptance: 'PRIVATE_STANDALONE_ACCEPTANCE',
          report: 'PRIVATE_STANDALONE_REPORT',
          blocker: 'PRIVATE_STANDALONE_BLOCKER',
        },
      ],
      steps: [
        {
          id: 'step-2',
          taskId: 'task-1',
          title: 'Run checks',
          position: 2,
          status: 'pending' as const,
        },
        {
          id: 'step-1',
          taskId: 'task-1',
          title: 'Update implementation',
          position: 0,
          status: 'completed' as const,
        },
      ],
      assignments: [
        {
          id: 'assignment-1',
          taskId: 'task-1',
          memberKey: 'main',
          status: 'sent' as const,
          handoff: 'PRIVATE_HANDOFF',
        },
      ],
      blockers: ['PRIVATE_COORDINATION_BLOCKER'],
    };
    const snapshot = panelSnapshot(input);

    expect(snapshot.members[0]?.name).toBe('Main');
    expect(snapshot.assignments).toEqual([
      {
        assignmentId: 'assignment-1',
        taskId: 'task-1',
        taskTitle: 'Integrate runtime',
        memberName: 'Main',
        memberKey: 'main',
        status: 'sent',
      },
    ]);
    expect(snapshot.passes).toEqual([
      {
        passId: 'pass-1',
        title: 'Release integration',
        status: 'running',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(snapshot.tasks).toEqual([
      {
        taskId: 'task-1',
        title: 'Integrate runtime',
        status: 'running',
        passId: 'pass-1',
        passTitle: 'Release integration',
        steps: [
          { stepId: 'step-1', title: 'Update implementation', status: 'completed', position: 0 },
          { stepId: 'step-2', title: 'Run checks', status: 'pending', position: 2 },
        ],
      },
      {
        taskId: 'task-2',
        title: 'Update docs',
        status: 'completed',
        passId: null,
        passTitle: null,
        steps: [],
      },
    ]);

    const projected = JSON.stringify(snapshot);
    for (const privateValue of [
      'PRIVATE_DESCRIPTION',
      'PRIVATE_ACCEPTANCE',
      'PRIVATE_REPORT',
      'PRIVATE_BLOCKER',
      'PRIVATE_STANDALONE_DESCRIPTION',
      'PRIVATE_STANDALONE_ACCEPTANCE',
      'PRIVATE_STANDALONE_REPORT',
      'PRIVATE_STANDALONE_BLOCKER',
      'PRIVATE_HANDOFF',
      'PRIVATE_COORDINATION_BLOCKER',
    ]) {
      expect(projected).not.toContain(privateValue);
    }
    expect(snapshot.issues).toContain('Coordination blockers: 1');
  });
});

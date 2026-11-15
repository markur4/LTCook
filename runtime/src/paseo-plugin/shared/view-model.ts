import type { TeamStatusSnapshot } from './panel-snapshot';

export const workStates = [
  'pending',
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const;
export function taskGroups(snapshot: TeamStatusSnapshot) {
  return [
    ...workStates.map((status) => ({
      status,
      tasks: snapshot.tasks.filter((task) => task.status === status),
    })),
    {
      status: 'Other',
      tasks: snapshot.tasks.filter((task) => !workStates.some((status) => status === task.status)),
    },
  ];
}
export function progress(items: readonly { status: string }[]) {
  return {
    completed: items.filter((item) => item.status === 'completed').length,
    total: items.length,
  };
}
export function currentAssignments(snapshot: TeamStatusSnapshot, memberKey?: string) {
  const current = new Set(
    snapshot.tasks
      .filter((task) => ['pending', 'running', 'blocked'].includes(task.status))
      .map((task) => task.taskId),
  );
  return snapshot.assignments.filter(
    (item) =>
      (!memberKey || item.memberKey === memberKey) &&
      current.has(item.taskId) &&
      ['pending', 'sending', 'sent', 'uncertain'].includes(item.status),
  );
}
export function acceptPanelResponse(
  currentSessionId: string,
  currentVersion: number,
  responseSessionId: string,
  responseVersion: number,
): boolean {
  return currentSessionId === responseSessionId && currentVersion === responseVersion;
}

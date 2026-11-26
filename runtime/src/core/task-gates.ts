import type { CoordinationStore } from '../storage/coordination.js';
import type { Approval, Task } from '../workflow-api/index.js';

export function taskGateBlockers(
  store: Pick<CoordinationStore, 'getTask' | 'listApprovals'>,
  sessionId: string,
  task: Task,
  projection?: { tasks: ReadonlyMap<string, Task>; approvals: readonly Approval[] },
): string[] {
  const reasons: string[] = [];
  for (const dependencyId of task.dependencyIds ?? []) {
    const dependency =
      projection?.tasks.get(dependencyId) ?? store.getTask(sessionId, dependencyId);
    if (dependency.status !== 'completed')
      reasons.push(`Dependency ${dependency.id} is ${dependency.status}`);
  }
  for (const scope of task.approvalScopes ?? []) {
    const approval = (projection?.approvals ?? store.listApprovals(sessionId))
      .filter(
        (item) =>
          item.scope.action === scope.action &&
          item.scope.resourceId === scope.resourceId &&
          item.scope.revision === scope.revision,
      )
      .at(-1);
    if (approval?.decision !== 'approved')
      reasons.push(`Approval required: ${scope.action} ${scope.resourceId} ${scope.revision}`);
  }
  return reasons;
}

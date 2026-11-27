import type { CoordinationStore } from '../storage/coordination.js';
import type {
  MemberSnapshot,
  Session,
  SessionSnapshot,
  Task,
  TeamDefinition,
} from '../workflow-api/index.js';
import type { PlanningWorkflow } from './planning.js';
import { taskGateBlockers } from './task-gates.js';

type SessionSnapshotStore = Pick<
  CoordinationStore,
  | 'getTask'
  | 'listApprovals'
  | 'listAssignments'
  | 'listBindings'
  | 'listPasses'
  | 'listReports'
  | 'listReviews'
  | 'listSteps'
  | 'listTasks'
>;

type SessionSnapshotInput = {
  session: Session;
  teamDefinition(): TeamDefinition;
  store: SessionSnapshotStore;
  planning: Pick<PlanningWorkflow, 'documentsDirectory' | 'list' | 'decisions'>;
  nativeStatus(nativeAgentId: string): string | undefined;
};

export function projectSessionSnapshot({
  session,
  teamDefinition,
  store,
  planning,
  nativeStatus,
}: SessionSnapshotInput): SessionSnapshot {
  const sessionId = session.id;
  const bindings = store.listBindings(sessionId);
  const bindingsByMember = new Map(bindings.map((binding) => [binding.memberKey, binding]));
  const definition = teamDefinition();
  const members: MemberSnapshot[] = definition.members.map((member) => {
    const binding = bindingsByMember.get(member.key) ?? null;
    return {
      member,
      binding,
      nativeStatus:
        binding?.state === 'bound' && binding.nativeAgentId
          ? (nativeStatus(binding.nativeAgentId) ?? null)
          : null,
    };
  });
  const assignments = store.listAssignments(sessionId);
  const tasks = store.listTasks(sessionId);
  const approvals = store.listApprovals(sessionId);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const handoffsByPass = new Map<string | undefined, Task>();
  for (const task of tasks) {
    if (task.requestId?.endsWith(':execution-handoff') && !handoffsByPass.has(task.passId))
      handoffsByPass.set(task.passId, task);
  }
  const blockers = bindings
    .filter(
      (binding) =>
        binding.state === 'missing' ||
        binding.state === 'uncertain' ||
        binding.state === 'creating',
    )
    .map((binding) => `${binding.memberKey}: ${binding.blocker ?? binding.state}`);
  for (const task of tasks) {
    if (task.scheduled && !['completed', 'failed', 'cancelled'].includes(task.status)) {
      const barrier = handoffsByPass.get(task.passId);
      if (barrier?.status !== 'completed')
        blockers.push(`Task ${task.id}: Waiting for Leader to complete initial Task registration`);
      if (task.phase === 'review' && task.assigneeKey === undefined)
        blockers.push(`Task ${task.id}: Waiting for an available declared Pass reviewer`);
      blockers.push(
        ...taskGateBlockers(store, sessionId, task, { tasks: tasksById, approvals }).map(
          (reason) => `Task ${task.id}: ${reason}`,
        ),
      );
      if (task.assigneeKey) {
        const binding = bindingsByMember.get(task.assigneeKey);
        if (binding?.state !== 'bound')
          blockers.push(
            `Task ${task.id}: Member ${task.assigneeKey} is unavailable (${binding?.state ?? 'not spawned'})`,
          );
        else if (
          assignments.some(
            (item) =>
              item.memberKey === task.assigneeKey &&
              item.taskId !== task.id &&
              item.status !== 'reported',
          )
        )
          blockers.push(`Task ${task.id}: Member ${task.assigneeKey} has an active assignment`);
      }
    }
    if (task.requestId?.endsWith(':execution-handoff') && task.status === 'blocked')
      blockers.push(`Scheduling Task ${task.id}: ${task.blocker ?? 'blocked'}`);
  }
  for (const assignment of assignments) {
    if (assignment.status === 'uncertain')
      blockers.push(`Assignment ${assignment.id} may have been delivered; it was not resent`);
  }
  return {
    session,
    definition,
    members,
    passes: store.listPasses(sessionId),
    tasks,
    steps: store.listSteps(sessionId),
    assignments,
    reports: store.listReports(sessionId),
    reviews: store.listReviews(sessionId),
    approvals,
    documentsDirectory: planning.documentsDirectory,
    blockers,
    planning: planning.list(sessionId),
    decisions: planning.decisions(sessionId),
  };
}

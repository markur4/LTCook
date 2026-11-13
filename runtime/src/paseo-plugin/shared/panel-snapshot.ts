import { z } from 'zod';
import type { PluginAgentSnapshot } from '@getpaseo/plugin';
import type { SessionSnapshot } from '../../api/team.js';

export interface PanelSnapshotSource {
  session: Pick<SessionSnapshot['session'], 'teamId'>;
  members: Array<{
    member: Pick<SessionSnapshot['members'][number]['member'], 'key' | 'name'>;
    binding: Pick<
      NonNullable<SessionSnapshot['members'][number]['binding']>,
      'nativeAgentId'
    > | null;
    nativeStatus: string | null;
  }>;
  passes: Array<Pick<SessionSnapshot['passes'][number], 'id' | 'title' | 'status'>>;
  tasks: Array<Pick<SessionSnapshot['tasks'][number], 'id' | 'passId' | 'title' | 'status'>>;
  steps: Array<
    Pick<SessionSnapshot['steps'][number], 'id' | 'taskId' | 'title' | 'position' | 'status'>
  >;
  assignments: Array<
    Pick<SessionSnapshot['assignments'][number], 'id' | 'taskId' | 'memberKey' | 'status'>
  >;
  blockers: SessionSnapshot['blockers'];
}

const nativeStatuses = [
  'initializing',
  'idle',
  'running',
  'error',
  'closed',
] as const satisfies readonly PluginAgentSnapshot['status'][];
const memberStatuses = [...nativeStatuses, 'unknown', 'not connected'] as const;
const memberStatus = z.enum(memberStatuses);

export const TeamStatusSnapshotSchema = z.object({
  teamId: z.string(),
  members: z.array(
    z.object({
      memberKey: z.string(),
      name: z.string(),
      nativeAgentId: z.string().nullable(),
      status: memberStatus,
    }),
  ),
  passes: z.array(
    z.object({
      passId: z.string(),
      title: z.string(),
      status: z.string(),
    }),
  ),
  tasks: z.array(
    z.object({
      taskId: z.string(),
      title: z.string(),
      status: z.string(),
      passId: z.string().nullable(),
      passTitle: z.string().nullable(),
      steps: z.array(
        z.object({
          stepId: z.string(),
          title: z.string(),
          status: z.string(),
          position: z.number(),
        }),
      ),
    }),
  ),
  assignments: z.array(
    z.object({
      assignmentId: z.string(),
      taskId: z.string(),
      taskTitle: z.string(),
      memberName: z.string(),
      status: z.string(),
    }),
  ),
  issues: z.array(z.string()),
});
export type TeamStatusSnapshot = z.infer<typeof TeamStatusSnapshotSchema>;

function isNativeStatus(status: string | null): status is PluginAgentSnapshot['status'] {
  return status !== null && nativeStatuses.some((candidate) => candidate === status);
}

export function panelSnapshot(snapshot: PanelSnapshotSource): TeamStatusSnapshot {
  const blockedTasks = snapshot.tasks.filter((task) => task.status === 'blocked').length;
  const failedTasks = snapshot.tasks.filter((task) => task.status === 'failed').length;
  const pendingAssignments = snapshot.assignments.filter(
    (assignment) => assignment.status === 'pending',
  ).length;
  const uncertainAssignments = snapshot.assignments.filter(
    (assignment) => assignment.status === 'uncertain',
  ).length;
  const unboundMembers = snapshot.members.filter(({ binding }) => !binding).length;
  const issues: string[] = [];
  if (blockedTasks) issues.push(`Blocked tasks: ${blockedTasks}`);
  if (failedTasks) issues.push(`Failed tasks: ${failedTasks}`);
  if (pendingAssignments) issues.push(`Assignments not sent: ${pendingAssignments}`);
  if (uncertainAssignments)
    issues.push(`Assignments with uncertain delivery: ${uncertainAssignments}`);
  if (unboundMembers) issues.push(`Members without a native agent: ${unboundMembers}`);
  if (snapshot.blockers.length) issues.push(`Coordination blockers: ${snapshot.blockers.length}`);
  const memberNames = new Map(
    snapshot.members.map(({ member }) => [member.key, member.name] as const),
  );
  const passTitles = new Map(snapshot.passes.map((pass) => [pass.id, pass.title] as const));
  const taskTitles = new Map(snapshot.tasks.map((task) => [task.id, task.title] as const));
  const stepsByTask = new Map<string, PanelSnapshotSource['steps']>();
  for (const step of snapshot.steps) {
    const steps = stepsByTask.get(step.taskId);
    if (steps) steps.push(step);
    else stepsByTask.set(step.taskId, [step]);
  }
  return {
    teamId: snapshot.session.teamId,
    members: snapshot.members.map(({ member, binding, nativeStatus }) => ({
      memberKey: member.key,
      name: member.name,
      nativeAgentId: binding?.nativeAgentId ?? null,
      status: isNativeStatus(nativeStatus) ? nativeStatus : binding ? 'unknown' : 'not connected',
    })),
    passes: snapshot.passes.map((pass) => ({
      passId: pass.id,
      title: pass.title,
      status: pass.status,
    })),
    tasks: snapshot.tasks.map((task) => ({
      taskId: task.id,
      title: task.title,
      status: task.status,
      passId: task.passId ?? null,
      passTitle: task.passId ? (passTitles.get(task.passId) ?? null) : null,
      steps: (stepsByTask.get(task.id) ?? [])
        .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
        .map((step) => ({
          stepId: step.id,
          title: step.title,
          status: step.status,
          position: step.position,
        })),
    })),
    assignments: snapshot.assignments.map((assignment) => ({
      assignmentId: assignment.id,
      taskId: assignment.taskId,
      taskTitle: taskTitles.get(assignment.taskId) ?? 'Task title unavailable',
      memberName: memberNames.get(assignment.memberKey) ?? assignment.memberKey,
      status: assignment.status,
    })),
    issues,
  };
}

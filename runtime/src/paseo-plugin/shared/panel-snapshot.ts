import { z } from 'zod';
import type { PluginAgentSnapshot } from '@getpaseo/plugin';

const work = z.object({ id: z.string(), title: z.string(), status: z.string() });
export const PanelSnapshotSourceSchema = z.object({
  session: z.object({ teamId: z.string() }),
  definition: z.object({ name: z.string() }),
  members: z.array(
    z.object({
      member: z.object({
        key: z.string(),
        name: z.string(),
        modelAlias: z.string(),
        thinking: z.string(),
        readOnly: z.boolean(),
        lifetime: z.enum(['persistent', 'temporary']),
      }),
      binding: z.object({ nativeAgentId: z.string().nullable() }).nullable(),
      nativeStatus: z.string().nullable(),
    }),
  ),
  passes: z.array(work.extend({ createdAt: z.string() })),
  tasks: z.array(work.extend({ passId: z.string().optional() })),
  steps: z.array(work.extend({ taskId: z.string(), position: z.number() })),
  assignments: z.array(
    z.object({
      id: z.string(),
      taskId: z.string(),
      memberKey: z.string(),
      status: z.string(),
    }),
  ),
  blockers: z.array(z.string()),
});
export type PanelSnapshotSource = z.infer<typeof PanelSnapshotSourceSchema>;

export const TeamSnapshotRequestSchema = z.object({ sessionId: z.string().min(1) });
export { SessionOpenRequestSchema, SessionOpenResponseSchema } from './team-catalog';
export type { SessionOpenRequest } from './team-catalog';

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
  teamName: z.string(),
  members: z.array(
    z.object({
      memberKey: z.string(),
      name: z.string(),
      modelAlias: z.string(),
      thinking: z.string(),
      readOnly: z.boolean(),
      lifetime: z.enum(['persistent', 'temporary']),
      nativeAgentId: z.string().nullable(),
      status: memberStatus,
    }),
  ),
  passes: z.array(
    z.object({
      passId: z.string(),
      title: z.string(),
      status: z.string(),
      createdAt: z.string(),
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
      memberKey: z.string(),
      status: z.string(),
    }),
  ),
  issues: z.array(z.string()),
});
export type TeamStatusSnapshot = z.infer<typeof TeamStatusSnapshotSchema>;
export const TeamSnapshotResponseSchema = TeamStatusSnapshotSchema.nullable();

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
    teamName: snapshot.definition.name,
    members: snapshot.members.map(({ member, binding, nativeStatus }) => ({
      memberKey: member.key,
      name: member.name,
      modelAlias: member.modelAlias,
      thinking: member.thinking,
      readOnly: member.readOnly,
      lifetime: member.lifetime,
      nativeAgentId: binding?.nativeAgentId ?? null,
      status: isNativeStatus(nativeStatus) ? nativeStatus : binding ? 'unknown' : 'not connected',
    })),
    passes: snapshot.passes.map((pass) => ({
      passId: pass.id,
      title: pass.title,
      status: pass.status,
      createdAt: pass.createdAt,
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
      memberKey: assignment.memberKey,
      status: assignment.status,
    })),
    issues,
  };
}

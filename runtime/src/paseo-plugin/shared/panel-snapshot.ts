import { z } from 'zod';
import type { PluginAgentSnapshot } from '@getpaseo/plugin';

export interface PanelSnapshotSource {
  session: { teamId: string };
  members: Array<{
    member: { key: string };
    binding: { nativeAgentId: string | null } | null;
    nativeStatus: string | null;
  }>;
  tasks: Array<{ id: string; status: string }>;
  assignments: Array<{
    id: string;
    taskId: string;
    memberKey: string;
    status: string;
  }>;
  blockers: string[];
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
  members: z.array(z.object({
    memberKey: z.string(),
    nativeAgentId: z.string().nullable(),
    status: memberStatus,
  })),
  tasks: z.array(z.object({ taskId: z.string(), status: z.string() })),
  assignments: z.array(z.object({
    assignmentId: z.string(),
    taskId: z.string(),
    memberKey: z.string(),
    status: z.string(),
  })),
  issues: z.array(z.string()),
});
export type TeamStatusSnapshot = z.infer<typeof TeamStatusSnapshotSchema>;

function isNativeStatus(status: string | null): status is PluginAgentSnapshot['status'] {
  return status !== null && nativeStatuses.some(candidate => candidate === status);
}

export function panelSnapshot(snapshot: PanelSnapshotSource): TeamStatusSnapshot {
  const blockedTasks = snapshot.tasks.filter(task => task.status === 'blocked').length;
  const failedTasks = snapshot.tasks.filter(task => task.status === 'failed').length;
  const pendingAssignments = snapshot.assignments.filter(assignment => assignment.status === 'pending').length;
  const uncertainAssignments = snapshot.assignments.filter(assignment => assignment.status === 'uncertain').length;
  const unboundMembers = snapshot.members.filter(({ binding }) => !binding).length;
  const issues: string[] = [];
  if (blockedTasks) issues.push(`Blocked tasks: ${blockedTasks}`);
  if (failedTasks) issues.push(`Failed tasks: ${failedTasks}`);
  if (pendingAssignments) issues.push(`Assignments not sent: ${pendingAssignments}`);
  if (uncertainAssignments) issues.push(`Assignments with uncertain delivery: ${uncertainAssignments}`);
  if (unboundMembers) issues.push(`Members without a native agent: ${unboundMembers}`);
  if (snapshot.blockers.length) issues.push(`Coordination blockers: ${snapshot.blockers.length}`);
  return {
    teamId: snapshot.session.teamId,
    members: snapshot.members.map(({ member, binding, nativeStatus }) => ({
      memberKey: member.key,
      nativeAgentId: binding?.nativeAgentId ?? null,
      status: isNativeStatus(nativeStatus) ? nativeStatus : binding ? 'unknown' : 'not connected',
    })),
    tasks: snapshot.tasks.map(task => ({ taskId: task.id, status: task.status })),
    assignments: snapshot.assignments.map(assignment => ({
      assignmentId: assignment.id,
      taskId: assignment.taskId,
      memberKey: assignment.memberKey,
      status: assignment.status,
    })),
    issues,
  };
}

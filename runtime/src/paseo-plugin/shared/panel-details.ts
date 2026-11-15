import { z } from 'zod';

export const TeamDetailRequestSchema = z.object({
  sessionId: z.string().min(1),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('task'), taskId: z.string().min(1) }),
    z.object({ kind: z.literal('member'), memberKey: z.string().min(1) }),
    z.object({ kind: z.literal('issues') }),
  ]),
});
export type TeamDetailRequest = z.infer<typeof TeamDetailRequestSchema>;
export type TeamDetailTarget = TeamDetailRequest['target'];
export const PanelDetailSourceSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      description: z.string(),
      acceptance: z.string(),
      phase: z.string().optional(),
      blocker: z.string().optional(),
      report: z.string().optional(),
    }),
  ),
  members: z.array(
    z.object({
      member: z.object({ key: z.string() }),
      binding: z
        .object({ nativeAgentId: z.string().nullable(), blocker: z.string().optional() })
        .nullable(),
    }),
  ),
  assignments: z.array(
    z.object({
      id: z.string(),
      memberKey: z.string(),
      taskId: z.string(),
      status: z.string(),
      handoff: z.string(),
    }),
  ),
  reports: z.array(
    z.object({ id: z.string(), assignmentId: z.string(), taskId: z.string(), summary: z.string() }),
  ),
  blockers: z.array(z.string()),
});
export type PanelDetailSource = z.infer<typeof PanelDetailSourceSchema>;
export const TeamDetailResponseSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('task'),
      taskId: z.string(),
      description: z.string(),
      acceptance: z.string(),
      phase: z.string().nullable(),
      blocker: z.string().nullable(),
      report: z.string().nullable(),
    }),
    z.object({
      kind: z.literal('member'),
      memberKey: z.string(),
      latestHandoff: z
        .object({
          assignmentId: z.string(),
          taskId: z.string(),
          taskTitle: z.string(),
          status: z.string(),
          handoff: z.string(),
        })
        .nullable(),
      latestReport: z
        .object({ reportId: z.string(), taskId: z.string(), summary: z.string() })
        .nullable(),
      bindingBlocker: z.string().nullable(),
    }),
    z.object({
      kind: z.literal('issues'),
      blockers: z.array(z.string()),
      taskIssues: z.array(
        z.object({
          taskId: z.string(),
          taskTitle: z.string(),
          status: z.enum(['blocked', 'failed']),
          blocker: z.string().nullable(),
        }),
      ),
    }),
  ])
  .nullable();
export type TeamDetailResponse = z.infer<typeof TeamDetailResponseSchema>;

export function panelDetail(
  source: PanelDetailSource,
  target: TeamDetailTarget,
): TeamDetailResponse {
  if (target.kind === 'task') {
    const task = source.tasks.find((item) => item.id === target.taskId);
    return task
      ? {
          kind: 'task',
          taskId: task.id,
          description: task.description,
          acceptance: task.acceptance,
          phase: task.phase ?? null,
          blocker: task.blocker ?? null,
          report: task.report ?? null,
        }
      : null;
  }
  if (target.kind === 'issues')
    return {
      kind: 'issues',
      blockers: source.blockers,
      taskIssues: source.tasks.flatMap((task) =>
        task.status === 'blocked' || task.status === 'failed'
          ? [
              {
                taskId: task.id,
                taskTitle: task.title,
                status: task.status,
                blocker: task.blocker ?? null,
              },
            ]
          : [],
      ),
    };
  const member = source.members.find((item) => item.member.key === target.memberKey);
  if (!member) return null;
  const assignments = source.assignments.filter((item) => item.memberKey === target.memberKey);
  const owned = new Set(assignments.map((item) => item.id));
  const latest = assignments.at(-1);
  const report = source.reports.filter((item) => owned.has(item.assignmentId)).at(-1);
  return {
    kind: 'member',
    memberKey: target.memberKey,
    latestHandoff: latest
      ? {
          assignmentId: latest.id,
          taskId: latest.taskId,
          taskTitle:
            source.tasks.find((task) => task.id === latest.taskId)?.title ??
            'Task title unavailable',
          status: latest.status,
          handoff: latest.handoff,
        }
      : null,
    latestReport: report
      ? { reportId: report.id, taskId: report.taskId, summary: report.summary }
      : null,
    bindingBlocker: member.binding?.blocker ?? null,
  };
}

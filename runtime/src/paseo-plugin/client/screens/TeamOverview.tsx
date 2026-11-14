import { View } from 'react-native';
import { useAgent } from '@getpaseo/plugin/client';
import type { TeamStatusSnapshot } from '../../shared/panel-snapshot';
import type { TeamDetailResponse } from '../../shared/panel-details';
import { currentAssignments, progress } from '../../shared/view-model';
import { Action, Card, Label, type Theme } from '../components/PanelChrome';
import { StatusBadge } from '../components/StatusBadge';
function MemberCard({
  theme,
  member,
  assignments,
  onSelect,
}: {
  theme: Theme;
  member: TeamStatusSnapshot['members'][number];
  assignments: TeamStatusSnapshot['assignments'];
  onSelect: () => void;
}) {
  const live = useAgent(member.nativeAgentId ?? '', (agent) => agent.status);
  return (
    <Card theme={theme}>
      <Action theme={theme} title={member.name} onPress={onSelect} />
      <Label theme={theme} muted>
        {member.memberKey}
      </Label>
      <StatusBadge theme={theme} status={live ?? member.status} />
      {assignments.length ? (
        assignments.map((item) => (
          <Label key={item.assignmentId} theme={theme}>
            {item.taskTitle} · {item.status}
          </Label>
        ))
      ) : (
        <Label theme={theme} muted>
          No current assignment
        </Label>
      )}
    </Card>
  );
}
export function TeamOverview({
  theme,
  snapshot,
  compact,
  onMember,
  onIssues,
  issuesOpen,
  detail,
}: {
  theme: Theme;
  snapshot: TeamStatusSnapshot;
  compact: boolean;
  onMember: (key: string) => void;
  onIssues: () => void;
  issuesOpen: boolean;
  detail: TeamDetailResponse | undefined;
}) {
  const tasks = progress(snapshot.tasks);
  const passes = snapshot.passes
    .filter((pass) => pass.status === 'running')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.passId.localeCompare(b.passId));
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: compact ? 'column' : 'row', gap: 16 }}>
        <View style={{ flex: compact ? undefined : 2, gap: 12 }}>
          <Label theme={theme} heading>
            Active Passes
          </Label>
          {passes.length ? (
            passes.map((pass) => (
              <Card theme={theme} key={pass.passId}>
                <Label theme={theme}>{pass.title}</Label>
                <StatusBadge theme={theme} status={pass.status} />
              </Card>
            ))
          ) : (
            <Label theme={theme} muted>
              No active Pass
            </Label>
          )}
          <Card theme={theme}>
            <Label theme={theme}>
              {tasks.total
                ? `${tasks.completed} of ${tasks.total} tasks completed`
                : 'No tasks recorded'}
            </Label>
          </Card>
        </View>
        <View style={{ flex: compact ? undefined : 1, gap: 12 }}>
          <Label theme={theme} heading>
            Issues
          </Label>
          {snapshot.issues.length ? (
            snapshot.issues.map((issue) => (
              <Label key={issue} theme={theme}>
                {issue}
              </Label>
            ))
          ) : (
            <Label theme={theme} muted>
              No coordination issues
            </Label>
          )}
          <Action
            theme={theme}
            title={issuesOpen ? 'Hide issue details' : 'Show issue details'}
            onPress={onIssues}
          />
          {issuesOpen && detail?.kind === 'issues' && (
            <Card theme={theme}>
              {detail.blockers.map((blocker, index) => (
                <Label key={index} theme={theme}>
                  {blocker || 'Empty coordination blocker'}
                </Label>
              ))}
              {detail.taskIssues.map((task) => (
                <Label key={task.taskId} theme={theme}>
                  {task.taskTitle}: {task.blocker ?? 'Blocker unavailable'}
                </Label>
              ))}
              {!detail.blockers.length && !detail.taskIssues.length && (
                <Label theme={theme} muted>
                  No blocker details recorded
                </Label>
              )}
            </Card>
          )}
        </View>
      </View>
      <Label theme={theme} heading>
        Team members
      </Label>
      {snapshot.members.length ? (
        snapshot.members.map((member) => (
          <MemberCard
            key={member.memberKey}
            theme={theme}
            member={member}
            assignments={currentAssignments(snapshot, member.memberKey)}
            onSelect={() => onMember(member.memberKey)}
          />
        ))
      ) : (
        <Label theme={theme} muted>
          No team members configured
        </Label>
      )}
    </View>
  );
}

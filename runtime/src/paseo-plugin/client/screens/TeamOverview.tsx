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
  onOpenAgent,
}: {
  theme: Theme;
  member: TeamStatusSnapshot['members'][number];
  assignments: TeamStatusSnapshot['assignments'];
  onSelect: () => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const live = useAgent(member.nativeAgentId ?? '', (agent) => agent.status);
  const nativeAgentId = member.nativeAgentId;
  return (
    <Card theme={theme}>
      <Action theme={theme} title={member.name} onPress={onSelect} />
      {nativeAgentId && onOpenAgent && (
        <Action
          theme={theme}
          title="Open conversation"
          onPress={() => onOpenAgent(nativeAgentId)}
        />
      )}
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
  leaderKey,
  onMember,
  onOpenAgent,
  onIssues,
  issuesOpen,
  detail,
}: {
  theme: Theme;
  snapshot: TeamStatusSnapshot;
  compact: boolean;
  leaderKey: string;
  onMember: (key: string) => void;
  onOpenAgent?: (agentId: string) => void;
  onIssues: () => void;
  issuesOpen: boolean;
  detail: TeamDetailResponse | undefined;
}) {
  const roles = snapshot.members.filter((member) => member.memberKey !== leaderKey);
  const persistentMembers = roles.filter((member) => member.lifetime === 'persistent');
  const temporaryMembers = roles.filter(
    (member) => member.lifetime === 'temporary' && member.nativeAgentId !== null,
  );
  const availableTemporaryRoles = roles.filter(
    (member) => member.lifetime === 'temporary' && member.nativeAgentId === null,
  );
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
      <RoleGroup
        title="Persistent members"
        empty="No persistent members are configured"
        theme={theme}
        members={persistentMembers}
        snapshot={snapshot}
        onMember={onMember}
        onOpenAgent={onOpenAgent}
      />
      <RoleGroup
        title="Temporary members"
        empty="No temporary members are connected"
        theme={theme}
        members={temporaryMembers}
        snapshot={snapshot}
        onMember={onMember}
        onOpenAgent={onOpenAgent}
      />
      <RoleGroup
        title="Available temporary roles"
        empty="No temporary roles are available"
        theme={theme}
        members={availableTemporaryRoles}
        snapshot={snapshot}
        onMember={onMember}
        onOpenAgent={onOpenAgent}
      />
    </View>
  );
}

function RoleGroup({
  title,
  empty,
  theme,
  members,
  snapshot,
  onMember,
  onOpenAgent,
}: {
  title: string;
  empty: string;
  theme: Theme;
  members: TeamStatusSnapshot['members'];
  snapshot: TeamStatusSnapshot;
  onMember: (key: string) => void;
  onOpenAgent?: (agentId: string) => void;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Label theme={theme} heading>
        {title}
      </Label>
      {members.length ? (
        members.map((member) => (
          <MemberCard
            key={member.memberKey}
            theme={theme}
            member={member}
            assignments={currentAssignments(snapshot, member.memberKey)}
            onSelect={() => onMember(member.memberKey)}
            onOpenAgent={onOpenAgent}
          />
        ))
      ) : (
        <Label theme={theme} muted>
          {empty}
        </Label>
      )}
    </View>
  );
}

import { View } from 'react-native';
import { useAgent, type PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import type { TeamStatusSnapshot } from '../../shared/panel-snapshot';
import type { TeamDetailResponse } from '../../shared/panel-details';
import { currentAssignments } from '../../shared/view-model';
import { Action, Card, Label, type Theme } from '../components/PanelChrome';
import { StatusBadge } from '../components/StatusBadge';
export function AgentFocus({
  theme,
  snapshot,
  memberKey,
  onMember,
  detail,
  navigation,
}: {
  theme: Theme;
  snapshot: TeamStatusSnapshot;
  memberKey: string | null;
  onMember: (key: string) => void;
  detail: TeamDetailResponse | undefined;
  navigation: PluginWorkspacePanelProps['navigation'];
}) {
  const member = snapshot.members.find((item) => item.memberKey === memberKey);
  const live = useAgent(member?.nativeAgentId ?? '', (agent) => ({
    status: agent.status,
    model: agent.model,
    lastActivityAt: agent.lastActivityAt,
  }));
  const activity = live?.lastActivityAt ? new Date(live.lastActivityAt) : undefined;
  return (
    <View style={{ gap: 16 }}>
      <Label theme={theme} heading>
        Agent Focus
      </Label>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {snapshot.members.map((item) => (
          <Action
            key={item.memberKey}
            theme={theme}
            title={item.name}
            selected={memberKey === item.memberKey}
            onPress={() => onMember(item.memberKey)}
          />
        ))}
      </View>
      {member ? (
        <Card theme={theme}>
          <Label theme={theme} heading>
            {member.name}
          </Label>
          <Label theme={theme}>
            Role: {member.memberKey} · {member.lifetime}
          </Label>
          <Label theme={theme}>
            {member.readOnly ? 'Read only' : 'Read/write'} · Thinking:{' '}
            {member.thinking || 'Not specified'}
          </Label>
          <StatusBadge theme={theme} status={live?.status ?? member.status} />
          <Label theme={theme}>
            {live?.model ? `Model: ${live.model}` : `Configured model alias: ${member.modelAlias}`}
          </Label>
          <Label theme={theme}>
            Latest activity:{' '}
            {activity && Number.isFinite(activity.getTime())
              ? activity.toLocaleString()
              : 'Activity unavailable'}
          </Label>
          <Label theme={theme} heading>
            Current assignments
          </Label>
          {currentAssignments(snapshot, member.memberKey).map((item) => (
            <Label theme={theme} key={item.assignmentId}>
              {item.taskTitle} · {item.status}
            </Label>
          ))}
          {!currentAssignments(snapshot, member.memberKey).length && (
            <Label theme={theme} muted>
              No current assignment
            </Label>
          )}
          {detail?.kind === 'member' && detail.memberKey === member.memberKey && (
            <>
              <Label theme={theme}>
                Latest handoff:{' '}
                {detail.latestHandoff
                  ? `${detail.latestHandoff.taskTitle}: ${detail.latestHandoff.handoff || 'Empty handoff'}`
                  : 'No handoff recorded'}
              </Label>
              <Label theme={theme}>
                Latest report: {detail.latestReport?.summary ?? 'No report recorded'}
              </Label>
              {detail.bindingBlocker !== null && (
                <Label theme={theme}>Connection blocker: {detail.bindingBlocker}</Label>
              )}
            </>
          )}
          {member.nativeAgentId && navigation ? (
            <Action
              theme={theme}
              title="Open conversation"
              onPress={() => navigation.openAgent({ agentId: member.nativeAgentId! })}
            />
          ) : (
            <Label theme={theme} muted>
              {navigation
                ? 'Native agent is not connected'
                : 'Conversation navigation is unavailable on this host'}
            </Label>
          )}
        </Card>
      ) : (
        <Label theme={theme} muted>
          {snapshot.members.length ? 'Select a team member' : 'No team members configured'}
        </Label>
      )}
    </View>
  );
}

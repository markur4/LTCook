import { useAgent, useWorkspace, type PluginAgentPanelProps } from '@getpaseo/plugin/client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { TeamDetailTarget } from '../../shared/panel-details';
import { useTeamPanel } from '../use-team-panel';
import { useTeamCatalog } from '../use-team-catalog';
import { Action, Card, Label } from '../components/PanelChrome';
import { StatusBadge } from '../components/StatusBadge';
import { TeamOverview } from './TeamOverview';
import { TaskBoard } from './TaskBoard';
import { AgentFocus } from './AgentFocus';
import { Diagnostics } from './Diagnostics';

export function TeamStatus(props: PluginAgentPanelProps) {
  const agent = useAgent(props.params.agentId, (value) => ({
    provider: value.provider,
    metadata: value.metadata,
    labels: value.labels,
    workspace: value.workspace,
    title: value.title,
    status: value.status,
    lastActivityAt: value.lastActivityAt,
  }));
  const root = useWorkspace(agent?.workspace ?? props.workspaceId, (value) => value.directory);
  const teamSelection = agent?.metadata['ltcook.team'] ?? agent?.labels['ltcook.team'];
  const sessionId =
    agent?.provider === 'ltcook'
      ? props.params.agentId
      : agent?.labels['ltcook.member'] === 'leader'
        ? agent.labels['ltcook.session']
        : undefined;
  const isLeader = Boolean(sessionId) && typeof teamSelection === 'string';
  const catalog = useTeamCatalog(isLeader);
  const team = isLeader
    ? catalog.teams.find(
        (entry) => entry.selection === teamSelection || entry.teamId === teamSelection,
      )
    : undefined;
  const [view, setView] = useState<'overview' | 'tasks' | 'agent' | 'diagnostics'>('overview');
  const [memberKey, setMember] = useState<string | null>(null);
  const [taskId, setTask] = useState<string | null>(null);
  const [issuesOpen, setIssues] = useState(false);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    setView('overview');
    setMember(null);
    setTask(null);
    setIssues(false);
  }, [sessionId]);
  const target = useMemo<TeamDetailTarget | null>(
    () =>
      view === 'agent' && memberKey
        ? { kind: 'member', memberKey }
        : view === 'tasks' && taskId
          ? { kind: 'task', taskId }
          : view === 'overview' && issuesOpen
            ? { kind: 'issues' }
            : null,
    [view, memberKey, taskId, issuesOpen],
  );
  const panel = useTeamPanel(sessionId, target, props.params.agentId);
  const previousLeaderActivity = useRef({
    sessionId,
    status: agent?.status,
    lastActivityAt: agent?.lastActivityAt,
  });
  useEffect(() => {
    const previous = previousLeaderActivity.current;
    if (
      sessionId &&
      previous.sessionId === sessionId &&
      (previous.status !== agent?.status || previous.lastActivityAt !== agent?.lastActivityAt)
    )
      void panel.refresh();
    previousLeaderActivity.current = {
      sessionId,
      status: agent?.status,
      lastActivityAt: agent?.lastActivityAt,
    };
  }, [agent?.lastActivityAt, agent?.status, panel.refresh, sessionId]);
  const snapshot = panel.state?.status === 'ready' ? panel.state.value : null;
  const detail = panel.detail?.status === 'ready' ? panel.detail.value : undefined;
  const theme = props.theme;
  const compact = props.layout.compact || width < 720;
  const onOpenAgent = props.navigation
    ? (agentId: string) => props.navigation?.openAgent({ agentId })
    : undefined;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 16, gap: 16 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <Label theme={theme} heading>
        {snapshot?.teamName ?? team?.name ?? 'Team'}
      </Label>
      {!agent && (
        <Text accessibilityRole="progressbar" style={{ color: theme.colors.foreground }}>
          Loading Leader conversation…
        </Text>
      )}
      {agent && !isLeader && (
        <Label theme={theme} muted>
          Open this panel from an LTCook Leader conversation.
        </Label>
      )}
      {isLeader && (
        <Card theme={theme}>
          <Label theme={theme} heading>
            Leader
          </Label>
          <Label theme={theme}>{agent?.title ?? team?.leader.name ?? 'LTCook Leader'}</Label>
          <StatusBadge theme={theme} status={agent?.status ?? 'unknown'} />
          <Label theme={theme} muted>
            {root ?? 'Workspace location unavailable'} · Live Leader status from Paseo
          </Label>
        </Card>
      )}
      {catalog.status === 'error' && isLeader && (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
          Could not load the Team catalog: {catalog.message}
        </Text>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Action
          theme={theme}
          title="Team Overview"
          selected={view === 'overview'}
          onPress={() => setView('overview')}
        />
        <Action
          theme={theme}
          title="Diagnostics"
          selected={view === 'diagnostics'}
          onPress={() => setView('diagnostics')}
        />
        <Action
          theme={theme}
          title="Task Board"
          selected={view === 'tasks'}
          onPress={() => setView('tasks')}
        />
        <Action
          theme={theme}
          title="Agent Focus"
          selected={view === 'agent'}
          onPress={() => setView('agent')}
        />
        <Action
          theme={theme}
          title="Refresh"
          disabled={!sessionId}
          onPress={() => {
            catalog.refresh();
            void panel.refresh();
          }}
        />
      </View>
      {sessionId && (!panel.state || panel.state.status === 'loading') && (
        <Text accessibilityRole="progressbar" style={{ color: theme.colors.foreground }}>
          Loading team status…
        </Text>
      )}
      {sessionId && panel.state?.status === 'error' && (
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
            {panel.state.message}
          </Text>
          <Action theme={theme} title="Retry" onPress={() => void panel.refresh()} />
        </View>
      )}
      {sessionId && panel.state?.status === 'ready' && !snapshot && view !== 'diagnostics' && (
        <Label theme={theme} muted>
          No coordination snapshot is available for this Leader session.
        </Label>
      )}
      {view === 'diagnostics' && (
        <Diagnostics
          theme={theme}
          workspaceRoot={root ?? undefined}
          sessionId={isLeader ? sessionId : undefined}
        />
      )}
      {snapshot && view !== 'diagnostics' && (
        <>
          {panel.detail?.status === 'loading' && (
            <Label theme={theme} muted>
              Loading selected details…
            </Label>
          )}
          {panel.detail?.status === 'error' && (
            <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
              {panel.detail.message}
            </Text>
          )}
          {panel.detail?.status === 'ready' && !detail && (
            <Label theme={theme} muted>
              Selected item is no longer available
            </Label>
          )}
          {view === 'overview' && (
            <TeamOverview
              theme={theme}
              snapshot={snapshot}
              compact={compact}
              leaderKey={snapshot.leaderKey}
              onOpenAgent={onOpenAgent}
              onMember={(key) => {
                setMember(key);
                setView('agent');
              }}
              issuesOpen={issuesOpen}
              onIssues={() => setIssues((value) => !value)}
              detail={detail}
            />
          )}
          {view === 'tasks' && (
            <TaskBoard
              theme={theme}
              snapshot={snapshot}
              compact={compact}
              selectedTask={taskId}
              onTask={setTask}
              detail={detail}
            />
          )}
          {view === 'agent' && (
            <AgentFocus
              theme={theme}
              snapshot={snapshot}
              memberKey={memberKey}
              onMember={setMember}
              detail={detail}
              navigation={props.navigation}
            />
          )}
        </>
      )}
    </ScrollView>
  );
}

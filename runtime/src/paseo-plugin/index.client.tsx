import { useLayoutEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import {
  useWorkspace,
  type PluginClientContext,
  type PluginWorkspacePanelProps,
} from '@getpaseo/plugin/client';
import type { TeamDetailTarget } from './shared/panel-details';
import { useTeamPanel } from './client/use-team-panel';
import { Action, Label } from './client/components/PanelChrome';
import { TeamOverview } from './client/screens/TeamOverview';
import { TaskBoard } from './client/screens/TaskBoard';
import { AgentFocus } from './client/screens/AgentFocus';

function TeamStatus(props: PluginWorkspacePanelProps) {
  const root = useWorkspace(props.workspaceId, (value) => value.directory);
  const [view, setView] = useState<'overview' | 'tasks' | 'agent'>('overview');
  const [memberKey, setMember] = useState<string | null>(null);
  const [taskId, setTask] = useState<string | null>(null);
  const [issuesOpen, setIssues] = useState(false);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    setView('overview');
    setMember(null);
    setTask(null);
    setIssues(false);
  }, [root]);
  const target: TeamDetailTarget | null =
    view === 'agent' && memberKey
      ? { kind: 'member', memberKey }
      : view === 'tasks' && taskId
        ? { kind: 'task', taskId }
        : view === 'overview' && issuesOpen
          ? { kind: 'issues' }
          : null;
  const panel = useTeamPanel(root ?? undefined, target);
  const snapshot = panel.state?.status === 'ready' ? panel.state.value : null;
  const detail = panel.detail?.status === 'ready' ? panel.detail.value : undefined;
  const theme = props.theme;
  const compact = props.layout.compact || width < 720;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 16, gap: 16 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <Label theme={theme} heading>
        {snapshot?.teamName ?? 'Team status'}
      </Label>
      <Label theme={theme} muted>
        {root ?? 'Workspace location unavailable'}
      </Label>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Action
          theme={theme}
          title="Team Overview"
          selected={view === 'overview'}
          onPress={() => setView('overview')}
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
          disabled={!root || panel.starting}
          onPress={() => void panel.refresh()}
        />
      </View>
      {root && (!panel.state || panel.state.status === 'loading') && (
        <Text accessibilityRole="progressbar" style={{ color: theme.colors.foreground }}>
          Loading team status…
        </Text>
      )}
      {panel.state?.status === 'error' && (
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger }}>
            {panel.state.message}
          </Text>
          <Action theme={theme} title="Retry" onPress={() => void panel.refresh()} />
          <Action
            theme={theme}
            title="Start session"
            disabled={panel.starting}
            onPress={() => void panel.startSession()}
          />
        </View>
      )}
      {panel.state?.status === 'ready' && !snapshot && (
        <View style={{ gap: 8 }}>
          <Label theme={theme}>No LTCook session is open for this directory.</Label>
          <Action
            theme={theme}
            title={panel.starting ? 'Starting session…' : 'Start session'}
            disabled={panel.starting}
            onPress={() => void panel.startSession()}
          />
        </View>
      )}
      {snapshot && (
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

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: 'team-status',
    title: 'Team status',
    icon: 'Users',
    context: 'workspace',
    locations: ['workspace', 'explorer'],
    Component: TeamStatus,
  });
  client.addCommandCenterItem({
    id: 'open-team-status',
    title: 'Open team status',
    icon: 'Users',
    context: 'workspace',
    onSelect({ openPanel }) {
      openPanel('team-status');
    },
  });
  return () => undefined;
}

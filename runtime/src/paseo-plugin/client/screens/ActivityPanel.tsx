import { useEffect, useState, type ReactNode } from 'react';
import { AppState, View } from 'react-native';
import {
  useAgent,
  useHosts,
  useSubscription,
  type PluginWorkspacePanelProps,
  type PluginClientContext,
} from '@getpaseo/plugin/client';
import { ScrollView, useToast } from '@getpaseo/plugin/client/ui';
import {
  activitySubscription,
  type ActivityAnchor,
  type ActivitySnapshot,
  type AgentActivity,
  type SkillLoad,
} from '../../shared/activity';
import { ActivityStatus, ActivityText } from '../components/ActivityCard';
import { ActivityAgentCard } from '../components/ActivityAgentCard';
import { ActivityServices } from '../components/ActivityServices';
import type { Theme } from '../components/PanelChrome';
import { useFocusedAgent } from '../explorer-panels';
import { openSkillDocument } from './SkillDocument';

type ActivityPanelProps = PluginWorkspacePanelProps & {
  client: Pick<PluginClientContext, 'composers' | 'openPanel'>;
};

type ActivityNavigation = NonNullable<PluginWorkspacePanelProps['navigation']> & {
  revealTimelineItem?: (input: {
    serverId: string;
    agentId: string;
    target: ActivityAnchor;
  }) => Promise<void>;
};

type ViewportObserver = new (
  report: (entries: readonly { isIntersecting: boolean; intersectionRatio: number }[]) => void,
) => { observe(element: View): void; disconnect(): void };

const isForeground = () =>
  AppState.currentState !== 'inactive' && AppState.currentState !== 'background';

function Section({
  theme,
  title,
  trailing,
}: {
  theme: Theme;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <View
      accessibilityRole="header"
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingTop: 6,
        gap: 5,
      }}
    >
      <ActivityText theme={theme} size={12} strong>
        {title}
      </ActivityText>
      {trailing}
    </View>
  );
}

function ObservedActivity(
  props: ActivityPanelProps & { selectedAgentId: string; selectedWorkspaceId: string },
) {
  const { selectedAgentId, selectedWorkspaceId, theme, navigation, host, client } = props;
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>();
  const stream = useSubscription(activitySubscription, { agentId: selectedAgentId }, (next) => {
    if (next.selectedAgentId !== selectedAgentId || next.agent.id !== selectedAgentId) return;
    setSnapshot((current) => (!current || next.revision > current.revision ? next : current));
  });
  const unavailable = stream.status === 'closed' || stream.status === 'error';
  const subagents = snapshot?.subagents
    ?.slice()
    .sort(
      (a, b) =>
        Number(b.status === 'running') - Number(a.status === 'running') ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id),
    );
  const runningCount = subagents?.filter((agent) => agent.status === 'running').length ?? 0;
  const openConversation = navigation
    ? (agentId: string) => navigation.openAgent({ agentId, serverId: host.id })
    : undefined;

  const revealTimelineItem = (navigation as ActivityNavigation | undefined)?.revealTimelineItem;
  const showInChat = revealTimelineItem
    ? (agentId: string, target: ActivityAnchor) => {
        void revealTimelineItem({ serverId: host.id, agentId, target }).catch(() =>
          toast.error('This occurrence could not be found in chat.'),
        );
      }
    : undefined;

  function openSkill(agent: AgentActivity, workspaceId: string | undefined, skill: SkillLoad) {
    try {
      if (!workspaceId) throw new Error('Workspace unavailable');
      openSkillDocument(client, host.id, workspaceId, agent.id, skill);
    } catch {
      toast.error('Could not open the skill document.');
    }
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 10, gap: 5 }}
    >
      {!snapshot ? (
        <ActivityText theme={theme} tone={unavailable ? 'warning' : 'muted'}>
          {unavailable ? 'Activity is unavailable.' : 'Loading activity…'}
        </ActivityText>
      ) : (
        <>
          {unavailable && (
            <ActivityStatus theme={theme} label="Activity snapshot is stale" tone="warning" />
          )}
          <Section theme={theme} title="Services" />
          <ActivityServices
            theme={theme}
            rag={snapshot.rag}
            lastHandoff={snapshot.lastHandoff}
            agentWorktree={snapshot.agent.worktree?.path}
          />
          <Section theme={theme} title="Agent" />
          <ActivityAgentCard
            theme={theme}
            agent={snapshot.agent}
            selected
            onShowInChat={showInChat && ((target) => showInChat(snapshot.agent.id, target))}
            onOpenSkill={(skill) => openSkill(snapshot.agent, selectedWorkspaceId, skill)}
          />
          <Section
            theme={theme}
            title={subagents ? `Subagents ${subagents.length}` : 'Subagents'}
            trailing={
              subagents?.length ? (
                <ActivityStatus
                  theme={theme}
                  label={`${runningCount} running`}
                  tone={runningCount ? 'running' : 'muted'}
                />
              ) : undefined
            }
          />
          {subagents?.map((agent) => (
            <ActivityAgentCard
              key={agent.id}
              theme={theme}
              agent={agent}
              onOpenConversation={openConversation}
              onShowInChat={showInChat && ((target) => showInChat(agent.id, target))}
              onOpenSkill={
                agent.canOpenConversation
                  ? (skill) => openSkill(agent, agent.worktree?.id, skill)
                  : undefined
              }
            />
          ))}
          {!subagents?.length && (
            <ActivityText theme={theme} tone="muted">
              {subagents ? 'No direct subagents.' : 'Subagent telemetry unavailable.'}
            </ActivityText>
          )}
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
              marginTop: 6,
              paddingTop: 6,
            }}
          >
            <ActivityText theme={theme} tone="muted" size={10}>
              {snapshot.activityScopeLabel}
            </ActivityText>
          </View>
        </>
      )}
    </ScrollView>
  );
}

function FocusedActivity(props: ActivityPanelProps) {
  const focused = useFocusedAgent(props.client, props.host.id);
  const workspaceId = useAgent(focused ?? '', (agent) => agent.workspaceId);
  if (!focused || workspaceId !== props.workspaceId) {
    return (
      <View style={{ padding: 10 }}>
        <ActivityText theme={props.theme} tone="muted">
          Select an agent to view activity.
        </ActivityText>
      </View>
    );
  }
  return (
    <ObservedActivity
      {...props}
      key={`${props.host.id}:${focused.id}`}
      selectedAgentId={focused.id}
      selectedWorkspaceId={workspaceId}
    />
  );
}

export function ActivityPanel(props: ActivityPanelProps) {
  const [foreground, setForeground] = useState(isForeground);
  const [container, setContainer] = useState<View | null>(null);
  const [inViewport, setInViewport] = useState(false);
  const hostStatus = useHosts().find((host) => host.serverId === props.host.id)?.status;
  const Observer =
    props.layout.platform === 'web'
      ? (globalThis as { IntersectionObserver?: ViewportObserver }).IntersectionObserver
      : undefined;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', () => setForeground(isForeground()));
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!Observer || !container) return;
    // Paseo retains hidden Explorer tabs. Observe this panel's own web view across those changes.
    const observer = new Observer(([entry]) => {
      setInViewport(Boolean(entry?.isIntersecting && entry.intersectionRatio > 0));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [Observer, container]);

  return (
    <View ref={setContainer} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      {foreground &&
        (!Observer || inViewport) &&
        (hostStatus === 'online' ? (
          <FocusedActivity {...props} />
        ) : (
          <View style={{ padding: 10 }}>
            <ActivityText theme={props.theme} tone="muted">
              Connecting to the Activity host…
            </ActivityText>
          </View>
        ))}
    </View>
  );
}

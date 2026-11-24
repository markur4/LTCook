import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState, View } from 'react-native';
import {
  useAgent,
  useAgents,
  useComposers,
  useHosts,
  useSubscription,
  type PluginAgentPanelProps,
  type PluginClientContext,
} from '@getpaseo/plugin/client';
import { ScrollView, useToast } from '@getpaseo/plugin/client/ui';
import {
  activitySubscription,
  type ActivitySnapshot,
  type AgentActivity,
} from '../../shared/activity';
import { ActivityStatus, ActivityText } from '../components/ActivityCard';
import { ActivityAgentCard } from '../components/ActivityAgentCard';
import { ActivityServices } from '../components/ActivityServices';
import type { Theme } from '../components/PanelChrome';

export const ACTIVITY_PANEL_ID = 'activity-status';

type ActivityPanelProps = PluginAgentPanelProps & {
  client: Pick<PluginClientContext, 'composers' | 'openPanel'>;
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

function SubagentCard({
  client,
  agent,
  host,
  workspaceId,
  navigation,
  theme,
}: Pick<ActivityPanelProps, 'client' | 'host' | 'workspaceId' | 'navigation' | 'theme'> & {
  agent: AgentActivity;
}) {
  const childWorkspaceId = useAgent(agent.id, (value) => value.workspaceId);
  const toast = useToast();
  const openConversation = navigation
    ? (agentId: string) => {
        if (childWorkspaceId && childWorkspaceId !== workspaceId) {
          try {
            client.openPanel(ACTIVITY_PANEL_ID, {
              location: 'explorer',
              workspaceId: childWorkspaceId,
              agentId,
            });
          } catch {
            toast.error('Activity could not open in the destination Explorer.');
          }
        }
        navigation.openAgent({ agentId, serverId: host.id });
      }
    : undefined;
  return <ActivityAgentCard theme={theme} agent={agent} onOpenConversation={openConversation} />;
}

function ObservedActivity(props: ActivityPanelProps & { selectedAgentId: string }) {
  const { selectedAgentId, theme } = props;
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
            memory={snapshot.memory}
            agentWorktree={snapshot.agent.worktree?.path}
          />
          <Section theme={theme} title="Agent" />
          <ActivityAgentCard theme={theme} agent={snapshot.agent} selected />
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
            <SubagentCard {...props} key={agent.id} agent={agent} />
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
  const { client, host, params } = props;
  const focused = useComposers({ focused: true })[0];
  const agents = useAgents({ hosts: [host.id] });
  const focusedId = useMemo(
    // Both selectors resolve the same installation-owned composer. Match only this host's refs.
    () => focused && agents.find(({ id }) => client.composers({ agentId: id })[0] === focused)?.id,
    [agents, client, focused],
  );
  const selectedAgentId = focusedId ?? params.agentId;
  return (
    <ObservedActivity
      {...props}
      key={JSON.stringify([host.id, props.workspaceId, selectedAgentId])}
      selectedAgentId={selectedAgentId}
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

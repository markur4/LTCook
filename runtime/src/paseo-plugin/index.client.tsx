import { useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { Action, ScrollView, SidebarRow, useToast } from '@getpaseo/plugin/client/ui';
import {
  useAgent,
  useAgents,
  useComposer,
  type PluginClientContext,
  type PluginComposerItemProps,
  type PluginSidebarItemProps,
} from '@getpaseo/plugin/client';
import { TeamsBrowser } from './client/screens/TeamsBrowser';
import { TeamStatus } from './client/screens/TeamStatus';
import { TurnSkills } from './client/components/TurnSkills';
import { TURN_SKILLS_TIMELINE_KIND, TurnSkillsTimelineSchema } from './shared/activity';
import { ActivityPanel } from './client/screens/ActivityPanel';
import {
  clearPendingRepositoryQueries,
  REPOSITORY_QUERY_PANEL_ID,
  WORKSPACE_QUERY_PANEL_ID,
  RepositoryQuery,
  WorkspaceRepositoryQuery,
} from './client/screens/RepositoryQuery';
import { TrackedItems } from './client/screens/TrackedItems';
import { WorkspaceServices } from './client/components/WorkspaceServices';
import { ActivityText } from './client/components/ActivityCard';
import {
  clearPendingSkillDocuments,
  SKILL_DOCUMENT_PANEL_ID,
  SkillDocument,
} from './client/screens/SkillDocument';
import {
  ACTIVITY_PANEL_ID,
  TASKS_PANEL_ID,
  TEAM_PANEL_ID,
  createActivityDefault,
} from './client/explorer-panels';
import { TeamComposerItem } from './client/components/TeamComposerItem';
import { ModelComposerItem } from './client/components/ModelComposerItem';
import { PastedTextComposerItem } from './client/components/PastedTextComposerItem';
import { pastedTextSource } from './shared/pasted-text';
import { openTracker, TRACKER_PANEL_ID } from './client/tracker-navigation';

const workspaceServicesPanelId = 'workspace-services';

function TrackerComposerItem({
  client,
  host,
}: PluginComposerItemProps & { client: PluginClientContext }) {
  const composer = useComposer();
  const agents = useAgents({ hosts: [host.id] });
  const agent =
    composer.context === 'agent'
      ? agents.find(({ id }) => client.composers({ agentId: id })[0] === composer)
      : undefined;
  const workspaceId = useAgent(agent ?? '', (snapshot) => snapshot.workspaceId);
  const toast = useToast();
  if (!agent || !workspaceId) return null;

  return (
    <Action
      title="Tracker"
      icon="Notebook"
      onPress={() => {
        try {
          openTracker(client, workspaceId, agent.id);
        } catch {
          toast.error('Could not open Tracker for this conversation.');
        }
      }}
    />
  );
}

function loadedWebBuild(): string | undefined {
  const { document } = globalThis as {
    document?: { querySelector(selector: string): { content?: string } | null };
  };
  const build = document?.querySelector('meta[name="ltcook-web-build"]')?.content;
  return build && /^[a-f0-9]{64}$/.test(build) ? build.slice(0, 12) : undefined;
}

function ServicesSidebar({ theme, layout }: PluginSidebarItemProps) {
  const [open, setOpen] = useState(false);
  const { height } = useWindowDimensions();
  return (
    <>
      <SidebarRow
        icon={open ? 'ChevronDown' : 'ChevronRight'}
        onPress={() => setOpen((value) => !value)}
      />
      {open && (
        <ScrollView
          testID="ltcook-sidebar-workspace-services"
          style={layout.compact ? { maxHeight: Math.floor(height * 0.4) } : undefined}
          nestedScrollEnabled
        >
          <WorkspaceServices theme={theme} />
        </ScrollView>
      )}
    </>
  );
}

export default function contribute(client: PluginClientContext) {
  const ActivityDefault = createActivityDefault(client);
  const cleanup = [
    client.addScreen({ id: 'teams-browser', title: 'Teams', Component: TeamsBrowser }),
    client.addSidebarHeaderItem({
      id: 'teams-browser',
      title: 'Teams',
      Component: ({ currentScreen, openScreen }) => (
        <SidebarRow
          icon="Users"
          active={currentScreen?.screenId === 'teams-browser'}
          onPress={() => openScreen({ screenId: 'teams-browser' })}
        />
      ),
    }),
    client.addSidebarHeaderItem({
      id: 'services',
      title: 'Services',
      Component: ServicesSidebar,
    }),
    client.addCommandCenterItem({
      id: 'browse-workspace-teams',
      title: 'Browse Teams',
      icon: 'Users',
      context: 'workspace',
      onSelect({ workspace, openScreen }) {
        openScreen({ screenId: 'teams-browser', params: { workspaceId: workspace.id } });
      },
    }),
    client.addWorkspacePanel({
      id: TEAM_PANEL_ID,
      title: 'Team',
      icon: 'Users',
      locations: ['explorer'],
      Component: (props) => <TeamStatus {...props} client={client} mode="team" />,
    }),
    client.addWorkspacePanel({
      id: TASKS_PANEL_ID,
      title: 'Tasks',
      icon: 'ListChecks',
      locations: ['explorer'],
      Component: (props) => <TeamStatus {...props} client={client} mode="tasks" />,
    }),
    client.addWorkspacePanel({
      id: ACTIVITY_PANEL_ID,
      title: 'Activity',
      icon: 'Activity',
      locations: ['explorer'],
      Component: (props) => <ActivityPanel {...props} client={client} />,
    }),
    client.addWorkspacePanel({
      id: workspaceServicesPanelId,
      title: 'Workspace Services',
      icon: 'Tags',
      locations: ['explorer'],
      Component: ({ theme, layout }) => {
        const build = layout.platform === 'web' ? loadedWebBuild() : undefined;
        return (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 10, gap: 5 }}>
            <WorkspaceServices theme={theme} />
            {build && (
              <ActivityText theme={theme} tone="muted">
                Loaded web build {build}
              </ActivityText>
            )}
          </ScrollView>
        );
      },
    }),
    client.addAgentPanel({
      id: TRACKER_PANEL_ID,
      title: 'Tracker',
      icon: 'Notebook',
      locations: ['workspace'],
      Component: TrackedItems,
    }),
    client.addWorkspacePanel({
      id: WORKSPACE_QUERY_PANEL_ID,
      title: 'Query Repo',
      icon: 'Search',
      locations: ['workspace'],
      Component: (props) => <WorkspaceRepositoryQuery {...props} key={props.workspaceId} />,
    }),
    client.addAgentPanel({
      id: REPOSITORY_QUERY_PANEL_ID,
      title: 'Query Repo',
      icon: 'Search',
      locations: ['workspace'],
      Component: RepositoryQuery,
    }),
    client.addAgentPanel({
      id: SKILL_DOCUMENT_PANEL_ID,
      title: 'Skill',
      icon: 'BookOpen',
      locations: ['workspace'],
      Component: SkillDocument,
    }),
    client.addTimelineRenderer({
      kind: TURN_SKILLS_TIMELINE_KIND,
      version: 1,
      schema: TurnSkillsTimelineSchema,
      Component: (props) => <TurnSkills {...props} client={client} />,
    }),
    client.addCommandCenterItem({
      id: 'open-activity-panel',
      title: 'Open Activity panel',
      icon: 'Activity',
      context: 'workspace',
      onSelect({ openPanel }) {
        openPanel(ACTIVITY_PANEL_ID, { location: 'explorer' });
      },
    }),
    client.addCommandCenterItem({
      id: 'open-workspace-services',
      title: 'Open Workspace Services',
      icon: 'Tags',
      context: 'workspace',
      onSelect({ openPanel }) {
        openPanel(workspaceServicesPanelId, { location: 'explorer' });
      },
    }),
    client.addCommandCenterItem({
      id: 'open-tracker',
      title: 'Open Tracker',
      icon: 'Notebook',
      keywords: ['notebook', 'tracked items', 'decisions'],
      context: 'agent',
      onSelect({ openPanel }) {
        openPanel(TRACKER_PANEL_ID, { location: 'workspace' });
      },
    }),
    client.addComposerItem({
      id: 'activity-default',
      Component: ({ host, layout }) => (layout.compact ? null : <ActivityDefault host={host} />),
    }),
    client.addComposerItem({ id: 'team-selector', Component: TeamComposerItem }),
    client.addComposerItem({ id: 'model-selector', Component: ModelComposerItem }),
    client.addComposerItem({
      id: 'tracker',
      Component: (props) => <TrackerComposerItem {...props} client={client} />,
    }),
    client.addAttachmentSource(pastedTextSource),
    client.addComposerItem({ id: 'paste-text', Component: PastedTextComposerItem }),
    client.addCommandCenterItem({
      id: 'open-team-panel',
      title: 'Open Team panel',
      icon: 'Users',
      context: 'workspace',
      onSelect({ openPanel }) {
        openPanel(TEAM_PANEL_ID, { location: 'explorer' });
      },
    }),
    client.addCommandCenterItem({
      id: 'open-tasks-panel',
      title: 'Open Tasks panel',
      icon: 'ListChecks',
      context: 'workspace',
      onSelect({ openPanel }) {
        openPanel(TASKS_PANEL_ID, { location: 'explorer' });
      },
    }),
  ];
  return () => {
    clearPendingSkillDocuments();
    clearPendingRepositoryQueries();
    cleanup.forEach((dispose) => dispose());
  };
}

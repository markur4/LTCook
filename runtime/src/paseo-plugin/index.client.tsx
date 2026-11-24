import { SidebarRow } from '@getpaseo/plugin/client/ui';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { TeamsBrowser } from './client/screens/TeamsBrowser';
import { TeamStatus } from './client/screens/TeamStatus';
import { ActivityPanel } from './client/screens/ActivityPanel';
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
    client.addCommandCenterItem({
      id: 'open-activity-panel',
      title: 'Open Activity panel',
      icon: 'Activity',
      context: 'workspace',
      onSelect({ openPanel }) {
        openPanel(ACTIVITY_PANEL_ID, { location: 'explorer' });
      },
    }),
    client.addComposerItem({
      id: 'activity-default',
      Component: ({ host, layout }) => (layout.compact ? null : <ActivityDefault host={host} />),
    }),
    client.addComposerItem({ id: 'team-selector', Component: TeamComposerItem }),
    client.addComposerItem({ id: 'model-selector', Component: ModelComposerItem }),
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
  return () => cleanup.forEach((dispose) => dispose());
}

import { SidebarRow } from '@getpaseo/plugin/client/ui';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { TeamsBrowser } from './client/screens/TeamsBrowser';
import { TeamStatus } from './client/screens/TeamStatus';
import { ACTIVITY_PANEL_ID, ActivityPanel } from './client/screens/ActivityPanel';
import { TeamComposerItem } from './client/components/TeamComposerItem';
import { ModelComposerItem } from './client/components/ModelComposerItem';
import { PastedTextComposerItem } from './client/components/PastedTextComposerItem';
import { pastedTextSource } from './shared/pasted-text';

export default function contribute(client: PluginClientContext) {
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
    client.addAgentPanel({
      id: 'team-status',
      title: 'Team',
      icon: 'Users',
      Component: TeamStatus,
    }),
    client.addAgentPanel({
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
      context: 'agent',
      onSelect({ openPanel }) {
        openPanel(ACTIVITY_PANEL_ID, { location: 'explorer' });
      },
    }),
    client.addComposerItem({ id: 'team-selector', Component: TeamComposerItem }),
    client.addComposerItem({ id: 'model-selector', Component: ModelComposerItem }),
    client.addAttachmentSource(pastedTextSource),
    client.addComposerItem({ id: 'paste-text', Component: PastedTextComposerItem }),
    client.addCommandCenterItem({
      id: 'open-team-panel',
      title: 'Open Team panel',
      icon: 'Users',
      context: 'agent',
      onSelect({ openPanel }) {
        openPanel('team-status');
      },
    }),
  ];
  return () => cleanup.forEach((dispose) => dispose());
}

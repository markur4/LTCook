import { SidebarRow } from '@getpaseo/plugin/client/ui';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { TeamsBrowser } from './client/screens/TeamsBrowser';
import { TeamStatus } from './client/screens/TeamStatus';
import { TeamComposerItem } from './client/components/TeamComposerItem';

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
    client.addComposerItem({ id: 'team-selector', Component: TeamComposerItem }),
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

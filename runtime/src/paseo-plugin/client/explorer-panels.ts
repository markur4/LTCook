import { useEffect } from 'react';
import {
  useAgent,
  useAgents,
  useComposers,
  usePaseo,
  type PluginClientContext,
  type PluginHostProps,
} from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/ui';

export const ACTIVITY_PANEL_ID = 'activity-status';
export const TEAM_PANEL_ID = 'team-status';
export const TASKS_PANEL_ID = 'tasks';

const activityOpenedKey = 'ltcook.activityOpened';

export function useFocusedAgent(client: Pick<PluginClientContext, 'composers'>, hostId: string) {
  const focused = useComposers({ focused: true })[0];
  const agents = useAgents({ hosts: [hostId] });
  if (!focused) return undefined;
  // -- The hook subscribes to focus. Compare handles returned through the same client API.
  const current = client.composers({ focused: true })[0];
  return current && agents.find(({ id }) => client.composers({ agentId: id })[0] === current);
}

export function createActivityDefault(client: PluginClientContext) {
  const visited = new Set<string>();

  return function ActivityDefault({ host }: Pick<PluginHostProps, 'host'>) {
    const focused = useFocusedAgent(client, host.id);
    const workspaceId = useAgent(focused ?? '', (agent) => agent.workspaceId);
    const paseo = usePaseo();
    const toast = useToast();

    useEffect(() => {
      if (!workspaceId || visited.has(workspaceId)) return;
      const workspace = paseo.workspaces.ref(workspaceId);
      let active = true;

      async function openOnce() {
        const saved = await workspace.refresh();
        if (!active || !saved || visited.has(workspace.id)) return;
        visited.add(workspace.id);
        if (saved.metadata?.[activityOpenedKey] === true) return;
        try {
          client.openPanel(ACTIVITY_PANEL_ID, { workspaceId: workspace.id, location: 'explorer' });
        } catch (error) {
          visited.delete(workspace.id);
          throw error;
        }
        await workspace.setMetadata({ [activityOpenedKey]: true });
      }

      void openOnce().catch(() => {
        if (active)
          toast.error('Could not initialize the Activity tab. Use Explorer + to open it.');
      });
      return () => {
        active = false;
      };
    }, [paseo, toast, workspaceId]);
    return null;
  };
}

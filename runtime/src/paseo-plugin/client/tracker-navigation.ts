import type { PluginClientContext } from '@getpaseo/plugin/client';

export const TRACKER_PANEL_ID = 'tracker';

export function openTracker(
  client: Pick<PluginClientContext, 'openPanel'>,
  workspaceId: string,
  agentId: string,
): void {
  client.openPanel(TRACKER_PANEL_ID, { workspaceId, agentId, location: 'workspace' });
}

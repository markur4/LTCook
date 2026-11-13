import { defineRpc } from '@getpaseo/plugin';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { z } from 'zod';
import {
  panelSnapshot,
  TeamStatusSnapshotSchema,
  type PanelSnapshotSource,
} from './shared/panel-snapshot';

const teamSnapshot = defineRpc({
  name: 'ltcook.team.snapshot',
  input: z.object({ workspaceRoot: z.string() }),
  output: TeamStatusSnapshotSchema,
});
export default function contribute(server: PluginServerContext) {
  server.handle(teamSnapshot, async (input) => {
    const endpoint = process.env.LTCOOK_RUNTIME_API_URL;
    const token = process.env.LTCOOK_RUNTIME_USER_TOKEN;
    if (!endpoint || !token) throw new Error('LTCook runtime API is not available');
    const response = await fetch(`${endpoint}/v1/snapshot`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`LTCook team snapshot unavailable (${response.status})`);
    const snapshot = (await response.json()) as PanelSnapshotSource;
    return panelSnapshot(snapshot);
  });
  return () => undefined;
}

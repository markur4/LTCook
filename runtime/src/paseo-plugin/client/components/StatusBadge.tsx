import { Text } from 'react-native';
import type { Theme } from './PanelChrome';
export function StatusBadge({ theme, status }: { theme: Theme; status: string }) {
  const color = ['failed', 'error'].includes(status)
    ? theme.colors.statusDanger
    : ['blocked', 'uncertain'].includes(status)
      ? theme.colors.statusWarning
      : ['completed', 'idle'].includes(status)
        ? theme.colors.statusSuccess
        : theme.colors.foregroundMuted;
  return <Text style={{ color, fontSize: 12, fontWeight: '600' }}>{status}</Text>;
}

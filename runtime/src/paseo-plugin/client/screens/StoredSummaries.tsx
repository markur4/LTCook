import { useMemo } from 'react';
import { Text, View } from 'react-native';
import type { PluginAgentPanelProps } from '@getpaseo/plugin/client';
import { copyText, ScrollView, useToast } from '@getpaseo/plugin/client/ui';
import { Action, Label } from '../components/PanelChrome';
import { MemoryRecords } from '../components/MemoryRecords';
import { useStoredSummaries } from '../use-stored-summaries';

export const MEMORY_SUMMARIES_PANEL_ID = 'stored-summaries';

function SummaryReader({ params, theme }: PluginAgentPanelProps) {
  const { page, error, loading, loadOlder, loadAll, reload } = useStoredSummaries(
    params.agentId,
    true,
  );
  const toast = useToast();
  const entries = page?.summaries;
  const colors = theme.colors;
  const json = useMemo(() => (entries ? JSON.stringify(entries, null, 2) : null), [entries]);
  const partial = Boolean(page?.next);

  async function copyJson() {
    if (json === null) return;
    try {
      await copyText(json);
      toast.show(partial ? 'Copied loaded summaries' : 'Copied stored summaries');
    } catch {
      toast.error('Could not copy stored summaries.');
    }
  }

  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        padding: 12,
        gap: 8,
        backgroundColor: colors.surface0,
      }}
    >
      {page && (
        <View style={{ gap: 3 }}>
          <Label theme={theme} muted>
            Storage path
          </Label>
          <Text selectable style={{ color: colors.foreground }}>
            {page.storagePath ?? 'Unavailable'}
          </Text>
        </View>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {page?.next && (
          <>
            <Action
              theme={theme}
              title="Load older summaries"
              onPress={loadOlder}
              disabled={loading || !!error}
            />
            <Action
              theme={theme}
              title="Load all summaries"
              onPress={loadAll}
              disabled={loading || !!error}
            />
          </>
        )}
        {json !== null && (
          <Action
            theme={theme}
            title={partial ? 'Copy loaded JSON' : 'Copy JSON'}
            onPress={() => void copyJson()}
          />
        )}
        <Action theme={theme} title="Reload summaries" onPress={reload} disabled={loading} />
      </View>
      {loading && (
        <Label theme={theme} muted>
          Loading stored summaries…
        </Label>
      )}
      {error && (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
          {error}
        </Text>
      )}
      {entries && (
        <>
          <Label theme={theme} muted>
            {entries.length === 0
              ? 'No Session Memory records for this agent.'
              : `${entries.length.toLocaleString()} ${entries.length === 1 ? 'record' : 'records'}${partial ? ' loaded' : ''} · newest first`}
          </Label>
          <ScrollView
            style={{
              flex: 1,
              backgroundColor: colors.surface1,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: 6,
            }}
            contentContainerStyle={{ padding: 12 }}
          >
            <View testID="ltcook-stored-summaries-records">
              <MemoryRecords agentId={params.agentId} records={entries} theme={theme} />
            </View>
          </ScrollView>
        </>
      )}
    </View>
  );
}

export function StoredSummaries(props: PluginAgentPanelProps) {
  return <SummaryReader key={`${props.host.id}:${props.params.agentId}`} {...props} />;
}

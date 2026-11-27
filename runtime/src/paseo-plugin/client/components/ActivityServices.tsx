import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { activityToggleRpc, type ActivitySnapshot } from '../../shared/activity';
import {
  ActivityCard,
  ActivityField,
  ActivityText,
  activityColor,
  statusLabel,
} from './ActivityCard';
import type { Theme } from './PanelChrome';

const ragAvailabilityTones = {
  ready: 'success',
  'not-ready': 'warning',
  unavailable: 'danger',
  unknown: 'muted',
} as const;

const ragActivityTones = {
  idle: 'muted',
  checking: 'running',
  indexing: 'running',
  updating: 'running',
  interrupted: 'warning',
  error: 'danger',
  unknown: 'muted',
} as const;

function ActivitySwitch({
  theme,
  label,
  enabled,
}: {
  theme: Theme;
  label: string;
  enabled: boolean | null;
}) {
  const toggle = useRpc(activityToggleRpc);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setPending(true);
    setError(null);
    try {
      await toggle({ feature: 'rag-index', enabled: next });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this setting.');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <ActivityText theme={theme} strong>
          {label}
        </ActivityText>
        <Switch
          accessibilityLabel={label}
          accessibilityHint="Applies to the LTCook runtime for this Paseo host."
          value={enabled === true}
          disabled={pending || enabled === null}
          onValueChange={(value) => void change(value)}
        />
      </View>
      {error && (
        <ActivityText theme={theme} tone="danger">
          {error}
        </ActivityText>
      )}
    </>
  );
}

export function ActivityServices({
  theme,
  rag,
  lastHandoff,
  agentWorktree,
}: Pick<ActivitySnapshot, 'rag' | 'lastHandoff'> & {
  theme: Theme;
  agentWorktree?: string;
}) {
  const [ragOpen, setRagOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const ragActivity =
    rag.indexingEnabled === false ? 'Index updates off' : statusLabel(rag.activity);
  const ragAvailability = statusLabel(rag.availability);
  return (
    <>
      <ActivityCard
        theme={theme}
        title="RAG Index"
        icon="Database"
        status={ragAvailability}
        statusTone={ragAvailabilityTones[rag.availability]}
        open={ragOpen}
        onToggle={() => setRagOpen(!ragOpen)}
        summaryLabel={`${rag.provider}, ${ragActivity}`}
        summary={
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>
            {rag.provider} ·{' '}
            <Text style={{ color: activityColor(theme, ragActivityTones[rag.activity]) }}>
              {ragActivity}
            </Text>
          </Text>
        }
      >
        <ActivitySwitch theme={theme} label="Index updates" enabled={rag.indexingEnabled} />
        <ActivityField theme={theme} label="Index worktree">
          {rag.worktree?.path ?? 'Unavailable'}
        </ActivityField>
        {rag.worktree && agentWorktree && agentWorktree !== rag.worktree.path && (
          <ActivityField theme={theme} label="Agent worktree">
            {agentWorktree}
          </ActivityField>
        )}
        <ActivityField theme={theme} label="Availability">
          {ragAvailability}
        </ActivityField>
        <ActivityField theme={theme} label="Activity">
          {ragActivity}
        </ActivityField>
        {rag.diagnostic && (
          <ActivityText theme={theme} tone="muted">
            {rag.diagnostic}
          </ActivityText>
        )}
      </ActivityCard>
      {lastHandoff && (
        <ActivityCard
          theme={theme}
          title="Last delegation handoff"
          icon="MessageSquare"
          status="Received"
          statusTone="success"
          open={handoffOpen}
          onToggle={() => setHandoffOpen(!handoffOpen)}
          summaryLabel={lastHandoff.sourceName ?? 'Name unavailable'}
          summary={
            <ActivityText theme={theme}>
              {lastHandoff.sourceName ?? 'Name unavailable'}
            </ActivityText>
          }
        >
          <ActivityField theme={theme} label="Received">
            {new Date(lastHandoff.at).toLocaleString()}
          </ActivityField>
          <ActivityField theme={theme} label="Payload size">
            {`${lastHandoff.bytes.toLocaleString()} bytes`}
          </ActivityField>
          <ActivityField theme={theme} label="Action batches represented">
            {lastHandoff.aab.toLocaleString()}
          </ActivityField>
        </ActivityCard>
      )}
    </>
  );
}

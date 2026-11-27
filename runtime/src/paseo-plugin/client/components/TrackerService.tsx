import { useState } from 'react';
import { View } from 'react-native';
import { useSubscription } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/ui';
import { trackerSubscription, type TrackerSnapshot } from '../../shared/tracker';
import { presentTracker } from '../tracker-presentation';
import { ActivityButton, ActivityCard, ActivityField, ActivityText } from './ActivityCard';
import type { Theme } from './PanelChrome';

export function TrackerService({
  theme,
  agentId,
  scopeLabel,
  onOpen,
}: {
  theme: Theme;
  agentId: string;
  scopeLabel: string;
  onOpen: () => void;
}) {
  const [snapshot, setSnapshot] = useState<TrackerSnapshot>();
  const [open, setOpen] = useState(false);
  const stream = useSubscription(trackerSubscription, { agentId }, setSnapshot);
  const stale = stream.status === 'error' || stream.status === 'closed';
  const view = snapshot && presentTracker(snapshot);
  const summary = view
    ? `${view.trackerCount} Tracker${view.trackerCount === 1 ? '' : 's'} · ${view.itemCount} item${view.itemCount === 1 ? '' : 's'}`
    : 'Conversation notebook';

  return (
    <ActivityCard
      theme={theme}
      title="Tracker"
      icon="Notebook"
      status={stale ? 'Disconnected' : (view?.stateLabel ?? 'Loading')}
      statusTone={stale ? 'warning' : (view?.tone ?? 'muted')}
      summaryLabel={`${scopeLabel}, ${summary}, ${stale ? 'Coverage is stale' : (view?.coverageLabel ?? 'Loading coverage')}`}
      summary={
        <View style={{ gap: 3 }}>
          <ActivityText theme={theme} tone="muted">
            {summary}
          </ActivityText>
          <ActivityText theme={theme} tone={stale ? 'warning' : view?.coverageTone}>
            {stale ? 'Coverage is stale' : (view?.coverageLabel ?? 'Loading coverage…')}
          </ActivityText>
        </View>
      }
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <ActivityField theme={theme} label="Conversation">
        {scopeLabel}
      </ActivityField>
      {snapshot && view && (
        <>
          <ActivityField theme={theme} label="Processing">
            {snapshot.paused
              ? 'Paused across all conversations'
              : `${view.enabledCount} of ${view.trackerCount} Trackers enabled`}
          </ActivityField>
          <ActivityField theme={theme} label="Inference">
            {snapshot.mode === 'hosted' ? 'Hosted · OpenAI through Codex' : 'Local'}
          </ActivityField>
          {view.pendingMessages > 0 && (
            <ActivityField theme={theme} label="Pending">
              {`${view.pendingMessages} message${view.pendingMessages === 1 ? '' : 's'}`}
            </ActivityField>
          )}
          {view.blockedTrackerIds.length > 0 && (
            <ActivityText theme={theme} tone="warning">
              {`${view.blockedTrackerIds.length} Tracker${view.blockedTrackerIds.length === 1 ? '' : 's'} blocked by an unresolved message.`}
              {!snapshot.paused && view.blockedTrackerIds.length < view.enabledCount
                ? ' Other enabled Trackers can continue.'
                : ''}
            </ActivityText>
          )}
          <ActivityText theme={theme} tone="muted">
            {view.startLabel}
          </ActivityText>
        </>
      )}
      <ActivityButton theme={theme} label="Open Tracker" onPress={onOpen}>
        <Icon name="Notebook" size={13} color={theme.colors.accent} />
        <ActivityText theme={theme} tone="running" strong>
          Open Tracker
        </ActivityText>
        <Icon name="ArrowUpRight" size={12} color={theme.colors.accent} />
      </ActivityButton>
    </ActivityCard>
  );
}

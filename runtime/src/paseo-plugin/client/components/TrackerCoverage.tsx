import { View } from 'react-native';
import type { TrackerSnapshot } from '../../shared/tracker';
import {
  isCoverageGap,
  presentTracker,
  trackerEventLabels,
  trackerGapReasons,
} from '../tracker-presentation';
import type { Theme } from './PanelChrome';
import { SourceLinks, type TrackerSource } from './TrackedItem';
import { TrackerButton, TrackerText } from './TrackerControls';

const row = { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 } as const;
type Cursor = Pick<TrackerSource, 'epoch' | 'seq'>;

export function TrackerCoverage({
  theme,
  snapshot,
  trackerId,
  disabled,
  onReveal,
  onRetry,
  onSkip,
}: {
  theme: Theme;
  snapshot: TrackerSnapshot;
  trackerId?: string;
  disabled: boolean;
  onReveal?: (source: TrackerSource) => void;
  onRetry: (trackerId: string, source: Cursor) => void;
  onSkip: (trackerId: string, source: Cursor) => void;
}) {
  const current = presentTracker(snapshot, trackerId);
  const events = snapshot.events
    .map((event, index) => ({
      ...event,
      index,
      trackers: event.trackers.filter(({ trackerId }) =>
        current.trackers.some(({ id }) => id === trackerId),
      ),
    }))
    .filter((event) => event.trackers.length > 0)
    .reverse();

  return (
    <View style={{ gap: 10 }}>
      <View style={{ gap: 4 }}>
        <TrackerText theme={theme} strong>
          {current.coverageLabel}
        </TrackerText>
        <TrackerText theme={theme} muted size={12}>
          {current.startLabel}
        </TrackerText>
        <TrackerText theme={theme} muted size={12}>
          Each message shows its processing result. A blocked Tracker waits at its first gap; other
          Trackers can continue.
        </TrackerText>
      </View>
      {!events.length && (
        <TrackerText theme={theme} muted>
          No messages have been recorded for this selection yet.
        </TrackerText>
      )}
      {events.map((event) => (
        <View
          key={`${event.source.epoch}:${event.source.seq}`}
          style={{
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            paddingTop: 10,
            gap: 7,
          }}
        >
          <SourceLinks theme={theme} sources={[event.source]} onReveal={onReveal} />
          {event.trackers.map(({ trackerId, status, reason, detail }) => {
            const tracker = snapshot.trackers.find(({ id }) => id === trackerId)!;
            const first = current.firstOutstanding.get(trackerId);
            const atFirst =
              first?.source.epoch === event.source.epoch && first.source.seq === event.source.seq;
            const blocked = Boolean(atFirst && first?.blocked);
            const firstIndex = first
              ? snapshot.events.findIndex(
                  ({ source }) =>
                    source.epoch === first.source.epoch && source.seq === first.source.seq,
                )
              : -1;
            const canRetrySkipped = status === 'skipped' && (!first || event.index < firstIndex);
            const actionDisabled = disabled || snapshot.paused || !tracker.enabled;
            const source = { epoch: event.source.epoch, seq: event.source.seq };
            return (
              <View
                key={trackerId}
                style={{
                  gap: 7,
                  paddingLeft: 14,
                  borderLeftWidth: 2,
                  borderLeftColor: isCoverageGap(status)
                    ? theme.colors.statusWarning
                    : theme.colors.border,
                }}
              >
                <View style={row}>
                  <TrackerText theme={theme} size={12} strong>
                    {tracker.name}
                  </TrackerText>
                  <TrackerText theme={theme} muted size={12}>
                    {trackerEventLabels[status]}
                  </TrackerText>
                </View>
                {reason && status !== 'pending' && (
                  <TrackerText theme={theme} muted size={12}>
                    {detail ?? trackerGapReasons[reason]}
                  </TrackerText>
                )}
                {(blocked || canRetrySkipped) && (
                  <View style={row}>
                    <TrackerButton
                      theme={theme}
                      label="Retry message"
                      icon="RotateCcw"
                      disabled={actionDisabled}
                      onPress={() => onRetry(trackerId, source)}
                    />
                    {blocked && (
                      <TrackerButton
                        theme={theme}
                        label="Skip blocked message"
                        quiet
                        disabled={actionDisabled}
                        onPress={() => onSkip(trackerId, source)}
                      />
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

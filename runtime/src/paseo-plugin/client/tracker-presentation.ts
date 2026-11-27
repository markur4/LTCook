import type { TrackerSnapshot } from '../shared/tracker';

export type TrackerEvent = TrackerSnapshot['events'][number];
export type TrackerCoverage = TrackerEvent['trackers'][number];
export type TrackerTone = 'running' | 'success' | 'warning' | 'danger' | 'muted';

/** Export current saved notes from every collection, independent of view filters. */
export function formatTrackerNotes(trackers: TrackerSnapshot['trackers']): string {
  return trackers
    .filter(({ items }) => items.length > 0)
    .map(
      ({ name, items }) =>
        `${name}\n${items.map(({ text }) => `- ${text.replace(/\r?\n/g, '\n  ')}`).join('\n')}`,
    )
    .join('\n\n');
}

export const trackerEventLabels = {
  pending: 'Queued',
  changes: 'Changes applied',
  'no-change': 'Processed · no changes',
  incomplete: 'Incomplete coverage',
  failed: 'Extraction failed',
  paused: 'Not processed · paused or disabled',
  skipped: 'Skipped · coverage incomplete',
} as const;

export const trackerGapReasons = {
  budget:
    'The input exceeds the Tracker budget. Reduce the input or increase the budget before retrying.',
  source: 'The original message or earlier evidence is unavailable.',
  changed: 'The Tracker or an item changed during extraction.',
  configuration: 'Check the configured inference provider and model.',
  authentication: 'Restore sign-in or credentials for the configured inference provider.',
  transient: 'The inference provider could not complete the request.',
  output: 'The extraction did not return usable evidence and changes.',
} as const;

export function isCoverageGap(status: TrackerCoverage['status']): boolean {
  return (
    status === 'incomplete' || status === 'failed' || status === 'skipped' || status === 'paused'
  );
}

export type TrackerOutstanding = {
  source: TrackerEvent['source'];
  status: TrackerCoverage['status'];
  blocked: boolean;
};

/** Describe observed coverage, without treating message times as extraction telemetry. */
export function presentTracker(snapshot: TrackerSnapshot, trackerId?: string) {
  const trackers = snapshot.trackers.filter((tracker) => !trackerId || tracker.id === trackerId);
  const selected = new Set(trackers.map(({ id }) => id));
  const enabled = new Set(trackers.filter(({ enabled }) => enabled).map(({ id }) => id));
  const firstOutstanding = new Map<string, TrackerOutstanding>();
  const pending = new Set<string>();
  const gaps = new Set<string>();
  const paused = new Set<string>();
  const completed = new Set<string>();
  let recordedMessages = 0;

  // The runtime supplies ordered events. Keep that order: sequence values alone
  // do not establish ordering across timeline epochs.
  for (const event of snapshot.events) {
    const entries = event.trackers.filter(({ trackerId: id }) => selected.has(id));
    if (!entries.length) continue;
    recordedMessages++;
    const key = JSON.stringify([event.source.epoch, event.source.seq]);
    if (entries.every(({ status }) => status === 'changes' || status === 'no-change'))
      completed.add(key);
    for (const entry of entries) {
      const { trackerId: id, status } = entry;
      if (status === 'pending') pending.add(key);
      if (isCoverageGap(status)) gaps.add(key);
      if (status === 'paused') paused.add(key);
      const blocked = status === 'incomplete' || status === 'failed';
      if ((blocked || status === 'pending') && !firstOutstanding.has(id))
        firstOutstanding.set(id, { source: event.source, status, blocked });
    }
  }

  const blockedTrackerIds = [...firstOutstanding]
    .filter(([id, entry]) => enabled.has(id) && entry.blocked)
    .map(([id]) => id);
  const runnable = [...firstOutstanding].some(([id, entry]) => enabled.has(id) && !entry.blocked);
  let state: 'paused' | 'disabled' | 'blocked' | 'queued' | 'waiting';
  let stateLabel: string;
  let tone: TrackerTone;
  if (snapshot.paused) {
    state = 'paused';
    stateLabel = 'Paused';
    tone = 'muted';
  } else if (!enabled.size) {
    state = 'disabled';
    stateLabel = trackers.length ? 'Disabled' : 'Not set up';
    tone = 'muted';
  } else if (runnable) {
    state = 'queued';
    stateLabel = 'Queued';
    tone = 'running';
  } else if (blockedTrackerIds.length) {
    state = 'blocked';
    stateLabel = blockedTrackerIds.length === enabled.size ? 'Blocked' : 'Partly blocked';
    tone = 'warning';
  } else {
    state = 'waiting';
    stateLabel = 'Waiting';
    tone = 'muted';
  }

  const coverageLabel = snapshot.historyUnavailable
    ? 'Conversation history unavailable'
    : gaps.size
      ? `${gaps.size} message${gaps.size === 1 ? '' : 's'} with gaps`
      : pending.size
        ? `${pending.size} message${pending.size === 1 ? '' : 's'} pending`
        : !recordedMessages
          ? 'Waiting for messages'
          : 'No recorded gaps';
  const coverageTone: TrackerTone =
    snapshot.historyUnavailable || gaps.size ? 'warning' : pending.size ? 'running' : 'muted';
  const startLabel =
    snapshot.startsAfter === null
      ? 'New messages in this conversation'
      : `Tracking starts after message #${snapshot.startsAfter}`;

  return {
    trackers,
    trackerCount: trackers.length,
    enabledCount: enabled.size,
    itemCount: trackers.reduce((count, tracker) => count + tracker.items.length, 0),
    pendingMessages: pending.size,
    gapMessages: gaps.size,
    pausedMessages: paused.size,
    completedMessages: completed.size,
    recordedMessages,
    blockedTrackerIds,
    firstOutstanding,
    state,
    stateLabel,
    tone,
    coverageLabel,
    coverageTone,
    startLabel,
  };
}

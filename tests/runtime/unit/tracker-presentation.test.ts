import { expect, test } from 'bun:test';
import {
  formatTrackerNotes,
  presentTracker,
} from '../../../runtime/src/paseo-plugin/client/tracker-presentation';
import type { TrackerSnapshot } from '../../../runtime/src/paseo-plugin/shared/tracker';

type Entry = TrackerSnapshot['events'][number]['trackers'][number];

function snapshot(events: TrackerSnapshot['events'] = []): TrackerSnapshot {
  return {
    paused: false,
    historyUnavailable: false,
    startsAfter: 8,
    mode: 'local',
    trackers: [
      { id: 'decisions', name: 'Decisions', instructions: 'Decisions', enabled: true, items: [] },
      { id: 'questions', name: 'Questions', instructions: 'Questions', enabled: true, items: [] },
    ],
    events,
  };
}

function event(seq: number, trackers: Entry[], epoch = 'timeline') {
  return { source: { epoch, seq }, trackers };
}

test('copies saved notes from all collections, including disabled Trackers, as grouped plain text', () => {
  const current = snapshot();
  current.trackers[0]!.items = [
    { id: 'd1', text: 'Keep the approved design.', manual: true, sources: [] },
    { id: 'd2', text: 'First line\r\nSecond line\nThird line', manual: false, sources: [] },
  ];
  current.trackers[1]!.enabled = false;
  current.trackers[1]!.items = [
    { id: 'q1', text: 'What about “Öffnen”?', manual: false, sources: [] },
  ];
  current.trackers.push({
    id: 'empty',
    name: 'Empty Tracker',
    instructions: 'Nothing yet',
    enabled: true,
    items: [],
  });
  expect(formatTrackerNotes(current.trackers)).toBe(
    'Decisions\n- Keep the approved design.\n- First line\n  Second line\n  Third line\n\nQuestions\n- What about “Öffnen”?',
  );
  current.trackers[0]!.items[0]!.text = 'Use the latest saved edit.';
  current.trackers[0]!.items.splice(1, 1);
  expect(formatTrackerNotes(current.trackers)).toBe(
    'Decisions\n- Use the latest saved edit.\n\nQuestions\n- What about “Öffnen”?',
  );
});

test('empty notebooks export no headings or placeholder notes', () => {
  expect(formatTrackerNotes([])).toBe('');
  expect(formatTrackerNotes(snapshot().trackers)).toBe('');
});

test('retains a coverage gap after a later successful extraction', () => {
  const current = snapshot([
    event(10, [{ trackerId: 'decisions', status: 'skipped' }]),
    event(12, [{ trackerId: 'decisions', status: 'changes' }]),
  ]);
  const view = presentTracker(current);
  expect(view.state).toBe('waiting');
  expect(view.coverageLabel).toBe('1 message with gaps');
  expect(view.coverageTone).toBe('warning');
  expect(view.completedMessages).toBe(1);
});

test('messages omitted during a pause remain gaps after processing resumes', () => {
  const current = snapshot([
    event(10, [{ trackerId: 'decisions', status: 'paused' }]),
    event(12, [{ trackerId: 'decisions', status: 'no-change' }]),
  ]);
  expect(presentTracker(current)).toMatchObject({
    state: 'waiting',
    gapMessages: 1,
    pausedMessages: 1,
    coverageTone: 'warning',
  });
  current.paused = true;
  expect(presentTracker(current)).toMatchObject({ state: 'paused', gapMessages: 1 });
});

test('one blocked Tracker does not imply that the other Tracker cannot process its queue', () => {
  const current = snapshot([
    event(10, [
      { trackerId: 'decisions', status: 'incomplete', reason: 'budget' },
      { trackerId: 'questions', status: 'pending' },
    ]),
    event(12, [{ trackerId: 'decisions', status: 'pending' }]),
  ]);
  const view = presentTracker(current);
  expect(view.state).toBe('queued');
  expect(view.blockedTrackerIds).toEqual(['decisions']);
  expect(view.pendingMessages).toBe(2);
  expect(view.gapMessages).toBe(1);
  expect(view.firstOutstanding.get('decisions')?.source.seq).toBe(10);
  expect(presentTracker(current, 'decisions').state).toBe('blocked');
  expect(presentTracker(current, 'questions').coverageTone).toBe('running');
});

test('ignores removed Tracker entries but preserves disabled Tracker coverage', () => {
  const current = snapshot([
    event(10, [{ trackerId: 'removed', status: 'failed' }]),
    event(12, [{ trackerId: 'decisions', status: 'failed' }]),
  ]);
  current.trackers[0]!.enabled = false;
  expect(presentTracker(current)).toMatchObject({
    state: 'waiting',
    gapMessages: 1,
    blockedTrackerIds: [],
  });
  expect(presentTracker(current, 'decisions').state).toBe('disabled');
  expect(presentTracker(current, 'questions').gapMessages).toBe(0);
});

test('counts messages once across Trackers and retains epoch identity and runtime event order', () => {
  const current = snapshot([
    event(
      20,
      [
        { trackerId: 'decisions', status: 'failed' },
        { trackerId: 'questions', status: 'incomplete' },
      ],
      'before-reset',
    ),
    event(1, [{ trackerId: 'decisions', status: 'pending' }], 'after-reset'),
    event(20, [{ trackerId: 'questions', status: 'skipped' }], 'after-reset'),
  ]);
  const view = presentTracker(current);
  expect(view.gapMessages).toBe(2);
  expect(view.firstOutstanding.get('decisions')).toMatchObject({
    source: { epoch: 'before-reset', seq: 20 },
    blocked: true,
  });
  expect(view.state).toBe('blocked');
});

test('does not claim complete history when there are no new messages or history is unavailable', () => {
  const current = snapshot();
  expect(presentTracker(current)).toMatchObject({
    state: 'waiting',
    coverageLabel: 'Waiting for messages',
    startLabel: 'Tracking starts after message #8',
  });
  current.historyUnavailable = true;
  expect(presentTracker(current)).toMatchObject({
    coverageLabel: 'Conversation history unavailable',
    coverageTone: 'warning',
  });
});

test('reports partial blocking and does not label disabled queues as active work', () => {
  const current = snapshot([event(10, [{ trackerId: 'decisions', status: 'failed' }])]);
  expect(presentTracker(current).stateLabel).toBe('Partly blocked');
  current.trackers[0]!.enabled = false;
  current.events = [event(10, [{ trackerId: 'decisions', status: 'pending' }])];
  expect(presentTracker(current)).toMatchObject({ state: 'waiting', pendingMessages: 1 });
  current.trackers = [];
  expect(presentTracker(current)).toMatchObject({ state: 'disabled', stateLabel: 'Not set up' });
});

import { expect, test } from 'bun:test';
import { bindPill, type PillView } from '../../../runtime/src/paseo-plugin/turn-speed/client/pill';
import { createAgentSpeedStore } from '../../../runtime/src/paseo-plugin/turn-speed/client/store';

test('agent speed updates on the two-second cadence and stops after the turn', async () => {
  const updates: PillView[] = [];
  const store = createAgentSpeedStore({
    agentId: 'agent',
    charsPerToken: () => 4,
    learnedCharsPerToken: () => undefined,
    onCalibration: () => {},
    cacheCounting: () => 'auto',
    now: Date.now,
  });
  const pill = bindPill(
    () => ({ update: (view) => updates.push(view), remove: () => {} }),
    store,
    () => ({
      liveWindowSec: 2,
      numerator: 'live',
      showIdlePills: false,
      tokenFormat: 'compact',
      showCacheInPill: false,
      maxPlausibleTokPerSec: 400,
    }),
    Date.now,
  );
  try {
    store.dispatch({ t: 'turn_started', at: Date.now(), turnId: 'turn' });
    const startingUpdates = updates.length;
    store.dispatch({ t: 'text', at: Date.now(), key: 'message', text: 'a'.repeat(200) });
    await Bun.sleep(250);
    expect(updates).toHaveLength(startingUpdates);
    await Bun.sleep(2000);
    expect(updates.length).toBeGreaterThan(startingUpdates);
    expect(updates.at(-1)?.label).toContain('tok/s');
    store.dispatch({ t: 'turn_ended', at: Date.now(), kind: 'completed', turnId: 'turn' });
    expect(updates.at(-1)?.icon).toBe('Activity');
    const finishedUpdates = updates.length;
    await Bun.sleep(2100);
    expect(updates).toHaveLength(finishedUpdates);
  } finally {
    pill.destroy();
  }
}, 7000);

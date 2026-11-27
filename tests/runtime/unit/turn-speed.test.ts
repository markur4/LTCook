import { expect, test } from 'bun:test';
import { bindPill, type PillView } from '../../../runtime/src/paseo-plugin/turn-speed/client/pill';
import { createAgentSpeedStore } from '../../../runtime/src/paseo-plugin/turn-speed/client/store';

test('agent speed updates on the two-second cadence and stops after the turn', async () => {
  const updates: Array<{ view: PillView; paintedAt: number }> = [];
  const store = createAgentSpeedStore({
    agentId: 'agent',
    charsPerToken: () => 4,
    learnedCharsPerToken: () => undefined,
    onCalibration: () => {},
    cacheCounting: () => 'auto',
    now: Date.now,
  });
  const pill = bindPill(
    () => ({
      update: (view) => updates.push({ view, paintedAt: performance.now() }),
      remove: () => {},
    }),
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
    expect(updates).toHaveLength(1);
    const startPaint = updates[0].paintedAt;
    const text = 'a'.repeat(200);
    store.dispatch({ t: 'text', at: Date.now(), key: 'message', text, delta: true });
    await Bun.sleep(300);
    store.dispatch({ t: 'text', at: Date.now(), key: 'message', text, delta: true });
    await Bun.sleep(2000);
    expect(updates).toHaveLength(2);
    expect(updates[1].paintedAt - startPaint).toBeGreaterThanOrEqual(1900);
    expect(updates[1].view.label).toMatch(/^≈\s*\d+(?:\.\d+)? tok\/s$/);
    expect(updates[1].view.title).toContain('≈100 tok');
    store.dispatch({ t: 'turn_ended', at: Date.now(), kind: 'completed', turnId: 'turn' });
    expect(updates.at(-1)?.view.icon).toBe('Activity');
    const finishedUpdates = updates.length;
    await Bun.sleep(2100);
    expect(updates).toHaveLength(finishedUpdates);
  } finally {
    pill.destroy();
  }
}, 7000);

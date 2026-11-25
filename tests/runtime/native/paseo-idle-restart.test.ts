import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createIdleRestartGate } from '../../../paseo-patches/idle-restart/gate.mjs';

test('pending admission and live turns prevent an idle reservation', async () => {
  const gate = createIdleRestartGate();
  const id = randomUUID();
  const admission = Promise.withResolvers<void>();
  const finished = gate.run(() => admission.promise);

  expect(gate.transition('reserve', id, () => 0)).toEqual({ status: 'busy', activeTurns: 1 });
  admission.resolve();
  await finished;
  expect(gate.transition('reserve', id, () => 2)).toEqual({ status: 'busy', activeTurns: 2 });
  expect(gate.transition('reserve', id, () => 0)).toEqual({ status: 'reserved' });
  expect(gate.transition('reserve', id, () => 0)).toEqual({ status: 'reserved' });
  await expect(gate.run(async () => {})).rejects.toThrow('reserved');
});

test('cold stream admission counts until its iterator closes', async () => {
  const gate = createIdleRestartGate();
  const id = randomUUID();
  const source = async function* () {
    yield 'first';
    yield 'second';
  };
  const iterator = gate.stream(source);

  expect(await iterator.next()).toEqual({ value: 'first', done: false });
  expect(gate.transition('reserve', id, () => 0)).toEqual({ status: 'busy', activeTurns: 1 });
  await iterator.return(undefined);
  expect(gate.transition('reserve', id, () => 0)).toEqual({ status: 'reserved' });
  await expect(gate.stream(source).next()).rejects.toThrow('reserved');
});

test('only the reservation owner can release or commit before expiry', () => {
  let now = 0;
  const gate = createIdleRestartGate(() => now);
  const owner = randomUUID();
  const other = randomUUID();

  expect(gate.transition('reserve', owner, () => 0)).toEqual({ status: 'reserved' });
  expect(gate.transition('reserve', other, () => 0)).toEqual({ status: 'unavailable' });
  expect(gate.transition('release', other, () => 0)).toEqual({ status: 'released' });
  expect(() => gate.assertOpen()).toThrow('reserved');

  now = 30_000;
  expect(gate.transition('commit', owner, () => 0)).toEqual({ status: 'unavailable' });
  expect(() => gate.assertOpen()).not.toThrow();
  expect(gate.transition('reserve', other, () => 0)).toEqual({ status: 'reserved' });
  expect(gate.transition('release', other, () => 0)).toEqual({ status: 'released' });
  expect(() => gate.assertOpen()).not.toThrow();
});

test('commit rechecks observed work and keeps admission closed after success', () => {
  let now = 0;
  const gate = createIdleRestartGate(() => now);
  const id = randomUUID();

  expect(gate.transition('reserve', id, () => 0)).toEqual({ status: 'reserved' });
  expect(gate.transition('commit', id, () => 1)).toEqual({ status: 'busy', activeTurns: 1 });
  expect(() => gate.assertOpen()).not.toThrow();
  expect(gate.transition('reserve', id, () => 0)).toEqual({ status: 'reserved' });
  expect(gate.transition('commit', id, () => 0)).toEqual({
    status: 'committed',
    dispatch: true,
  });
  expect(gate.transition('release', id, () => 0)).toEqual({ status: 'released' });
  now = 60_000;
  expect(gate.transition('commit', id, () => 0)).toEqual({ status: 'committed' });
  expect(() => gate.assertOpen()).toThrow('reserved');
});

import { expect, test } from 'bun:test';
import {
  ConversationInference,
  type ConversationProduct,
} from '../../../runtime/src/session-memory/inference.js';

const prompt = { instructions: 'Explain the fixture.', input: 'Fixture source' };

test('Clarify takes priority over queued Hosted Tracker work during a local agent turn', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: ConversationProduct[] = [];
  const inference = new ConversationInference(
    {
      hosted: async (product) => {
        order.push(product);
        if (order.length === 1) {
          started.resolve();
          await release.promise;
        }
        return { text: product, complete: true };
      },
    },
    'hosted',
  );
  const signal = new AbortController().signal;
  try {
    inference.foregroundStarted('local-turn');
    const running = inference.complete('tracker', prompt, signal);
    await started.promise;
    const tracker = inference.complete('tracker', prompt, signal);
    const clarify = inference.complete('clarify', prompt, signal);
    release.resolve();
    await Promise.all([running, tracker, clarify]);
    expect(order).toEqual(['tracker', 'clarify', 'tracker']);
  } finally {
    release.resolve();
    await inference.close();
  }
});

test('Local extraction yields and retries after foreground work ends', async () => {
  const started = Promise.withResolvers<void>();
  const yielded = Promise.withResolvers<void>();
  let calls = 0;
  const inference = new ConversationInference(
    {
      local: async (_product, _prompt, signal) => {
        calls++;
        if (calls > 1) return { text: 'Local result', complete: true };
        started.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        yielded.resolve();
        signal.throwIfAborted();
        throw new Error('Expected the foreground turn to cancel the local request.');
      },
    },
    'local',
  );
  try {
    const pending = inference.complete('tracker', prompt, new AbortController().signal);
    await started.promise;
    inference.foregroundStarted('local-turn');
    await yielded.promise;
    expect(calls).toBe(1);
    inference.foregroundEnded('local-turn');
    expect(await pending).toBe('Local result');
    expect(calls).toBe(2);
  } finally {
    await inference.close();
  }
});

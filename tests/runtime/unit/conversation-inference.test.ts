import { expect, test } from 'bun:test';
import { ConversationInference } from '../../../runtime/src/session-memory/inference.js';

const prompt = { instructions: 'Explain the fixture.', input: 'Fixture source' };

test('Hosted extraction runs in queue order during a local agent turn', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const inference = new ConversationInference(
    {
      hosted: async ({ input }) => {
        order.push(input);
        if (order.length === 1) {
          started.resolve();
          await release.promise;
        }
        return { text: input, complete: true };
      },
    },
    'hosted',
  );
  const signal = new AbortController().signal;
  try {
    inference.foregroundStarted('local-turn');
    const running = inference.complete(prompt, signal);
    await started.promise;
    const second = inference.complete({ ...prompt, input: 'Second source' }, signal);
    const third = inference.complete({ ...prompt, input: 'Third source' }, signal);
    release.resolve();
    await Promise.all([running, second, third]);
    expect(order).toEqual([prompt.input, 'Second source', 'Third source']);
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
      local: async (_prompt, signal) => {
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
    const pending = inference.complete(prompt, new AbortController().signal);
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

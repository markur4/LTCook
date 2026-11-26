import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClarifyService } from '../../../runtime/src/session-memory/clarify.js';
import type { MemorySource } from '../../../runtime/src/session-memory/conversation.js';
import type { ConversationPrompt } from '../../../runtime/src/session-memory/inference.js';
import { openConversationProductStore } from '../../../runtime/src/session-memory/product-store.js';
import type { MemorySourceMessage } from '../../../runtime/src/session-memory/units.js';

const agent = 'agent';
const target = { epoch: 'original', seq: 2, messageId: 'reply' };
const clarification = 'The agent predicts that enabling batching will reduce latency.';

function timeline() {
  const history: { epoch: string; messages: MemorySourceMessage[] } = {
    epoch: target.epoch,
    messages: [
      {
        seq: 1,
        author: 'user',
        turnId: 'turn',
        text: 'Explain batching and latency.',
        attachments: [{ id: 'private', name: 'notes', text: 'UNSENT_ATTACHMENT_CONTENT' }],
      },
      {
        seq: target.seq,
        author: 'agent',
        turnId: 'turn',
        messageId: target.messageId,
        text: 'Batching should reduce latency. We have yet to measure it.',
      },
      { seq: 3, author: 'agent', text: 'Batching made latency worse in a subsequent run.' },
    ],
  };
  const source: MemorySource = {
    async read(_agentId, cursor) {
      const messages = history.messages.filter(({ seq }) => seq < (cursor?.seq ?? Infinity));
      return {
        epoch: history.epoch,
        latest: history.messages.at(-1)?.seq ?? -1,
        through: messages.at(-1)?.seq ?? -1,
        reset: false,
        messages,
      };
    },
  };
  return { history, source };
}

test('Clarify runs on request, shares in-flight work and reopens a saved reply after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ltcook-clarify-'));
  const file = join(directory, 'products.sqlite');
  let database = openConversationProductStore(file);
  try {
    const { source } = timeline();
    const prompts: ConversationPrompt[] = [];
    const inference = {
      async complete(_product: string, prompt: ConversationPrompt) {
        prompts.push(prompt);
        return clarification;
      },
    };
    const service = new ClarifyService(database, source, inference, 1000);
    expect(await service.get(agent, target)).toBeNull();
    expect(prompts).toHaveLength(0);
    expect(
      await Promise.all([service.generate(agent, target), service.generate(agent, target)]),
    ).toEqual([clarification, clarification]);
    expect(prompts).toHaveLength(1);
    expect(JSON.parse(prompts[0]!.input)).toEqual({
      reply: 'Batching should reduce latency. We have yet to measure it.',
      earlier: { author: 'user', text: 'Explain batching and latency.' },
    });
    expect(await service.get(agent, { ...target, messageId: 'other' })).toBeNull();
    database.close();
    database = openConversationProductStore(file);
    const restored = new ClarifyService(database, source, inference, 1000);
    expect(await restored.get(agent, target)).toBe(clarification);
    expect(await restored.generate(agent, target)).toBe(clarification);
    expect(prompts).toHaveLength(1);
  } finally {
    database.close();
    await rm(directory, { recursive: true });
  }
});

test('Clarify discards results when rewind replaces the source during inference', async () => {
  const database = openConversationProductStore(':memory:');
  try {
    const { history, source } = timeline();
    const service = new ClarifyService(
      database,
      source,
      {
        async complete() {
          history.epoch = 'rewound';
          history.messages.splice(1);
          return clarification;
        },
      },
      1000,
    );
    await expect(service.generate(agent, target)).rejects.toThrow('original agent reply changed');
    expect(await service.get(agent, target)).toBeNull();
    await expect(service.generate(agent, target)).rejects.toThrow(
      'original agent reply is unavailable',
    );
  } finally {
    database.close();
  }
});

test('Clarify drops oversized optional context and keeps the whole reply within budget', async () => {
  const database = openConversationProductStore(':memory:');
  try {
    const { history, source } = timeline();
    history.messages[0]!.text = 'Explain batching and latency. '.repeat(500);
    const prompts: ConversationPrompt[] = [];
    const inference = {
      async complete(_product: string, prompt: ConversationPrompt) {
        prompts.push(prompt);
        return clarification;
      },
    };
    const service = new ClarifyService(database, source, inference, 400);
    expect(await service.generate(agent, target)).toBe(clarification);
    expect(JSON.parse(prompts[0]!.input)).toEqual({
      reply: 'Batching should reduce latency. We have yet to measure it.',
    });
    history.messages[1]!.text = 'Batching should reduce latency. '.repeat(500);
    expect(await service.get(agent, target)).toBeNull();
    await expect(service.generate(agent, target)).rejects.toThrow(
      'exceeds the Clarify input budget',
    );
    expect(prompts).toHaveLength(1);
  } finally {
    database.close();
  }
});

test('Clarify does not store inference failures and allows a later request to succeed', async () => {
  const database = openConversationProductStore(':memory:');
  try {
    const { source } = timeline();
    let attempts = 0;
    const service = new ClarifyService(
      database,
      source,
      {
        async complete() {
          if (++attempts === 1) throw new Error('inference unavailable');
          return clarification;
        },
      },
      1000,
    );
    await expect(service.generate(agent, target)).rejects.toThrow('inference unavailable');
    expect(await service.get(agent, target)).toBeNull();
    expect(await service.generate(agent, target)).toBe(clarification);
  } finally {
    database.close();
  }
});

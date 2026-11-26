import { expect, test } from 'bun:test';
import type { MemorySource } from '../../../runtime/src/session-memory/conversation.js';
import type { ConversationPrompt } from '../../../runtime/src/session-memory/inference.js';
import { openConversationProductStore } from '../../../runtime/src/session-memory/product-store.js';
import { TrackerService } from '../../../runtime/src/session-memory/tracker.js';
import type { MemorySourceMessage } from '../../../runtime/src/session-memory/units.js';

const conversation = 'conversation';
const decisions = 'design-decisions';
const messages = {
  user: (seq: number, text: string): MemorySourceMessage => ({
    seq,
    author: 'user',
    text,
    messageId: `user-${seq}`,
  }),
  agent: (seq: number, text: string): MemorySourceMessage => ({
    seq,
    author: 'agent',
    text,
    messageId: `agent-${seq}`,
  }),
};

function timeline(initial: MemorySourceMessage[] = []) {
  const history = { epoch: 'original', messages: initial };
  const source: MemorySource = {
    async read(_id, cursor, direction) {
      const latest = history.messages.at(-1)?.seq ?? -1;
      const entries =
        direction === 'before'
          ? history.messages.filter(({ seq }) => seq < cursor!.seq).slice(-2)
          : direction === 'tail'
            ? history.messages.slice(-2)
            : history.messages.filter(({ seq }) => seq > (cursor?.seq ?? -1)).slice(0, 2);
      return {
        epoch: history.epoch,
        reset: Boolean(cursor && cursor.epoch !== history.epoch),
        latest,
        earliest: history.messages[0]?.seq,
        start: entries[0]?.seq,
        through: entries.at(-1)?.seq ?? cursor?.seq ?? -1,
        messages: entries,
      };
    },
  };
  return { history, source };
}

type Prompt = {
  current: { seq: number };
  trackers: { id: string; items: { id: string }[] }[];
};

function noChanges({ trackers }: Prompt) {
  return JSON.stringify({ trackers: trackers.map(({ id }) => ({ trackerId: id, changes: [] })) });
}

function fixture(
  complete: (prompt: Prompt, raw: string) => string | Promise<string>,
  budget = 5000,
) {
  const { source, history } = timeline();
  const database = openConversationProductStore(':memory:');
  const inputs: string[] = [];
  const inference = {
    async complete(_product: string, prompt: ConversationPrompt) {
      inputs.push(prompt.input);
      return complete(JSON.parse(prompt.input) as Prompt, prompt.input);
    },
  };
  return {
    history,
    source,
    database,
    inputs,
    open: () => new TrackerService(database, source, inference, budget),
  };
}

async function collect(service: TrackerService) {
  service.observe(conversation);
  await service.settled(conversation);
  return service.snapshot(conversation);
}

test('batches enabled Trackers, processes genuine user messages once, and retains source references without attachment text', async () => {
  const { open, history, database, inputs } = fixture(({ current, trackers }) =>
    JSON.stringify({
      trackers: trackers.map(({ id }) => ({
        trackerId: id,
        changes:
          id === decisions && current.seq === 4
            ? [{ type: 'add', text: 'Use SQLite.', sources: [3, 4] }]
            : [],
      })),
    }),
  );
  const service = open();
  try {
    service.configure(conversation, {
      type: 'add',
      name: 'Constraints',
      instructions: 'Track explicit constraints.',
    });
    history.messages.push(
      messages.user(1, 'Could we choose a storage engine?'),
      { seq: 2, author: 'runtime', text: 'Runtime assignment' },
      messages.agent(3, 'I propose SQLite.'),
      {
        ...messages.user(4, 'Yes.'),
        attachments: [{ id: 'pasted-id', name: 'Reference', text: 'PRIVATE ATTACHMENT BODY' }],
      },
      messages.user(5, 'How should we handle telemetry?'),
    );
    const result = await collect(service);
    expect(inputs).toHaveLength(3);
    expect(inputs.every((input) => (JSON.parse(input) as Prompt).trackers.length === 2)).toBe(true);
    expect(inputs.join('')).not.toContain('PRIVATE ATTACHMENT BODY');
    expect(result.trackers[0]!.items).toEqual([
      expect.objectContaining({
        text: 'Use SQLite.',
        sources: [
          expect.objectContaining({ seq: 3, author: 'agent', messageId: 'agent-3' }),
          expect.objectContaining({
            seq: 4,
            author: 'user',
            messageId: 'user-4',
            attachmentIds: ['pasted-id'],
          }),
        ],
      }),
    ]);
    expect(result.events.map(({ source }) => source.seq)).toEqual([1, 4, 5]);
    await collect(service);
    expect(inputs).toHaveLength(3);
  } finally {
    await service.close();
    database.close();
  }
});

test('records incomplete coverage and durably skips paused messages without replay', async () => {
  const { open, history, database, inputs } = fixture(noChanges, 900);
  const first = open();
  try {
    first.configure(conversation, { type: 'add', name: 'Large', instructions: 'A'.repeat(4000) });
    history.messages.push(messages.user(1, 'Keep deployment in Europe.'));
    const initial = await collect(first);
    expect(initial.events[0]!.trackers.map(({ status }) => status)).toEqual([
      'no-change',
      'incomplete',
    ]);
    first.setPaused(true);
    history.messages.push(messages.user(2, 'While paused.'));
    expect((await collect(first)).events[1]!.trackers.map(({ status }) => status)).toEqual([
      'paused',
      'paused',
    ]);
    await first.close();
    const reopened = open();
    try {
      reopened.setPaused(false);
      history.messages.push(messages.user(3, 'After resuming.'));
      await collect(reopened);
      expect(inputs).toHaveLength(2);
      expect(inputs.map((input) => (JSON.parse(input) as Prompt).current.seq)).toEqual([1, 3]);
    } finally {
      await reopened.close();
    }
  } finally {
    await first.close();
    database.close();
  }
});

test('an existing conversation starts at its baseline and resumes new-product work after reopening', async () => {
  const { open, history, database, inputs } = fixture(noChanges);
  const first = open();
  try {
    history.messages.push(messages.user(1, 'An existing user message.'));
    first.observe(conversation, { baseline: true });
    await first.settled();
    expect(inputs).toHaveLength(0);
    await first.close();
    const reopened = open();
    try {
      history.messages.push(messages.user(2, 'A new user message after reopening.'));
      reopened.observe(conversation, { baseline: true });
      await reopened.settled();
      expect(inputs.map((input) => (JSON.parse(input) as Prompt).current.seq)).toEqual([2]);
    } finally {
      await reopened.close();
    }
  } finally {
    await first.close();
    database.close();
  }
});

test('rewind retains the surviving decision and strips invalid evidence from a manual edit', async () => {
  const { open, history, database } = fixture(({ current, trackers }) => {
    const item = trackers[0]!.items[0];
    return JSON.stringify({
      trackers: [
        {
          trackerId: decisions,
          changes: [
            {
              type: item ? 'update' : 'add',
              ...(item ? { itemId: item.id } : {}),
              text: current.seq === 1 ? 'Original' : 'Replacement',
              sources: [current.seq],
            },
          ],
        },
      ],
    });
  });
  const service = open();
  try {
    history.messages.push(messages.user(1, 'I choose the original.'));
    const original = (await collect(service)).trackers[0]!.items[0]!;
    history.messages.push(messages.user(2, 'I choose the replacement.'));
    expect((await collect(service)).trackers[0]!.items[0]!.text).toBe('Replacement');
    service.editItem(conversation, decisions, original.id, 'My manual note');
    history.epoch = 'rewritten';
    history.messages.pop();
    const result = await collect(service);
    expect(result.events.map(({ source }) => source.epoch)).toEqual(['rewritten']);
    expect(result.trackers[0]!.items).toEqual([
      {
        id: original.id,
        text: 'My manual note',
        manual: true,
        evidenceUnavailable: true,
        sources: [],
      },
    ]);
    service.editItem(conversation, decisions, original.id, null);
    expect((await collect(service)).trackers[0]!.items).toEqual([]);
  } finally {
    await service.close();
    database.close();
  }
});

test('a user edit during inference makes the affected extraction incomplete', async () => {
  let finish!: (output: string) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const { open, history, database } = fixture((prompt) => {
    if (prompt.current.seq === 1)
      return JSON.stringify({
        trackers: [
          {
            trackerId: decisions,
            changes: [{ type: 'add', text: 'Initial decision', sources: [1] }],
          },
        ],
      });
    markStarted();
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const service = open();
  try {
    history.messages.push(messages.user(1, 'I choose the original.'));
    const itemId = (await collect(service)).trackers[0]!.items[0]!.id;
    history.messages.push(messages.user(2, 'I choose the replacement.'));
    service.observe(conversation);
    await started;
    service.editItem(conversation, decisions, itemId, 'My manual decision');
    finish(
      JSON.stringify({
        trackers: [
          {
            trackerId: decisions,
            changes: [{ type: 'update', itemId, text: 'Stale result', sources: [2] }],
          },
        ],
      }),
    );
    await service.settled();
    const result = await service.snapshot(conversation);
    expect(result.events[1]!.trackers[0]!.status).toBe('incomplete');
    expect(result.trackers[0]!.items[0]!.text).toBe('My manual decision');
  } finally {
    await service.close();
    database.close();
  }
});

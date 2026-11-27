import { expect, test } from 'bun:test';
import type { MemorySource } from '../../../runtime/src/session-memory/conversation.js';
import {
  ConversationInference,
  type ConversationPrompt,
} from '../../../runtime/src/session-memory/inference.js';
import { openConversationProductStore } from '../../../runtime/src/session-memory/product-store.js';
import { ServiceInferenceError } from '../../../runtime/src/services/inference-recovery.js';
import { TrackerService } from '../../../runtime/src/session-memory/tracker.js';
import { TrackerStore } from '../../../runtime/src/session-memory/tracker-store.js';
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
  const history = { epoch: 'original', messages: initial, unavailableBefore: new Set<number>() };
  const source: MemorySource = {
    async read(_id, cursor, direction) {
      if (direction === 'before' && cursor && history.unavailableBefore.has(cursor.seq))
        throw new Error('Test source is unavailable.');
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
  validate?: (signal: AbortSignal) => Promise<string | undefined>,
) {
  const { source, history } = timeline();
  const database = openConversationProductStore(':memory:');
  const inputs: string[] = [];
  const inference = {
    validate,
    async complete(prompt: ConversationPrompt) {
      inputs.push(prompt.input);
      return complete(JSON.parse(prompt.input) as Prompt, prompt.input);
    },
  };
  return {
    history,
    source,
    database,
    inputs,
    open: (inputTokens = budget) => new TrackerService(database, source, inference, inputTokens),
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
    first.configure(conversation, { type: 'add', name: 'Large', instructions: 'A'.repeat(8000) });
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
    const manualDecision = 'My manual decision. '.repeat(550).trim();
    history.messages.push(messages.user(1, 'I choose the original.'));
    const itemId = (await collect(service)).trackers[0]!.items[0]!.id;
    history.messages.push(messages.user(2, 'I choose the replacement.'));
    service.observe(conversation);
    await started;
    service.editItem(conversation, decisions, itemId, manualDecision);
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
    expect(result.trackers[0]!.items[0]!.text).toBe(manualDecision);
  } finally {
    await service.close();
    database.close();
  }
});

test('a provider failure queues later sources durably for that Tracker while another Tracker continues', async () => {
  let available = false;
  let markValidated!: () => void;
  const validated = new Promise<void>((resolve) => {
    markValidated = resolve;
  });
  let markRecovered!: () => void;
  const recovered = new Promise<void>((resolve) => {
    markRecovered = resolve;
  });
  const { open, history, database, inputs } = fixture(
    ({ current, trackers }) => {
      if (trackers.some(({ id }) => id === decisions)) {
        if (!available)
          throw new ServiceInferenceError('authentication', 'Restore the test sign-in.', 'old');
        if (current.seq === 3) markRecovered();
      }
      return noChanges({ current, trackers });
    },
    5000,
    async () => {
      if (available) return 'new';
      markValidated();
      return 'old';
    },
  );
  const first = open();
  try {
    history.messages.push(messages.user(1, 'Use SQLite.'));
    await collect(first);
    first.configure(conversation, {
      type: 'add',
      name: 'Constraints',
      instructions: 'Track explicit constraints.',
    });
    history.messages.push(
      messages.user(2, 'Also enable foreign keys.'),
      messages.user(3, 'Use one file per workspace.'),
    );
    const initial = await collect(first);
    expect(initial.events.map(({ trackers }) => trackers.map(({ status }) => status))).toEqual([
      ['failed'],
      ['pending', 'no-change'],
      ['pending', 'no-change'],
    ]);
    expect(initial.events[0]!.trackers[0]).toMatchObject({
      reason: 'authentication',
      detail: 'Restore the test sign-in.',
    });
    expect(inputs).toHaveLength(3);
    await first.close();

    const reopened = open();
    try {
      await collect(reopened);
      expect(inputs).toHaveLength(3);
      await validated;
      await reopened.settled();
      expect(inputs).toHaveLength(3);

      available = true;
      await recovered;
      await reopened.settled();
      expect(inputs.slice(3).map((input) => JSON.parse(input) as Prompt)).toMatchObject([
        { current: { seq: 1 }, trackers: [{ id: decisions }] },
        { current: { seq: 2 }, trackers: [{ id: decisions }] },
        { current: { seq: 3 }, trackers: [{ id: decisions }] },
      ]);
      expect(
        (await reopened.snapshot(conversation)).events.map(({ trackers }) =>
          trackers.map(({ status }) => status),
        ),
      ).toEqual([['no-change'], ['no-change', 'no-change'], ['no-change', 'no-change']]);
    } finally {
      await reopened.close();
    }
  } finally {
    await first.close();
    database.close();
  }
}, 10_000);

test('unavailable source retains incomplete coverage until the original evidence becomes readable', async () => {
  const { open, history, database, inputs } = fixture(noChanges);
  const service = open();
  try {
    history.messages.push(
      messages.user(1, 'Use SQLite.'),
      messages.user(3, 'Enforce foreign keys.'),
    );
    history.unavailableBefore.add(2);
    const initial = await collect(service);
    expect(initial.events.map(({ trackers }) => trackers[0]!.status)).toEqual([
      'incomplete',
      'pending',
    ]);
    expect(initial.events[0]!.trackers[0]!.reason).toBe('source');
    expect(inputs).toHaveLength(0);

    history.unavailableBefore.clear();
    const recovered = await collect(service);
    expect(recovered.events.map(({ trackers }) => trackers[0]!.status)).toEqual([
      'no-change',
      'no-change',
    ]);
    expect(inputs.map((input) => (JSON.parse(input) as Prompt).current.seq)).toEqual([1, 3]);
  } finally {
    await service.close();
    database.close();
  }
});

test('messages observed while a Tracker is disabled are never replayed after re-enabling it', async () => {
  const { open, history, database, inputs } = fixture(noChanges);
  const service = open();
  try {
    await collect(service);
    service.configure(conversation, { type: 'enable', id: decisions, enabled: false });
    history.messages.push(messages.user(1, 'While disabled.'));
    await collect(service);
    service.configure(conversation, { type: 'enable', id: decisions, enabled: true });
    history.messages.push(messages.user(2, 'After re-enabling.'));
    await collect(service);
    expect(inputs.map((input) => (JSON.parse(input) as Prompt).current.seq)).toEqual([2]);
  } finally {
    await service.close();
    database.close();
  }
});

test('disabling one Tracker cancels its queued request while another Tracker continues', async () => {
  const { source, history } = timeline();
  const database = openConversationProductStore(':memory:');
  const submitted: string[][] = [];
  const inference = new ConversationInference(
    {
      local: async (prompt) => {
        const request = JSON.parse(prompt.input) as Prompt;
        submitted.push(request.trackers.map(({ id }) => id));
        return { text: noChanges(request), complete: true };
      },
    },
    'local',
  );
  let onQueued!: () => void;
  const queued = new Promise<void>((resolve) => {
    onQueued = resolve;
  });
  const service = new TrackerService(
    database,
    source,
    {
      complete(...args) {
        const result = inference.complete(...args);
        onQueued();
        return result;
      },
    },
    5000,
  );
  const releaseForeground = inference.holdForeground();
  try {
    service.configure(conversation, {
      type: 'add',
      name: 'Constraints',
      instructions: 'Track constraints.',
    });
    const other = (await service.snapshot(conversation)).trackers[1]!.id;
    history.messages.push(messages.user(1, 'Keep tests isolated.'));
    service.observe(conversation);
    await queued;
    expect(submitted).toEqual([]);
    service.configure(conversation, { type: 'enable', id: decisions, enabled: false });
    releaseForeground();
    await service.settled();

    expect(submitted).toEqual([[other]]);
    expect((await service.snapshot(conversation)).events[0]!.trackers).toMatchObject([
      { trackerId: decisions, status: 'paused' },
      { trackerId: other, status: 'no-change' },
    ]);
  } finally {
    releaseForeground();
    await service.close();
    await inference.close();
    database.close();
  }
});

test('a budget gap stays incomplete after unchanged retry or skip, and can recover after the budget changes', async () => {
  const { open, history, database, inputs } = fixture(noChanges, 900);
  const first = open();
  try {
    history.messages.push(
      messages.user(1, 'Keep the deployment in Europe. '.repeat(250)),
      messages.user(2, 'Use separate credentials.'),
      messages.user(3, 'Set the renewal period to 90 days.'),
    );
    const initial = await collect(first);
    expect(initial.events.map(({ trackers }) => trackers[0]!.status)).toEqual([
      'incomplete',
      'pending',
      'pending',
    ]);
    expect(initial.events[0]!.trackers[0]!.reason).toBe('budget');
    const source = { epoch: 'original', seq: 1 };
    first.recover(conversation, { type: 'retry', trackerId: decisions, source });
    await first.settled();
    expect(inputs).toHaveLength(0);
    expect((await first.snapshot(conversation)).events[0]!.trackers[0]!.reason).toBe('budget');

    first.recover(conversation, { type: 'skip', trackerId: decisions, source });
    await first.settled();
    expect(
      (await first.snapshot(conversation)).events.map(({ trackers }) => trackers[0]!.status),
    ).toEqual(['skipped', 'no-change', 'no-change']);
    expect(inputs.map((input) => (JSON.parse(input) as Prompt).current.seq)).toEqual([2, 3]);
    await first.close();

    const reopened = open(8000);
    try {
      expect((await collect(reopened)).events[0]!.trackers[0]!.status).toBe('skipped');
      reopened.recover(conversation, { type: 'retry', trackerId: decisions, source });
      await reopened.settled();
      expect(
        (await reopened.snapshot(conversation)).events.map(({ trackers }) => trackers[0]!.status),
      ).toEqual(['no-change', 'no-change', 'no-change']);
      expect(inputs.map((input) => (JSON.parse(input) as Prompt).current.seq)).toEqual([
        2, 3, 1, 2, 3,
      ]);
    } finally {
      await reopened.close();
    }
  } finally {
    await first.close();
    database.close();
  }
});

test('a committed suffix is recomputed in source order without resurrecting manually removed or edited items', async () => {
  let replay = false;
  const itemText = ['Gap filled', 'Remove this item', 'Edit this item', 'Stale automatic result'];
  const { open, history, database, inputs } = fixture(({ current, trackers }) => {
    if (current.seq === 1 && !replay) return noChanges({ current, trackers });
    const text =
      replay && current.seq >= 2
        ? `Reworded: ${itemText[current.seq - 1]}`
        : itemText[current.seq - 1];
    return JSON.stringify({
      trackers: [
        {
          trackerId: decisions,
          changes: [{ type: 'add', text, sources: [current.seq] }],
        },
      ],
    });
  });
  const first = open();
  try {
    history.messages.push(...itemText.map((text, index) => messages.user(index + 1, text)));
    const initial = await collect(first);
    const [removed, edited] = initial.trackers[0]!.items;
    first.editItem(conversation, decisions, removed!.id, null);
    first.editItem(conversation, decisions, edited!.id, 'My manual note');
    await first.close();

    const store = new TrackerStore(database);
    const oldCoverage = store.load(conversation);
    oldCoverage.events[0]!.trackers[0]!.status = 'failed';
    store.save(conversation, oldCoverage);
    const reopened = open();
    try {
      const paused = await collect(reopened);
      expect(paused.trackers[0]!.items.map(({ text }) => text)).toEqual(['My manual note']);
      expect(paused.events.map(({ trackers }) => trackers[0]!.status)).toEqual([
        'failed',
        'pending',
        'pending',
        'pending',
      ]);
      expect(inputs).toHaveLength(4);
      replay = true;
      reopened.recover(conversation, {
        type: 'retry',
        trackerId: decisions,
        source: { epoch: 'original', seq: 1 },
      });
      await reopened.settled();
      const recovered = await reopened.snapshot(conversation);
      expect(recovered.trackers[0]!.items.map(({ text }) => text)).toEqual([
        'Gap filled',
        'Reworded: Stale automatic result',
        'My manual note',
      ]);
      expect(recovered.trackers[0]!.items.find(({ manual }) => manual)?.id).toBe(edited!.id);
      expect(inputs.slice(4).map((input) => (JSON.parse(input) as Prompt).current.seq)).toEqual([
        1, 2, 3, 4,
      ]);
    } finally {
      await reopened.close();
    }
  } finally {
    await first.close();
    database.close();
  }
});

import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ConversationRecords,
  type MemorySource,
} from '../../../runtime/src/session-memory/conversation.js';
import {
  hostedConversationProvider,
  validHostedConversationRequest,
} from '../../../runtime/src/session-memory/hosted.js';
import { PastedDocuments } from '../../../runtime/src/session-memory/pasted-documents.js';
import type { MemorySourceMessage } from '../../../runtime/src/session-memory/units.js';

function timeline(get: () => { epoch: string; messages: MemorySourceMessage[] }): MemorySource {
  return {
    async read(_id, cursor, direction) {
      const { epoch, messages } = get();
      const latest = messages.at(-1)?.seq ?? -1;
      const page =
        direction === 'tail'
          ? messages.slice(-2)
          : direction === 'before'
            ? messages.filter(({ seq }) => seq < cursor!.seq).slice(-2)
            : messages.filter(({ seq }) => seq > (cursor?.seq ?? -1)).slice(0, 2);
      return {
        epoch,
        latest,
        through: page.at(-1)?.seq ?? cursor?.seq ?? -1,
        start: page[0]?.seq,
        earliest: messages[0]?.seq,
        messages: page.map((item) => ({ ...item })),
        reset: cursor !== undefined && cursor.epoch !== epoch,
      };
    },
  };
}

test('stops fetching older originals when the delegation deadline expires', async () => {
  const messages: MemorySourceMessage[] = [
    ...Array.from({ length: 8 }, (_, index) => ({
      seq: index + 1,
      author: 'user' as const,
      text: `Original evidence ${index}`,
    })),
  ];
  const source = timeline(() => ({ epoch: 'one', messages }));
  const deadline = new AbortController();
  let pages = 0;
  const memory = new ConversationRecords({
    databasePath: ':memory:',
    source: {
      async read(...args) {
        const page = await source.read(...args);
        if (args[2] === 'before') {
          pages++;
          deadline.abort();
        }
        return page;
      },
    },
  });
  try {
    await expect(memory.handoff('leader', 'Locate absent.ts.', deadline.signal)).rejects.toThrow();
    expect(pages).toBe(1);
  } finally {
    await memory.close();
  }
});

test('Hosted accepts an isolated Standard request and rejects continuation and tools', () => {
  const payload = {
    model: 'gpt-6-luna',
    instructions: 'Summarize.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Fixture.' }] }],
    service_tier: 'default',
    reasoning: { effort: 'low' },
    store: false,
  };
  const accepts = (candidate: unknown) =>
    validHostedConversationRequest(candidate, payload.model, payload.instructions, 'Fixture.');
  expect(accepts(payload)).toBe(true);
  expect(accepts({ ...payload, reasoning: { effort: 'none' } })).toBe(false);
  expect(accepts({ ...payload, previous_response_id: 'earlier' })).toBe(false);
  expect(accepts({ ...payload, tools: [{ type: 'function' }] })).toBe(false);
  expect(accepts({ ...payload, instructions: 'Summarize. More instructions.' })).toBe(false);
  expect(accepts({ ...payload, service_tier: 'priority' })).toBe(false);
});

test('Hosted conversation inference rejects the separately billed provider before submitting', async () => {
  const hosted = hostedConversationProvider({
    alias: 'tiny',
    provider: 'openai',
    model: 'gpt-6-luna',
    reasoning: 'low',
    reasoningSource: 'alias',
  });
  await expect(
    hosted(
      'clarify',
      { instructions: 'Clarify.', input: 'Fixture.' },
      new AbortController().signal,
    ),
  ).rejects.toThrow('requires a Codex model');
});

test('persists exact signed pasted bytes and removes an invalidated attachment', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-paste-'));
  const store = new PastedDocuments(directory, 'receipt-secret');
  const original = '  tricky 🧪\r\nreference\n\n';
  try {
    const signed = await store.draft(original);
    const submitted = 'Review this reference.\n\n' + signed.text;
    const projected = await store.project('native-agent', 'one', 7, submitted);
    expect(projected.text).toBe('Review this reference.');
    expect(projected.attachments[0]?.text).toBe(original);
    const files = await readdir(directory, { recursive: true });
    const file = files.find((entry) => entry.endsWith('.txt'));
    expect(file).toBeDefined();
    expect(await readFile(path.join(directory, file!), 'utf8')).toBe(original);
    const tampered = await store.project(
      'native-agent',
      'one',
      8,
      submitted.replace('reference\n\n', 'changed\n\n'),
    );
    expect(tampered.attachments).toEqual([]);
    await store.invalidate('native-agent', 'one', 7);
    expect(
      (await readdir(directory, { recursive: true })).some((entry) => entry.endsWith('.txt')),
    ).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

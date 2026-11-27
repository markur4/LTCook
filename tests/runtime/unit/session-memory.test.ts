import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  ConversationRecords,
  type MemorySource,
} from '../../../runtime/src/session-memory/conversation.js';
import {
  hostedConversationProvider,
  validHostedConversationRequest,
} from '../../../runtime/src/session-memory/hosted.js';
import {
  ConversationInference,
  localConversationProvider,
} from '../../../runtime/src/session-memory/inference.js';
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

test('Hosted validates the subscription route without generating a response', async () => {
  let key: string | undefined;
  let completions = 0;
  const hosted = hostedConversationProvider(
    {
      alias: 'tiny',
      provider: 'openai-codex',
      model: 'gpt-6-luna',
      reasoning: 'low',
      reasoningSource: 'alias',
    },
    {
      async authorize(provider) {
        expect(provider).toBe('openai-codex');
        if (!key) throw new Error('A private denial with a credential in it.');
        return { auth: { apiKey: key }, source: 'Codex sign-in' };
      },
      async createRuntime() {
        return {
          getModel: () => ({
            id: 'gpt-6-luna',
            provider: 'openai-codex',
            api: 'openai-codex-responses',
            baseUrl: 'https://chatgpt.com/backend-api',
            reasoning: true,
          }),
          login: async () => {},
          logout: async () => {},
          checkAuth: async () => ({}),
          getAuth: async () => ({}),
          complete: async () => {
            completions++;
            throw new Error('Validation attempted inference.');
          },
        } as unknown as ModelRuntime;
      },
    },
  );
  const inference = new ConversationInference({ hosted }, 'hosted');
  const signal = new AbortController().signal;
  try {
    await expect(inference.validate(signal)).rejects.toMatchObject({
      kind: 'authentication',
      message: expect.stringContaining('ltcook auth login openai-codex'),
    });
    key = 'credential-a';
    const first = await inference.validate(signal);
    expect(first).toBe(await inference.validate(signal));
    key = 'credential-b';
    expect(await inference.validate(signal)).not.toBe(first);
    expect(completions).toBe(0);
  } finally {
    await inference.close();
  }
});

test('Local conversation validation asks Ollama about the selected model without generating', async () => {
  let available = false;
  const requests: { path: string; model: string }[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    requests.push({
      path: new URL(String(input)).pathname,
      model: JSON.parse(String(init?.body)).model,
    });
    return new Response(null, { status: available ? 200 : 404 });
  });
  const provider = localConversationProvider({
    endpoint: 'http://127.0.0.1:11434',
    model: 'fixture:small',
    keepAlive: -1,
  });
  const inference = new ConversationInference({ local: provider }, 'local');
  const signal = new AbortController().signal;
  try {
    await expect(inference.validate(signal)).rejects.toMatchObject({
      kind: 'configuration',
      message: expect.stringContaining('LTCOOK_CONVERSATION_LOCAL_MODEL'),
    });
    available = true;
    expect(await inference.validate(signal)).toBeDefined();
    expect(requests).toEqual([
      { path: '/api/show', model: 'fixture:small' },
      { path: '/api/show', model: 'fixture:small' },
    ]);
  } finally {
    fetch.mockRestore();
    await inference.close();
  }
});

import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  estimateMemoryTokens,
  mergeMemoryEntries,
  parseMemorySelections,
  preservePromptMessages,
  memoryEntriesSchema,
  renderMemoryHandoff,
  selectMemoryContext,
  type MemoryEntry,
  type MemoryMessage,
} from '../../../runtime/src/evals/session-memory-extractive.js';
import { SessionMemory, type MemorySource } from '../../../runtime/src/session-memory/service.js';
import type { MemorySourceMessage } from '../../../runtime/src/session-memory/units.js';
import { PastedDocuments } from '../../../runtime/src/session-memory/pasted-documents.js';
import { readFile, readdir } from 'node:fs/promises';

const first: MemoryMessage = { seq: 1, author: 'user', text: 'Keep the cobalt cursor.' };
const finding: MemoryMessage = { seq: 2, author: 'agent', text: 'Cobalt test passed.' };
const correction: MemoryMessage = {
  seq: 3,
  author: 'user',
  text: 'Correction for cobalt: advance the cursor.',
};
const issue: MemoryMessage = { seq: 4, author: 'tool', text: 'Cobalt shell exited with code 1.' };
const [original, revision] = preservePromptMessages([first, correction]);

test('the runtime preserves exact user messages and derives the authors of ordered additions', () => {
  const excerpts = [
    { excerpt: 1, ...finding, author: 'agent' as const },
    { excerpt: 2, ...issue, author: 'tool' as const },
  ];
  const payload = {
    additions: [
      { kind: 'issue', excerpt: 2 },
      { kind: 'finding', excerpt: 1 },
    ],
  };
  const additions = parseMemorySelections(excerpts, payload);
  const stored = mergeMemoryEntries([original!, revision!], [...additions, ...additions]);
  expect(memoryEntriesSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual([
    { kind: 'user', ...first },
    { kind: 'finding', ...finding },
    { kind: 'user', ...correction },
    { kind: 'issue', ...issue },
  ]);
  expect(() =>
    parseMemorySelections(excerpts, {
      additions: [{ kind: 'finding', excerpt: 99 }],
    }),
  ).toThrow('invalid excerpt');
  expect(() =>
    parseMemorySelections(excerpts, {
      additions: [{ kind: 'finding', excerpt: 1, text: 'Invented claim' }],
    }),
  ).toThrow('invalid shape');
  const excerptsWithinBudget = Array.from({ length: 20 }, (_, index) => ({
    excerpt: index + 1,
    ...finding,
    text: `Check ${index} passed.`,
    author: 'agent' as const,
  }));
  expect(
    parseMemorySelections(excerptsWithinBudget, {
      additions: excerptsWithinBudget.map(({ excerpt }) => ({ kind: 'progress', excerpt })),
    }),
  ).toHaveLength(20);
});

test('packs short relevant evidence and keeps the newest user correction within the handoff budget', () => {
  const entries = Array.from({ length: 40 }, (_, index): MemoryEntry => ({
    kind: 'progress',
    author: 'agent',
    seq: index + 2,
    text: `Cobalt check ${index} passed.`,
  }));
  const latest = { ...correction, seq: 42, text: correction.text + ' 🧪'.repeat(2000) };
  const context = selectMemoryContext([original!, ...entries], [latest], 'cobalt', false);
  const output = renderMemoryHandoff(context);
  expect(context.entries.length).toBeGreaterThan(6);
  expect(output).toContain(correction.text);
  expect(context.incomplete).toBe(true);
  expect(estimateMemoryTokens(output)).toBeLessThan(1250);
});

test('searches older source text omitted by extraction and returns a full cited message', async () => {
  const source = { ...finding, seq: 1, text: 'Unrelated filler. '.repeat(900) + 'ArchiveSentinel' };
  const newest = { ...correction, seq: 49 };
  const runtime = { ...issue, seq: 2, author: 'runtime' as const, text: 'ArchiveSentinel' };
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: {
      async read(_id, cursor, direction) {
        return direction === 'tail'
          ? {
              epoch: 'fixture',
              earliest: 1,
              start: 3,
              latest: 49,
              through: 49,
              reset: false,
              messages: [newest],
            }
          : {
              epoch: 'fixture',
              earliest: 1,
              start: 1,
              latest: 49,
              through: 2,
              reset: false,
              messages: [source, runtime].filter(({ seq }) => seq < cursor!.seq),
            };
      },
    },
    peers(id) {
      return id === 'reader' ? ['leader'] : [];
    },
    async summarize() {
      throw new Error('Searching should never invoke inference.');
    },
  });
  try {
    const result = await memory.search('reader', '', 'ArchiveSentinel', 'leader');
    expect(result.matches).toMatchObject([
      {
        agentId: 'leader',
        epoch: 'fixture',
        entries: [{ kind: 'original-message', seq: 1, truncated: true }],
      },
    ]);
    expect(result.matches[0]?.entries).toHaveLength(1);
    expect(result.matches[0]?.entries[0]?.text).toContain('ArchiveSentinel');
    const reference = { agentId: 'leader', epoch: 'fixture', seq: 1 };
    expect(await memory.sourceMessage('reader', '', reference)).toEqual({
      ...reference,
      ...source,
    });
    expect(await memory.sourceMessage('reader', '', { ...reference, seq: 2 })).toBeUndefined();
    await expect(memory.search('outsider', '', 'ArchiveSentinel', 'leader')).rejects.toThrow(
      'access denied',
    );
  } finally {
    await memory.close();
  }
});

test('a handoff retains a pending correction behind a tool-heavy timeline tail', async () => {
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: {
      async read(_agentId, _cursor, direction) {
        return direction === 'tail'
          ? { epoch: 'fixture', latest: 50, start: 4, through: 50, reset: false, messages: [] }
          : {
              epoch: 'fixture',
              latest: 50,
              start: 1,
              through: 48,
              reset: false,
              messages: [correction],
            };
      },
    },
    async summarize() {
      throw new Error('A handoff must never invoke extraction directly');
    },
  });
  try {
    expect(await memory.handoff('leader', 'cobalt')).toContain(correction.text);
  } finally {
    await memory.close();
  }
});

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

async function eventually(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 75; attempt++) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  expect(await predicate()).toBe(true);
}

test('stores chronological summaries, preserves original authority, and removes a dependent suffix', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-memory-'));
  const messages: MemorySourceMessage[] = [
    { ...first, turnId: '1', messageId: 'native-user' },
    { ...finding, turnId: '1', messageId: 'native-response' },
    { ...correction, turnId: '2' },
    { seq: 4, author: 'agent', text: 'I will advance it.', turnId: '2' },
  ];
  const prompts: string[] = [];
  const options = {
    databasePath: path.join(directory, 'memory.sqlite'),
    source: timeline(() => ({ epoch: 'one', messages })),
    peers: (id: string) => (id === 'peer' ? ['leader'] : []),
    async summarize(type: 'UAMP' | 'AAB', request: { content: string }[]) {
      const prompt = request.at(-1)!.content;
      prompts.push(prompt);
      return {
        type,
        text: prompt.includes(correction.text) ? 'corrected-decision' : 'initial-discovery',
        complete: true,
        elapsedMs: 1,
      };
    },
  };
  let memory = new SessionMemory(options);
  try {
    memory.turn('leader', { turnId: '1', outcome: 'completed' }, false);
    memory.turn('leader', { turnId: '2', outcome: 'completed' }, false);
    await eventually(async () => !(await memory.search('peer', '', '', 'leader')).incomplete);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('initial-discovery');
    const handoff = await memory.handoff('leader', 'cursor');
    expect(handoff).toContain(first.text);
    expect(handoff).toContain(correction.text);
    expect(
      (await memory.search('peer', '', 'corrected-decision', 'leader')).matches[0]?.entries,
    ).toMatchObject([{ kind: 'UAMP', sources: [3, 4] }]);
    const reference = { agentId: 'leader', epoch: 'one', seq: 1 };
    expect(await memory.sourceMessage('peer', '', reference)).toMatchObject({
      messageId: 'native-user',
    });
    await expect(memory.sourceMessage('outsider', '', reference)).rejects.toThrow('access denied');

    await memory.close();
    memory = new SessionMemory(options);
    memory.recover(['leader']);
    await eventually(async () => !(await memory.search('peer', '', '', 'leader')).incomplete);
    expect(prompts).toHaveLength(2);
    messages.splice(2);
    expect((await memory.search('peer', '', 'corrected-decision', 'leader')).matches).toEqual([]);
    expect(await memory.handoff('leader', 'cursor')).not.toContain(correction.text);
  } finally {
    await memory.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test('gives foreground inference priority and exposes originals during a failed summary', async () => {
  const messages = [
    { ...first, turnId: '1' },
    { ...finding, turnId: '1' },
  ];
  let calls = 0;
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: timeline(() => ({ epoch: 'one', messages })),
    async summarize(type) {
      calls++;
      return { type, text: 'partial answer', complete: false, elapsedMs: 1 };
    },
  });
  try {
    memory.foregroundStarted('local-worker');
    memory.turn('leader', { turnId: '1', outcome: 'completed' }, false);
    expect(await memory.handoff('leader', 'cursor')).toContain(first.text);
    expect(calls).toBe(0);
    memory.foregroundEnded('local-worker');
    await eventually(() => calls === 1);
    expect((await memory.search('leader', '', 'partial answer')).matches).toEqual([]);
    expect((await memory.search('leader', '', 'cobalt')).incomplete).toBe(true);
    expect(await memory.handoff('leader', 'cursor')).toContain(first.text);
  } finally {
    await memory.close();
  }
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

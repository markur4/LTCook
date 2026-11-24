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
} from '../../../runtime/src/session-memory/extraction.js';
import { SessionMemory, type MemorySource } from '../../../runtime/src/session-memory/service.js';
import { createSessionMemoryTool } from '../../../runtime/src/tools/session-memory.js';

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
    async extract() {
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
    async extract() {
      throw new Error('A handoff must never invoke extraction directly');
    },
  });
  try {
    expect(await memory.handoff('leader', 'cobalt')).toContain(correction.text);
  } finally {
    await memory.close();
  }
});

test('invalidates preserved user messages beyond a shortened timeline in the same epoch', async () => {
  let messages = [first, finding, correction];
  const failure = Promise.withResolvers<void>();
  const memory = new SessionMemory({
    databasePath: ':memory:',
    threshold: 1,
    source: {
      async read() {
        const latest = messages.at(-1)!.seq;
        return { epoch: 'fixture', latest, through: latest, reset: false, messages };
      },
    },
    async extract() {
      throw new Error('Inference failed before advancing the checkpoint');
    },
    onFailure: failure.resolve,
  });
  try {
    memory.observe('leader');
    await failure.promise;
    expect((await memory.search('leader', '', 'advance')).matches[0]?.entries).toEqual([revision]);

    messages = [first, finding];
    expect((await memory.search('leader', '', 'advance')).matches).toEqual([]);
    expect(await memory.handoff('leader', 'cobalt')).not.toContain(correction.text);
  } finally {
    await memory.close();
  }
});

test('preserves reconstructed prompts with unverified authorship without extracting them', async () => {
  const prompt = { ...first, author: 'unknown' as const };
  const assigned = { ...issue, author: 'runtime' as const };
  const updated = Promise.withResolvers<readonly MemoryMessage[]>();
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: {
      async read() {
        return {
          epoch: 'rebuilt',
          latest: 4,
          through: 4,
          reset: false,
          messages: [prompt, finding, correction, assigned],
        };
      },
    },
    async extract(messages) {
      updated.resolve(messages);
      return [];
    },
  });
  try {
    memory.observe('leader', true);
    expect(await updated.promise).toEqual([finding]);
    expect((await memory.search('leader', '', 'Keep')).matches[0]?.entries).toEqual([
      { kind: 'unattributed-prompt', ...prompt },
    ]);
    const handoff = await memory.handoff('leader', 'cobalt');
    expect(handoff).toContain('Prompts marked unknown have no confirmed author');
    expect(handoff).not.toContain(`[1] ${JSON.stringify(prompt.text)}`);
    expect(handoff).toContain(correction.text);
    expect(handoff).not.toContain(assigned.text);
  } finally {
    await memory.close();
  }
});

test('preserves recent user messages while an older evidence batch keeps failing', async () => {
  let messages = [first, finding];
  const attempts: number[][] = [];
  const firstFailure = Promise.withResolvers<void>();
  const secondFailure = Promise.withResolvers<void>();
  const memory = new SessionMemory({
    databasePath: ':memory:',
    threshold: 1,
    source: {
      async read(_agentId, cursor, direction) {
        const page =
          direction === 'tail'
            ? messages.slice(-2)
            : messages.filter(({ seq }) => seq > (cursor?.seq ?? -1)).slice(0, 2);
        return {
          epoch: 'fixture',
          latest: messages.at(-1)!.seq,
          through: page.at(-1)!.seq,
          reset: false,
          messages: page,
        };
      },
    },
    async extract(evidence) {
      attempts.push(evidence.map(({ seq }) => seq));
      throw new Error('The older evidence batch still fails');
    },
    onFailure() {
      if (attempts.length === 1) firstFailure.resolve();
      else secondFailure.resolve();
    },
  });
  try {
    memory.observe('leader');
    await firstFailure.promise;
    messages = [first, finding, correction, issue];
    memory.observe('leader');
    await secondFailure.promise;

    expect(attempts).toEqual([[finding.seq], [finding.seq]]);
    expect(await memory.search('leader', '', 'advance')).toMatchObject({
      incomplete: true,
      matches: [{ entries: [revision] }],
    });
  } finally {
    await memory.close();
  }
});

test('coalesces updates, shares only authorized context, and recovers from a failed checkpoint', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-memory-test-'));
  let epoch = 'before';
  let messages = [first, finding];
  const source: MemorySource = {
    async read(id, cursor, direction = 'after') {
      if (id !== 'leader') throw new Error('Absent conversation');
      const latest = messages.at(-1)?.seq ?? -1;
      const reset = cursor !== undefined && cursor.epoch !== epoch;
      return {
        epoch,
        latest,
        through: latest,
        reset,
        messages:
          direction === 'tail' || reset
            ? [...messages]
            : messages.filter(({ seq }) =>
                direction === 'after' ? seq > (cursor?.seq ?? -1) : seq < cursor!.seq,
              ),
      };
    },
  };
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempts: number[][] = [];
  let failures = 0;
  const options = {
    databasePath: path.join(directory, 'memory.sqlite'),
    source,
    threshold: 1,
    peers: (agentId: string, workspace: string) =>
      agentId === 'peer' && workspace === directory ? ['leader'] : [],
    async extract(pending: readonly MemoryMessage[]): Promise<MemoryEntry[]> {
      attempts.push(pending.map(({ seq }) => seq));
      if (attempts.length === 1) await slow;
      if (attempts.length === 2) throw new Error('Transient inference failure');
      return pending.flatMap(({ author, seq, text }) =>
        author !== 'user' && author !== 'runtime' ? [{ kind: 'finding', author, seq, text }] : [],
      );
    },
    onFailure() {
      failures++;
    },
  };
  let memory = new SessionMemory(options);
  const context = {
    agentId: 'peer',
    workspaceRoot: directory,
    workspaceFileAccess: false,
    signal: AbortSignal.timeout(2000),
  };
  async function eventually(condition: () => boolean | Promise<boolean>) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await condition()) return;
      await Bun.sleep(5);
    }
    throw new Error('Session Memory did not settle');
  }
  try {
    memory.observe('leader');
    memory.observe('leader');
    await eventually(() => attempts.length === 1);
    expect((await memory.search('peer', directory, 'Keep', 'leader')).matches[0]?.entries).toEqual([
      original,
    ]);
    messages = [first, finding, correction, issue];
    const pending = await memory.handoff('leader', 'cobalt cursor');
    expect(pending).toContain(correction.text);
    expect(pending.indexOf(first.text)).toBeLessThan(pending.indexOf(correction.text));
    expect(pending).toContain('"potentiallyIncomplete":true');
    memory.observe('leader', true);
    memory.observe('leader');
    release();
    await eventually(() => failures === 1);
    expect(attempts).toEqual([[2], [4]]);
    const result = await createSessionMemoryTool(memory).invoke(
      { agentId: 'leader', query: 'cobalt' },
      context,
    );
    expect(result).toMatchObject({
      incomplete: true,
      matches: [
        {
          agentId: 'leader',
          epoch,
          entries: [
            { kind: 'original-message', ...issue },
            revision,
            { kind: 'finding', ...finding },
            original,
          ],
        },
      ],
    });
    const ref = { agentId: 'leader', epoch, seq: 1 };
    await expect(
      createSessionMemoryTool(memory).invoke({ source: ref }, { ...context, agentId: 'outsider' }),
    ).rejects.toThrow('access denied');
    await expect(
      createSessionMemoryTool(memory).invoke(
        { source: ref },
        { ...context, workspaceRoot: '/another-workspace' },
      ),
    ).rejects.toThrow('access denied');

    await memory.close();
    memory = new SessionMemory(options);
    memory.recover(['leader']);
    await eventually(
      async () => !(await memory.search('peer', directory, 'cobalt', 'leader')).incomplete,
    );
    expect(attempts).toEqual([[2], [4], [4]]);
    expect(await memory.sourceMessage('peer', directory, ref)).toMatchObject(first);

    epoch = 'rewound';
    messages = [];
    expect(await memory.sourceMessage('peer', directory, ref)).toBeUndefined();
    expect((await memory.search('peer', directory, '', 'leader')).matches).toEqual([]);
  } finally {
    release();
    await memory.close();
    await rm(directory, { recursive: true, force: true });
  }
});

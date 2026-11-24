import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mergeMemoryEntries,
  parseMemorySelections,
  preserveUserMessages,
  memoryEntriesSchema,
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
const [original, revision] = preserveUserMessages([first, correction]);

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
          entries: [revision, { kind: 'finding', ...finding }, original],
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

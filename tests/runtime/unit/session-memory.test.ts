import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyMemoryDelta,
  memoryEntriesSchema,
  type MemoryEntry,
  type MemoryMessage,
} from '../../../runtime/src/session-memory/extraction.js';
import { SessionMemory, type MemorySource } from '../../../runtime/src/session-memory/service.js';
import { createSessionMemoryTool } from '../../../runtime/src/tools/session-memory.js';

const first: MemoryMessage = { seq: 1, author: 'user', text: 'Keep the cobalt cursor.' };
const correction: MemoryMessage = {
  seq: 2,
  author: 'user',
  text: 'Correction for cobalt: advance the cursor.',
};
const entry: MemoryEntry = {
  id: 'keep',
  kind: 'constraint',
  status: 'confirmed',
  text: first.text,
  sources: [first.seq],
};

test('applies only sourced changes and retains the evidence for a superseded decision', () => {
  const replacement = { ...entry, id: 'advance', text: correction.text, sources: [2] };
  const delta = { upsert: [replacement], supersede: [{ id: entry.id, source: 2 }] };
  expect(applyMemoryDelta([entry], [correction], delta)).toEqual([
    { ...entry, status: 'superseded', sources: [1, 2] },
    replacement,
  ]);
  expect(() => applyMemoryDelta([entry], [{ ...correction, author: 'runtime' }], delta)).toThrow(
    'new user source',
  );
  expect(() =>
    applyMemoryDelta([entry], [correction], {
      ...delta,
      upsert: [{ ...replacement, sources: [3] }],
    }),
  ).toThrow('Invalid Memory source');
  expect(applyMemoryDelta([entry], [correction], { upsert: [], supersede: [] })).toEqual([entry]);
});

test('a correction preserves the cited sources of a full entry on reload', () => {
  const sources = Array.from({ length: 12 }, (_, index) => index + 1);
  const saved = applyMemoryDelta([{ ...entry, sources }], [{ ...correction, seq: 13 }], {
    upsert: [],
    supersede: [{ id: entry.id, source: 13 }],
  });
  expect(memoryEntriesSchema.parse(JSON.parse(JSON.stringify(saved)))).toEqual([
    { ...entry, status: 'superseded', sources: [...sources, 13] },
  ]);
});

test('a handoff retains a pending correction behind a tool-heavy timeline tail', async () => {
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: {
      async read(_agentId, _cursor, direction) {
        return direction === 'tail'
          ? { epoch: 'fixture', latest: 50, start: 3, through: 50, reset: false, messages: [] }
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
  let messages = [first];
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
    async extract(entries: readonly MemoryEntry[], pending: readonly MemoryMessage[]) {
      attempts.push(pending.map(({ seq }) => seq));
      if (attempts.length === 1) await slow;
      if (attempts.length === 2) throw new Error('Transient inference failure');
      return entries.length ? [...entries] : [entry];
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
    messages = [first, correction];
    const pending = await memory.handoff('leader', 'cobalt cursor');
    expect(pending).toContain(correction.text);
    expect(pending).toContain('"potentiallyIncomplete":true');
    memory.observe('leader', true);
    memory.observe('leader');
    release();
    await eventually(() => failures === 1);
    expect(attempts).toEqual([[1], [2]]);
    const result = await createSessionMemoryTool(memory).invoke(
      { agentId: 'leader', query: 'cobalt' },
      context,
    );
    expect(result).toMatchObject({
      incomplete: true,
      matches: [{ agentId: 'leader', epoch, entries: [entry] }],
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
    expect(attempts).toEqual([[1], [2], [2]]);
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

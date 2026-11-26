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
import {
  MemorySummaryError,
  SessionMemory,
  type MemorySource,
} from '../../../runtime/src/session-memory/service.js';
import { MemoryStore } from '../../../runtime/src/session-memory/store.js';
import { prepareMemorySummaries } from '../../../runtime/src/session-memory/summarization.js';
import { referenceFixture } from '../../../evals/session-memory-simplified.js';
import type { MemorySourceMessage } from '../../../runtime/src/session-memory/units.js';
import {
  createHostedMemorySummarizer,
  validHostedMemoryRequest,
} from '../../../runtime/src/session-memory/hosted.js';
import { PastedDocuments } from '../../../runtime/src/session-memory/pasted-documents.js';
import { readFile, readdir } from 'node:fs/promises';

const first: MemoryMessage = { seq: 1, author: 'user', text: 'Keep the cobalt cursor.' };
const finding: MemoryMessage = { seq: 2, author: 'agent', text: 'Cobalt test passed.' };
const longReply = {
  ...finding,
  text: finding.text + ' The cursor remains valid for the existing readers.'.repeat(26),
};
const correction: MemoryMessage = {
  seq: 3,
  author: 'user',
  text: 'Correction for cobalt: advance the cursor.',
};
const issue: MemoryMessage = { seq: 4, author: 'tool', text: 'Cobalt shell exited with code 1.' };
const [original, revision] = preservePromptMessages([first, correction]);

test.each([false, true])(
  'handoff keeps scoped Discussion units within its budget (oversized: %s)',
  async (oversized) => {
    const fixture = referenceFixture();
    const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-handoff-records-'));
    const databasePath = path.join(directory, 'memory.sqlite');
    const turns = fixture.turns.map((turn) =>
      turn.map((message) => ({ ...message, seq: message.seq * 2 })),
    );
    const unrelated: MemorySourceMessage = {
      seq: 7,
      turnId: 'other',
      author: 'user',
      scope: { sessionId: 'snapshot', taskId: 'other' },
      text: 'Unrelated task must never enter the handoff.',
    };
    const messages = [...turns.slice(0, -1).flat(), unrelated].sort((a, b) => a.seq - b.seq);
    const store = new MemoryStore(databasePath);
    const proposalEnd = 'The recorded proposal still awaits approval.';
    const details = ' Retain the existing public entry point and verify the reader contract.';
    const records = [
      {
        index: 0,
        state: 'summarized' as const,
        content:
          'Proposed restart reuse of selectWorkspaceSnapshot for compatible caches.' +
          details.repeat(oversized ? 65 : 25) +
          ' ' +
          proposalEnd,
      },
      { index: 1, state: 'skipped' as const },
      { index: 2, state: 'skipped' as const },
      {
        index: 3,
        state: 'summarized' as const,
        content: 'Implement that, preserve the API, reject automatic rebuild. No changes yet.',
      },
    ];
    for (const { index, state, content } of records) {
      const sources = turns[index]!;
      store.saveSummary({
        id: `unit-${index}`,
        agentId: 'leader',
        sessionId: 'snapshot',
        epoch: 'one',
        type: 'UAMP',
        position: sources.at(-1)!.seq,
        sources,
        scope: sources[0]!.scope,
        createdAt: '2026-01-01T00:00:00Z',
        state,
        historyHash: '',
        parts: content
          ? [{ content, format: 'markdown', sources: sources.map(({ seq }) => seq) }]
          : [],
        expectedParts: 1,
        complete: true,
      });
    }
    store.saveSummary({
      id: 'unrelated',
      agentId: 'leader',
      sessionId: 'snapshot',
      epoch: 'one',
      type: 'UAMP',
      position: 7,
      sources: [unrelated],
      scope: unrelated.scope,
      createdAt: '2026-01-01T00:00:00Z',
      state: 'skipped',
      historyHash: '',
      parts: [],
      expectedParts: 1,
      complete: true,
    });
    store.saveState('leader', { epoch: 'one', seq: 16 });
    store.savePrompts('leader', 'one', messages);
    store.close();
    const memory = new SessionMemory({
      databasePath,
      source: timeline(() => ({ epoch: 'one', messages })),
      async summarize() {
        throw new Error('Inference must not run.');
      },
    });
    try {
      const result = await memory.handoffDetails(
        'leader',
        turns.at(-1)![0]!.text,
        undefined,
        false,
        undefined,
        turns[3]![0]!.scope,
      );
      const text = result.text;
      for (const phrase of [
        'selectWorkspaceSnapshot',
        'Can we use it?',
        'Yes, on compatible caches.',
        'Please keep that option on the table.',
        'It remains a proposal.',
        'Implement that',
      ])
        expect(text).toContain(phrase);
      expect(text.indexOf('Can we use it?')).toBeLessThan(
        text.indexOf('Please keep that option on the table.'),
      );
      expect(text.indexOf('Please keep that option on the table.')).toBeLessThan(
        text.indexOf('UAMP summary [#14, #16]'),
      );
      expect(text.indexOf('UAMP summary [#14, #16]')).toBeLessThan(
        text.indexOf('Latest applicable original user instruction'),
      );
      expect(text).toContain('Latest applicable original user instruction\n- Original user [#14]');
      expect(text.includes(proposalEnd)).toBe(!oversized);
      if (oversized) expect(text).toContain('UAMP summary [#2, #4] (excerpt)');
      expect(text).toContain('Some relevant context is truncated or omitted.');
      expect(estimateMemoryTokens(text)).toBeLessThan(1700);
      expect(result.recoveredSources).toEqual([]);
      expect(result.selection?.decision?.seq).toBe(14);
      expect(text).not.toContain('Unrelated task must never enter the handoff.');
    } finally {
      await memory.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
    expect(result.status).toEqual({
      summariesPending: true,
      resultsTruncated: true,
      originalHistory: 'available',
    });
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
    expect((await memory.sourceMessage('reader', '', reference)).source).toEqual({
      ...reference,
      ...source,
    });
    expect(await memory.sourceMessage('reader', '', { ...reference, seq: 2 })).toEqual({
      lookup: 'not-found',
      latestSequence: 49,
    });
    expect(await memory.sourceMessage('reader', '', { ...reference, seq: 50 })).toEqual({
      lookup: 'not-found',
      latestSequence: 49,
    });
    await expect(memory.search('outsider', '', 'ArchiveSentinel', 'leader')).rejects.toThrow(
      'access denied',
    );
  } finally {
    await memory.close();
  }
});

test('a handoff retains a pending correction behind a tool-heavy timeline tail', async () => {
  const messages: MemorySourceMessage[] = [
    first,
    finding,
    correction,
    ...Array.from({ length: 5 }, (_, index) => ({ ...issue, seq: index + 4 })),
  ];
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: timeline(() => ({ epoch: 'fixture', messages })),
    async summarize() {
      throw new Error('A handoff must never invoke summarization directly');
    },
  });
  try {
    expect(await memory.handoff('leader', 'cobalt')).toContain(correction.text);
  } finally {
    await memory.close();
  }
});

test('places the latest applicable user decision after scoped, deduplicated evidence', async () => {
  const task = { taskId: 'cache' };
  const messages: MemorySourceMessage[] = [
    { ...first, scope: task },
    { seq: 2, author: 'user', text: 'Initial cache proposal: discard the cursor.', scope: task },
    { ...correction, text: 'Final cache decision: advance the cursor.', scope: task },
    { seq: 4, author: 'tool', text: 'CACHE_CHECK PASS.', scope: task },
    { seq: 5, author: 'tool', text: 'CACHE_CHECK PASS.', scope: task },
    {
      seq: 6,
      author: 'user',
      text: 'Other cache project: remove the cursor.',
      scope: { taskId: 'other' },
    },
    { seq: 7, author: 'user', text: 'What is the cache cursor status?', scope: task },
  ];
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: timeline(() => ({ epoch: 'one', messages })),
    async summarize() {
      throw new Error('A handoff must never invoke summarization directly.');
    },
  });
  try {
    const result = await memory.handoffDetails(
      'leader',
      'cache cursor',
      undefined,
      true,
      undefined,
      task,
    );
    expect(result.selection?.decision?.seq).toBe(3);
    expect(
      result.text.endsWith('Original user [#3] Final cache decision: advance the cursor.'),
    ).toBe(true);
    expect(result.text).not.toContain('discard the cursor');
    expect(result.text).not.toContain('remove the cursor');
    expect(result.entries.filter(({ text }) => text === 'CACHE_CHECK PASS.')).toHaveLength(1);
    expect(result.text).toContain('Historical tool outcome');
  } finally {
    await memory.close();
  }
});

test('reports pending summaries separately from history availability and truncation', async () => {
  const messages = [first, finding, correction];
  const source = timeline(() => ({ epoch: 'one', messages }));
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: {
      async read(agentId, cursor, direction) {
        if (agentId === 'offline' || direction === 'before')
          throw new Error('History unavailable.');
        return source.read(agentId, cursor, direction);
      },
    },
    async summarize() {
      throw new Error('Search must never invoke summarization.');
    },
  });
  try {
    const partial = await memory.search('leader', '', 'cobalt', undefined, undefined, true);
    expect(partial.status).toEqual({
      summariesPending: true,
      resultsTruncated: false,
      originalHistory: 'partial',
    });
    expect(partial.matches[0]?.entries.some(({ seq }) => seq === correction.seq)).toBe(true);
    const unavailable = await memory.search('offline', '', 'cobalt');
    expect(unavailable.status).toEqual({
      summariesPending: false,
      resultsTruncated: false,
      originalHistory: 'unavailable',
    });
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

test('persists device identity, resolves its current index, and releases a CPU runner once', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-memory-device-'));
  const messages: MemorySourceMessage[] = [];
  const requests: unknown[] = [];
  const gpu = { id: 'CUDA:gpu', label: 'Fixture GPU', mainGpu: 1 };
  const options = {
    databasePath: path.join(directory, 'memory.sqlite'),
    source: timeline(() => ({ epoch: 'one', messages })),
    async deviceCatalog() {
      return { devices: [gpu] };
    },
    async summarize(
      type: 'UAMP' | 'AAB',
      _prompt: unknown,
      _signal: AbortSignal,
      placement: { cpuOnly?: boolean; mainGpu?: number },
    ) {
      requests.push(placement);
      return {
        type,
        text: 'Kept the cursor.',
        content: { results: 'Kept the cursor.' },
        complete: true as const,
        elapsedMs: 1,
      };
    },
    async releaseCpuModel() {
      requests.push('release CPU');
    },
  };
  let memory = new SessionMemory(options);
  async function summarizeTurn(turnId: string, storedCount: number) {
    messages.push(
      { ...first, seq: messages.length + 1, turnId },
      { ...longReply, seq: messages.length + 2, turnId },
    );
    memory.turn('leader', { turnId, outcome: 'completed' }, false);
    await eventually(() => memory.status(undefined, 'leader').stored?.uamp === storedCount);
  }
  try {
    expect(memory.status(undefined, 'leader').device.id).toBe('auto');
    await memory.device('cpu');
    await summarizeTurn('1', 1);
    await memory.close();
    memory = new SessionMemory(options);
    expect(memory.status(undefined, 'leader').device.id).toBe('cpu');
    await memory.device(gpu.id);
    await summarizeTurn('2', 2);
    await memory.close();
    gpu.mainGpu = 0;
    memory = new SessionMemory(options);
    expect(memory.status(undefined, 'leader').device).toEqual({ id: gpu.id, label: gpu.label });
    await summarizeTurn('3', 3);
    await memory.device('auto');
    await summarizeTurn('4', 4);
    expect(requests).toEqual([
      { cpuOnly: true },
      'release CPU',
      { mainGpu: 1 },
      { mainGpu: 0 },
      {},
    ]);
  } finally {
    await memory.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps the requested GPU and leaves summaries pending when the device disappears', async () => {
  const messages = [
    { ...first, turnId: '1' },
    { ...longReply, turnId: '1' },
  ];
  const gpu = { id: 'CUDA:removable', label: 'Fixture removable GPU', mainGpu: 0 };
  let available = true;
  let requestCount = 0;
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: timeline(() => ({ epoch: 'one', messages })),
    async deviceCatalog() {
      return { devices: available ? [gpu] : [] };
    },
    async summarize() {
      requestCount++;
      throw new Error('A missing GPU must not launch inference on a different device.');
    },
  });
  try {
    await memory.device(gpu.id);
    available = false;
    memory.turn('leader', { turnId: '1', outcome: 'completed' }, false);
    await eventually(() => memory.status(undefined, 'leader').summarization === 'failed');
    expect(memory.status(undefined, 'leader')).toMatchObject({
      device: { id: gpu.id, label: gpu.label },
      lastError: { message: expect.stringMatching(/GPU.*unavailable/) },
      pendingUamp: 1,
    });
    expect(requestCount).toBe(0);
    expect((await memory.readStoredSummaries('leader')).summaries).toMatchObject([
      { state: 'failed' },
    ]);
  } finally {
    await memory.close();
  }
});

test('stores the attachment citation from a native turn with only a trailing action', async () => {
  const messages: MemorySourceMessage[] = [
    {
      seq: 1,
      turnId: 'native',
      author: 'user',
      text: 'Consult the attached reference.',
      attachments: [
        { id: 'ref', name: 'Guide', text: 'Keep ATTACHED_CHECK part of the next run.' },
      ],
    },
    { seq: 2, turnId: 'native', author: 'agent', text: 'I will inspect the current result.' },
    { seq: 3, turnId: 'native', author: 'tool', text: 'Observed CHECK_CACHE PASS.' },
  ];
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: timeline(() => ({ epoch: 'one', messages })),
    async summarize() {
      throw new Error('A deterministic AAB must never invoke inference.');
    },
  });
  try {
    memory.turn('leader', { turnId: 'native', outcome: 'completed' }, false);
    await eventually(
      async () => !(await memory.search('leader', '', '', 'leader')).status.summariesPending,
    );
    const search = await memory.search('leader', '', 'ATTACHED_CHECK', 'leader');
    expect(search.matches.flatMap(({ entries }) => entries)).toContainEqual(
      expect.objectContaining({ kind: 'AAB', sources: [1], author: 'attachment' }),
    );
  } finally {
    await memory.close();
  }
});

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
    processing: 'legacy-json' as const,
    source: timeline(() => ({ epoch: 'one', messages })),
    peers: (id: string) => (id === 'peer' ? ['leader'] : []),
    async summarize(type: 'UAMP' | 'AAB', request: { content: string }[]) {
      const prompt = request.at(-1)!.content;
      prompts.push(prompt);
      const text = prompt.includes(correction.text) ? 'corrected-decision' : 'initial-discovery';
      return {
        type,
        text,
        content: { resolution: { value: text } },
        complete: true as const,
        elapsedMs: 1,
      };
    },
  };
  let memory = new SessionMemory(options);
  try {
    memory.turn('leader', { turnId: '1', outcome: 'completed' }, false);
    memory.turn('leader', { turnId: '2', outcome: 'completed' }, false);
    await eventually(
      async () => !(await memory.search('peer', '', '', 'leader')).status.summariesPending,
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('initial-discovery');
    expect(memory.status('session', 'leader')).toMatchObject({
      stored: { agentId: 'leader', epoch: 'one', uamp: 2, aab: 0 },
      lastDelivered: null,
      currentContext: null,
    });
    const fullCatalog = await memory.readStoredSummaries('leader');
    expect(fullCatalog.summaries[0]?.parts).toEqual([
      { content: { resolution: { value: 'corrected-decision' } }, format: 'json', sources: [3, 4] },
    ]);
    const firstPassage = await memory.readStoredSummaries('leader', undefined, {
      passage: { epoch: 'one', start: 1, position: 2 },
    });
    expect(firstPassage.summaries).toEqual([fullCatalog.summaries[1]]);
    expect(firstPassage.next).toBeNull();
    const unmatchedPassage = await memory.readStoredSummaries('leader', undefined, {
      passage: { epoch: 'one', start: 3, position: 3 },
    });
    expect(unmatchedPassage.summaries).toEqual([]);
    const overlappingPassage = await memory.readStoredSummaries('leader', undefined, {
      passage: { epoch: 'one', start: 4, position: 4 },
    });
    expect(overlappingPassage.summaries).toEqual([]);
    await expect(
      memory.readStoredSummaries('leader', undefined, {
        passage: { epoch: 'replacement', start: 1, position: 2 },
      }),
    ).rejects.toThrow('Conversation history changed.');
    await expect(
      memory.readStoredSummaries('leader', undefined, {
        passage: { epoch: 'one', start: 3, position: 5 },
      }),
    ).rejects.toThrow('Conversation history changed.');
    expect(prompts).toHaveLength(2);
    const catalog = await memory.readStoredSummaries('leader', undefined, {
      includeContent: false,
    });
    expect(catalog.storagePath).toBe(options.databasePath);
    expect(
      catalog.summaries.map(({ position, durationMs, parts }) => ({ position, durationMs, parts })),
    ).toEqual([
      { position: 4, durationMs: 1, parts: [] },
      { position: 2, durationMs: 1, parts: [] },
    ]);
    for (const summary of catalog.summaries) {
      expect(summary.originalTokens).toBeGreaterThan(0);
      expect(summary.summaryTokens).toBeGreaterThan(0);
    }
    let acknowledge: (() => void) | undefined;
    const handoff = await memory.handoff('leader', 'cursor', undefined, (payload) => {
      acknowledge = memory.prepareDelivery('session', 'worker', payload);
    });
    expect(acknowledge).toBeDefined();
    expect(memory.status('session', 'worker').lastDelivered).toBeNull();
    acknowledge?.();
    expect(memory.status('session', 'worker')).toMatchObject({
      stored: null,
      currentContext: null,
      lastDelivered: {
        sourceAgentId: 'leader',
        recipientAgentId: 'worker',
        bytes: Buffer.byteLength(handoff),
      },
    });
    expect(memory.status('different-session', 'worker').lastDelivered).toBeNull();
    expect(memory.status('session', 'leader', 'replacement').stored).toBeNull();
    expect(memory.status('session', 'worker', 'replacement')).toMatchObject({
      currentContext: null,
      lastDelivered: { recipientEpoch: null },
    });
    expect(handoff).toContain(first.text);
    expect(handoff).toContain(correction.text);
    expect(
      (await memory.search('peer', '', 'corrected-decision', 'leader')).matches[0]?.entries,
    ).toMatchObject([{ kind: 'UAMP', sources: [3, 4] }]);
    const reference = { agentId: 'leader', epoch: 'one', seq: 1 };
    expect((await memory.sourceMessage('peer', '', reference)).source).toMatchObject({
      messageId: 'native-user',
    });
    await expect(memory.sourceMessage('outsider', '', reference)).rejects.toThrow('access denied');

    await memory.close();
    memory = new SessionMemory(options);
    memory.recover(['leader']);
    await eventually(
      async () => !(await memory.search('peer', '', '', 'leader')).status.summariesPending,
    );
    expect(prompts).toHaveLength(2);
    messages.splice(2);
    expect((await memory.search('peer', '', 'corrected-decision', 'leader')).matches).toEqual([]);
    expect(await memory.handoff('leader', 'cursor')).not.toContain(correction.text);
  } finally {
    await memory.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test.each(['legacy-json', 'deterministic-markdown'] as const)(
  'a delayed read cannot invalidate summaries rebuilt for a replacement history (%s)',
  async (processing) => {
    const reply = processing === 'deterministic-markdown' ? longReply : finding;
    let epoch = 'initial';
    let messages: MemorySourceMessage[] = [
      { ...first, turnId: 'initial' },
      { ...reply, turnId: 'initial' },
    ];
    const source = timeline(() => ({ epoch, messages }));
    const readerWaiting = Promise.withResolvers<void>();
    const releaseReader = Promise.withResolvers<void>();
    let pauseRead = false;
    let requests = 0;
    const memory = new SessionMemory({
      databasePath: ':memory:',
      processing,
      contextIndependent: processing === 'deterministic-markdown',
      source: {
        async read(...args) {
          if (pauseRead && args[2] === 'tail') {
            pauseRead = false;
            readerWaiting.resolve();
            await releaseReader.promise;
          }
          return source.read(...args);
        },
      },
      async summarize(type) {
        requests++;
        return {
          type,
          text: 'Retained model evidence.',
          content: 'Retained model evidence.',
          complete: true,
          elapsedMs: 1,
        };
      },
    });
    try {
      memory.turn('leader', { turnId: 'initial', outcome: 'completed' }, false);
      await eventually(
        async () => !(await memory.search('leader', '', '')).status.summariesPending,
      );

      pauseRead = true;
      const delayedRead = memory.search('leader', '', 'retained model');
      await readerWaiting.promise;
      epoch = 'replacement';
      messages = [
        { ...correction, seq: 1, turnId: 'replacement' },
        { ...reply, turnId: 'replacement' },
      ];
      memory.turn('leader', { turnId: 'replacement', outcome: 'completed' }, false);
      await eventually(
        async () => !(await memory.search('leader', '', '')).status.summariesPending,
      );
      expect(requests).toBe(2);

      releaseReader.resolve();
      await delayedRead;
      const rebuilt = await memory.search('leader', '', 'retained model');
      expect(rebuilt.status.summariesPending).toBe(false);
      expect(rebuilt.matches).toMatchObject([
        { epoch: 'replacement', entries: [{ kind: 'UAMP', sources: [1, 2] }] },
      ]);
      expect(requests).toBe(2);
    } finally {
      releaseReader.resolve();
      await memory.close();
    }
  },
);

test.each(['legacy-json', 'deterministic-markdown'] as const)(
  'continues a newer turn when the older provider terminal event was missed (%s)',
  async (processing) => {
    const production = processing === 'deterministic-markdown';
    const messages: MemorySourceMessage[] = [
      { ...first, turnId: 'older' },
      { seq: 2, author: 'tool', text: 'CACHE_CHECK PASS', turnId: 'older' },
      { ...correction, turnId: 'newer' },
      {
        seq: 4,
        author: 'agent',
        text: production ? longReply.text : 'I will advance the cursor.',
        turnId: 'newer',
      },
    ];
    const completed: string[] = [];
    const memory = new SessionMemory({
      databasePath: ':memory:',
      processing,
      contextIndependent: production,
      source: timeline(() => ({ epoch: 'one', messages })),
      async summarize(type) {
        completed.push(type);
        return {
          type,
          text: 'Observed evidence.',
          content: 'Observed evidence.',
          complete: true,
          elapsedMs: 1,
        };
      },
    });
    try {
      memory.turn('leader', { turnId: 'older', outcome: 'running' }, true);
      memory.turn('leader', { turnId: 'newer', outcome: 'running' }, false);
      memory.turn('leader', { turnId: 'newer', outcome: 'completed' }, false);
      await eventually(
        async () => !(await memory.search('leader', '', '')).status.summariesPending,
      );
      expect(completed).toEqual(production ? ['UAMP'] : ['AAB', 'UAMP']);
      if (production) {
        expect((await memory.readStoredSummaries('leader')).summaries).toMatchObject([
          { type: 'UAMP', state: 'summarized' },
          { type: 'AAB', state: 'recorded' },
        ]);
      }
    } finally {
      await memory.close();
    }
  },
);

test('preserves checked tool evidence and uses originals for an omitted archived path', async () => {
  const messages: MemorySourceMessage[] = [
    {
      ...first,
      turnId: 'older',
      attachments: [
        { id: 'manifest', name: 'Manifest notes', text: 'The source is cache/manifest.json.' },
      ],
    },
    { seq: 2, author: 'tool', text: 'VERIFIED_CACHE_GUARD passed.', turnId: 'older' },
    {
      seq: 3,
      author: 'agent',
      text:
        'Scratch file runtime/src/old-cache.ts.bak. ' +
        'Unrelated workspace log entry. '.repeat(100) +
        'Observed implementation in runtime/src/old-cache.ts during the run. MADE_UP_CHECK PASS.',
      turnId: 'older',
    },
    { ...correction, seq: 4, turnId: 'newer' },
    { seq: 5, author: 'agent', text: 'The correction was noted.', turnId: 'newer' },
  ];
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: timeline(() => ({ epoch: 'one', messages })),
    async summarize(type) {
      return {
        type,
        text: 'Keep runtime/src/old-cache.ts.bak and runtime/src/OLD-cache.ts.',
        content: 'Keep runtime/src/old-cache.ts.bak and runtime/src/OLD-cache.ts.',
        complete: true,
        elapsedMs: 1,
      };
    },
  });
  try {
    memory.turn('leader', { turnId: 'older', outcome: 'completed' }, false);
    memory.turn('leader', { turnId: 'newer', outcome: 'completed' }, false);
    // > The long archived source deliberately exceeds the search result budget.
    await eventually(() => memory.status(undefined, 'leader').stored?.coveredThrough === 5);
    const check = await memory.handoff('leader', 'verified cache guard');
    expect(check).toContain('VERIFIED_CACHE_GUARD passed');
    expect(check).not.toContain('MADE_UP_CHECK');
    for (const path of ['runtime/src/old-cache.ts', 'old-cache.ts']) {
      const handoff = await memory.handoffDetails('leader', `Check ${path}.`);
      expect(handoff.entries).toContainEqual(
        expect.objectContaining({
          seq: 3,
          author: 'agent',
          kind: 'original-message',
          text: expect.stringContaining('runtime/src/old-cache.ts during the run'),
        }),
      );
    }
    const attachment = await memory.handoffDetails('leader', 'Locate cache/manifest.json.');
    expect(attachment.entries).toContainEqual(
      expect.objectContaining({
        seq: 1,
        author: 'attachment',
        text: 'The source is cache/manifest.json.',
      }),
    );
  } finally {
    await memory.close();
  }
});

test('stops fetching older originals when the delegation deadline expires', async () => {
  const messages: MemorySourceMessage[] = [
    first,
    finding,
    correction,
    ...Array.from({ length: 5 }, (_, index) => ({ ...issue, seq: index + 4 })),
  ];
  const source = timeline(() => ({ epoch: 'one', messages }));
  const deadline = new AbortController();
  let pages = 0;
  const memory = new SessionMemory({
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
    async summarize() {
      throw new Error('A handoff must never invoke summarization directly');
    },
  });
  try {
    await expect(memory.handoff('leader', 'Locate absent.ts.', deadline.signal)).rejects.toThrow();
    expect(pages).toBe(1);
  } finally {
    await memory.close();
  }
});

test('pauses active summaries, keeps stored summaries readable, and resumes queued turns', async () => {
  const messages: MemorySourceMessage[] = [];
  let calls = 0;
  let interrupted = false;
  let failures = 0;
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: timeline(() => ({ epoch: 'one', messages })),
    async summarize(type, _prompt, signal, _placement, onProgress) {
      calls++;
      if (calls === 2) {
        onProgress?.({ tokensPerSecond: 12, estimated: false });
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              interrupted = true;
              resolve();
            },
            { once: true },
          );
        });
      }
      return {
        type,
        text: 'Retained summary.',
        content: { resolution: 'Retained summary.' },
        complete: true,
        elapsedMs: 1,
      };
    },
    onFailure() {
      failures++;
    },
  });
  function completeTurn(turnId: string) {
    messages.push(
      { ...first, seq: messages.length + 1, turnId },
      { ...longReply, seq: messages.length + 2, turnId },
    );
    memory.turn('leader', { turnId, outcome: 'completed' }, false);
  }
  try {
    const status = () => memory.status(undefined, 'leader');
    completeTurn('one');
    await eventually(() => status().stored?.uamp === 1);
    completeTurn('two');
    await eventually(() => status().rate?.tokensPerSecond === 12);
    memory.setSummarizationEnabled(false);
    expect(interrupted).toBe(true);
    completeTurn('three');
    expect(status()).toMatchObject({ summarization: 'paused', rate: null, lastError: null });
    await memory.settled();
    expect(
      (await memory.readStoredSummaries('leader')).summaries.map(({ state }) => state),
    ).toEqual(['pending', 'pending', 'summarized']);
    expect(calls).toBe(2);
    memory.setSummarizationEnabled(true);
    await eventually(() => status().stored?.uamp === 3);
    expect(calls).toBe(4);
    expect(failures).toBe(0);
    expect((await memory.readStoredSummaries('leader')).summaries).toHaveLength(3);
  } finally {
    await memory.close();
  }
});

test('gives foreground inference priority and exposes originals during a failed summary', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-failed-discussion-'));
  const databasePath = path.join(directory, 'memory.sqlite');
  const messages = [
    { ...first, turnId: '1' },
    { ...longReply, turnId: '1' },
  ];
  let calls = 0;
  const memory = new SessionMemory({
    databasePath,
    source: timeline(() => ({ epoch: 'one', messages })),
    async summarize(type) {
      calls++;
      return {
        type,
        text: 'partial Markdown',
        complete: false,
        elapsedMs: 1,
      };
    },
  });
  try {
    memory.foregroundStarted('local-worker');
    memory.turn('leader', { turnId: '1', outcome: 'completed' }, false);
    expect(await memory.handoff('leader', 'cursor')).toContain(first.text);
    expect(calls).toBe(0);
    memory.foregroundEnded('local-worker');
    await eventually(() => memory.status(undefined, 'leader').summarization === 'failed');
    expect(calls).toBe(1);
    expect(memory.status(undefined, 'leader').lastError?.message).toContain('incomplete');
    expect((await memory.search('leader', '', 'partial Markdown')).matches).toEqual([]);
    expect((await memory.search('leader', '', 'cobalt')).status.summariesPending).toBe(true);
    expect(await memory.handoff('leader', 'cursor')).toContain(first.text);
    await memory.settled();
    const store = new MemoryStore(databasePath);
    const failed = store.summaries('leader', 'one').find(({ state }) => state === 'failed')!;
    store.close();
    expect(failed.complete).toBe(false);
    const originals = await memory.recordEntries('leader', 'one', [
      { ...failed, state: 'skipped', complete: true, parts: [] },
    ]);
    expect(originals.map(({ seq, author, text }) => ({ seq, author, text }))).toEqual(
      messages.map(({ seq, author, text }) => ({ seq, author, text })),
    );
  } finally {
    await memory.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('current-only requests omit skipped Discussions while retaining the current reference', () => {
  const [part] = prepareMemorySummaries(
    {
      type: 'UAMP',
      messages: [
        { seq: 5, author: 'user', text: 'Use the proposal from earlier.' },
        { seq: 6, author: 'agent', text: 'I will use it.' },
      ],
    },
    [],
    undefined,
    {
      contextIndependent: true,
      skipped: [
        {
          id: 'earlier',
          messages: [{ seq: 3, author: 'agent', text: 'Keep the cobalt cursor.' }],
        },
      ],
    },
  );
  expect(part!.sources).toEqual([5, 6]);
  expect(part!.historyIds).toEqual([]);
  expect(part!.prompt[1].content).toContain('Use the proposal from earlier.');
  expect(part!.prompt[1].content).not.toContain('Keep the cobalt cursor.');
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
    validHostedMemoryRequest(candidate, payload.model, payload.instructions, 'Fixture.');
  expect(accepts(payload)).toBe(true);
  expect(accepts({ ...payload, reasoning: { effort: 'none' } })).toBe(false);
  expect(accepts({ ...payload, previous_response_id: 'earlier' })).toBe(false);
  expect(accepts({ ...payload, tools: [{ type: 'function' }] })).toBe(false);
  expect(accepts({ ...payload, instructions: 'Summarize. More instructions.' })).toBe(false);
  expect(accepts({ ...payload, service_tier: 'priority' })).toBe(false);
});

test('Hosted Session Memory rejects the separately billed provider before submitting', async () => {
  const hosted = createHostedMemorySummarizer({
    alias: 'tiny',
    provider: 'openai',
    model: 'gpt-6-luna',
    reasoning: 'low',
    reasoningSource: 'alias',
  });
  await expect(
    hosted.summarize(
      'UAMP',
      [
        { role: 'system', content: 'Summarize.' },
        { role: 'user', content: 'Fixture.' },
      ],
      new AbortController().signal,
    ),
  ).rejects.toThrow('requires an openai-codex model');
  expect(hosted.usage().requests).toBe(0);
});

test('keeps original Discussion evidence available when the hosted provider fails', async () => {
  const fixture = referenceFixture();
  const failedTurn = fixture.turns[0]!;
  const messages = failedTurn.map((message) => ({
    ...message,
    turnId: 'hosted',
    text: message.author === 'agent' ? message.text + longReply.text : message.text,
  }));
  const original = messages.at(-1)!;
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: timeline(() => ({ epoch: 'one', messages })),
    contextIndependent: true,
    inference: {
      hosted: { model: 'gpt-6-luna', reasoning: 'low' },
      local: { model: 'lfm3:1.7b-qad-q4_0', reasoning: 'off' },
    },
    async deviceCatalog() {
      throw new Error('Hosted mode must not probe Ollama.');
    },
    async summarize(_type, prompt, _signal, placement, _progress, _format, mode) {
      expect(mode).toBe('hosted');
      expect(placement).toEqual({});
      expect(prompt[1].content).not.toContain('ADDITIONAL_TASK_CONTEXT');
      expect(prompt[1].content).toStartWith('Current original source messages:');
      throw new MemorySummaryError(
        'Hosted Session Memory reached a subscription quota or rate limit.',
      );
    },
  });
  try {
    memory.setInferenceMode('hosted');
    memory.turn(
      'leader',
      {
        turnId: 'hosted',
        outcome: 'completed',
        scope: { sessionId: 'snapshot', taskId: 'restart' },
        task: { title: 'ADDITIONAL_TASK_CONTEXT', description: '', acceptance: [] },
      },
      false,
    );
    await memory.settled();
    const activity = memory.status(undefined, 'leader');
    expect(activity.inference).toEqual({ mode: 'hosted', model: 'gpt-6-luna', reasoning: 'low' });
    expect(activity.device).toBeNull();
    expect(activity.summarization).toBe('failed');
    expect(activity.lastError?.message).toContain('subscription quota');
    const source = await memory.sourceMessage('leader', '', {
      agentId: 'leader',
      epoch: 'one',
      seq: original.seq,
    });
    expect(source.lookup).toBe('found');
    if (source.lookup === 'found') expect(source.source.text).toBe(original.text);
    expect(await memory.handoff('leader', 'selectWorkspaceSnapshot')).toContain(
      'selectWorkspaceSnapshot',
    );
    memory.setSummarizationEnabled(false);
    expect(memory.status(undefined, 'leader').inference?.model).toBe('gpt-6-luna');
  } finally {
    await memory.close();
  }
});

test('records actions and short Discussions without inference while paused, across restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-memory-recording-'));
  let epoch = 'before-rewind';
  let messages: MemorySourceMessage[] = [
    { seq: 1, turnId: 'one', author: 'user', text: 'Check the boundary.' },
    { seq: 2, turnId: 'one', author: 'agent', text: 'Checking the source now.' },
    ...[false, true].map((ok, index): MemorySourceMessage => ({
      seq: 3 + index,
      turnId: 'one',
      messageId: `tool-${index}`,
      author: 'tool',
      text: ok ? 'CACHE_BOUNDARY PASS' : 'CACHE_BOUNDARY FAIL',
      tool: {
        kind: 'shell',
        name: 'shell',
        status: ok ? 'completed' : 'failed',
        exitCode: ok ? 0 : 1,
      },
    })),
    { seq: 5, turnId: 'one', author: 'agent', text: 'The second run passed.' },
  ];
  const options = {
    databasePath: path.join(directory, 'memory.sqlite'),
    source: timeline(() => ({ epoch, messages })),
    async summarize(): Promise<never> {
      throw new Error('Inference was not expected.');
    },
  };
  let memory = new SessionMemory(options);
  try {
    memory.setSummarizationEnabled(false);
    memory.turn('leader', { turnId: 'one', outcome: 'completed' }, false);
    await memory.settled();
    await memory.close();
    memory = new SessionMemory(options);
    memory.setSummarizationEnabled(false);
    memory.recover(['leader']);
    await memory.settled();
    const passage = { epoch, start: 1, position: 5, turnId: 'one' };
    const { summaries } = await memory.readStoredSummaries('leader', undefined, { passage });
    expect(summaries).toMatchObject([
      { state: 'skipped', position: 5, parts: [] },
      {
        state: 'recorded',
        position: 4,
        discussionId: summaries[0]?.id,
        action: { checkCount: 2, failureCount: 1, counts: [{ kind: 'shell', count: 2 }] },
      },
    ]);
    const record = { epoch, position: 4, id: summaries[1]!.id };
    expect(await memory.readEvidenceReferences('leader', record)).toMatchObject({
      sources: [
        { seq: 2, author: 'agent' },
        { seq: 3, messageId: 'tool-0', author: 'tool' },
        { seq: 4, messageId: 'tool-1', author: 'tool' },
      ],
      next: null,
    });
    const handoff = await memory.handoffDetails('leader', 'CACHE_BOUNDARY', undefined, true);
    expect(handoff.text).toContain('CACHE_BOUNDARY FAIL');
    expect(handoff.text).toContain('CACHE_BOUNDARY PASS');
    expect(handoff.recoveredSources).toEqual([]);
    epoch = 'after-rewind';
    messages = [];
    expect(await memory.readEvidenceReferences('leader', record)).toEqual({
      sources: [],
      next: null,
    });
  } finally {
    await memory.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('recovers a production Discussion after incomplete history and interrupted inference', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-memory-production-recovery-'));
  let epoch = 'original';
  let messages: MemorySourceMessage[] = [
    { ...first, turnId: 'checkpoint', messageId: 'original-instruction' },
    { ...correction, seq: 2, turnId: 'checkpoint' },
    { ...longReply, seq: 3, turnId: 'checkpoint' },
  ];
  const source = timeline(() => ({ epoch, messages }));
  let historyComplete = false;
  let reopened = false;
  const requests: { prompt: string; format: string | undefined }[] = [];
  const options: ConstructorParameters<typeof SessionMemory>[0] = {
    databasePath: path.join(directory, 'memory.sqlite'),
    contextIndependent: true,
    source: {
      async read(id, cursor, direction) {
        if (!historyComplete && direction === undefined && cursor?.seq === 2)
          throw new Error('The second history page is temporarily unavailable.');
        return source.read(id, cursor, direction);
      },
    },
    async summarize(type, prompt, signal, _placement, _onProgress, format) {
      requests.push({ prompt: prompt.at(-1)!.content, format });
      if (!reopened) {
        await new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      const markdown = '## Decisions\n- Recovered checkpoint.';
      return { type, text: markdown, content: markdown, complete: true, elapsedMs: 1 };
    },
  };
  let memory = new SessionMemory(options);
  try {
    memory.turn('leader', { turnId: 'checkpoint', outcome: 'completed' }, false);
    await memory.settled();
    expect(requests).toHaveLength(0);
    expect((await memory.search('leader', '', 'cobalt')).status.summariesPending).toBe(true);

    historyComplete = true;
    memory.observe('leader', true);
    await eventually(() => requests.length === 1);
    expect((await memory.readStoredSummaries('leader')).summaries).toMatchObject([
      { state: 'pending', parts: [] },
    ]);
    await memory.close();

    reopened = true;
    memory = new SessionMemory(options);
    memory.recover(['leader']);
    await memory.settled();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[1]?.format).toBe('markdown');
    expect(requests[1]?.prompt).toContain(correction.text);
    expect((await memory.readStoredSummaries('leader')).summaries).toMatchObject([
      {
        state: 'summarized',
        parts: [{ format: 'markdown', sources: [1, 2, 3] }],
      },
    ]);
    expect((await memory.search('leader', '', 'checkpoint')).status.summariesPending).toBe(false);
    const reference = { agentId: 'leader', epoch, seq: 1 };
    expect(await memory.sourceMessage('leader', '', reference)).toMatchObject({
      lookup: 'found',
      source: { messageId: 'original-instruction', text: first.text },
    });

    epoch = 'replacement';
    messages = [];
    memory.recover(['leader']);
    await memory.settled();
    expect(await memory.sourceMessage('leader', '', reference)).toEqual({ lookup: 'unavailable' });
    expect((await memory.readStoredSummaries('leader')).summaries).toEqual([]);
    expect(requests).toHaveLength(2);
  } finally {
    await memory.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('reopens the preceding original Discussion after a short reference crosses into a Task', async () => {
  const discussion = { sessionId: 'session' };
  const task = { ...discussion, taskId: 'task' };
  const proposal = 'Consider reusing selectWorkspaceSnapshot on compatible caches.';
  const messages: MemorySourceMessage[] = [
    { seq: 1, turnId: 'proposal', author: 'user', scope: discussion, text: proposal },
    { ...longReply, seq: 2, turnId: 'proposal', scope: discussion },
    {
      seq: 3,
      turnId: 'clarification',
      author: 'user',
      scope: discussion,
      text: 'Keep that option open.',
    },
    {
      seq: 4,
      turnId: 'clarification',
      author: 'agent',
      scope: discussion,
      text: 'It remains a proposal.',
    },
    { seq: 5, turnId: 'approval', author: 'user', scope: task, text: 'Implement that.' },
    { ...longReply, seq: 6, turnId: 'approval', scope: task },
  ];
  const prompts: string[] = [];
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: timeline(() => ({ epoch: 'one', messages })),
    async summarize(type, prompt) {
      prompts.push(prompt[1].content);
      const text = 'The previous Discussion considered a cache change.';
      return { type, complete: true, text, content: text, elapsedMs: 0 };
    },
  });
  try {
    for (const turnId of ['proposal', 'clarification', 'approval'])
      memory.turn('leader', { turnId, outcome: 'completed' }, false);
    await memory.settled();
    expect(prompts).toHaveLength(2);
    const context = prompts[1]!.split('Current Task scope')[0]!;
    expect(context).toContain('User #1: ' + proposal);
    expect(context).toContain('Keep that option open.');
    expect(context).not.toContain('The previous Discussion considered a cache change.');
  } finally {
    await memory.close();
  }
});

test('includes supplied attachment bytes in the short Discussion threshold once', async () => {
  const prompts: string[] = [];
  const messages: MemorySourceMessage[] = [];
  for (const [index, bytes] of [1016, 1020].entries()) {
    const turnId = String(index);
    const attachment = { id: turnId, name: 'Reference', text: 'x'.repeat(bytes) };
    messages.push(
      {
        seq: index * 2 + 1,
        turnId,
        author: 'user',
        text: 'Go',
        attachments: [attachment, attachment],
      },
      { seq: index * 2 + 2, turnId, author: 'agent', text: 'OK' },
    );
  }
  const memory = new SessionMemory({
    databasePath: ':memory:',
    source: timeline(() => ({ epoch: 'one', messages })),
    async summarize(type, prompt, _signal, _placement, _progress, format) {
      expect(format).toBe('markdown');
      prompts.push(prompt[1]!.content);
      return {
        type,
        content: 'An unsectioned but useful boundary fact.',
        text: 'An unsectioned but useful boundary fact.',
        complete: true,
        elapsedMs: 1,
      };
    },
  });
  try {
    memory.turn('leader', { turnId: '0', outcome: 'completed' }, false);
    memory.turn('leader', { turnId: '1', outcome: 'completed' }, false);
    await memory.settled();
    expect(prompts).toHaveLength(1);
    expect((await memory.readStoredSummaries('leader')).summaries).toMatchObject([
      { state: 'summarized', originalTokens: 256 },
      { state: 'skipped', originalTokens: 255 },
    ]);
    expect((await memory.search('leader', '', 'unsectioned')).matches[0]?.entries).toMatchObject([
      { kind: 'UAMP', text: 'An unsectioned but useful boundary fact.' },
    ]);
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

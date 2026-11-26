import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ConversationRecords,
  memoryDispatchDeadlineMs,
  type MemorySource,
} from '../../../runtime/src/session-memory/conversation.js';
import type { MemorySourceMessage } from '../../../runtime/src/session-memory/units.js';

const leader = 'leader';
const epoch = 'conversation';
const scope = { sessionId: 'session', taskId: 'task' };
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function conversationTimeline(messages: MemorySourceMessage[]): MemorySource {
  return {
    async read(_agentId, cursor, direction) {
      const latest = messages.at(-1)?.seq ?? -1;
      const entries =
        direction === 'tail'
          ? messages.slice(-2)
          : direction === 'before'
            ? messages.filter(({ seq }) => seq < cursor!.seq).slice(-2)
            : messages.filter(({ seq }) => seq > (cursor?.seq ?? -1)).slice(0, 2);
      return {
        epoch,
        latest,
        through: entries.at(-1)?.seq ?? cursor?.seq ?? -1,
        start: entries[0]?.seq,
        earliest: messages[0]?.seq,
        messages: entries.map((entry) => ({ ...entry })),
        reset: Boolean(cursor && cursor.epoch !== epoch),
      };
    },
  };
}

test('delegation recovers an older proposal and its explicit approval from authorized originals', async () => {
  const messages: MemorySourceMessage[] = [
    { seq: 1, turnId: 'proposal', author: 'user', text: 'Which cursor format should we use?' },
    {
      seq: 2,
      turnId: 'proposal',
      author: 'agent',
      messageId: 'proposal-reply',
      text: 'Use an opaque cursor so the storage implementation can change independently.',
    },
    { seq: 3, turnId: 'approval', author: 'user', text: 'Yes, use the opaque cursor.' },
    { seq: 4, turnId: 'approval', author: 'agent', text: 'I will use that format.' },
    { seq: 5, turnId: 'aside', author: 'user', text: 'What is the test command?' },
    { seq: 6, turnId: 'aside', author: 'agent', text: 'Run the tests with just test.' },
  ];
  const records = new ConversationRecords({
    databasePath: ':memory:',
    source: conversationTimeline(messages),
    peers: (agentId, workspace) =>
      agentId === 'worker' && workspace === '/fixture' ? [leader] : [],
  });
  try {
    for (const turnId of ['proposal', 'approval', 'aside'])
      records.turn(leader, { turnId, outcome: 'completed', scope });
    await records.settled();

    const handoff = await records.handoff(
      leader,
      'Implement the cursor format',
      AbortSignal.timeout(memoryDispatchDeadlineMs),
      undefined,
      scope,
    );
    expect(handoff).toContain('Use an opaque cursor so the storage implementation');
    expect(handoff).toContain('Yes, use the opaque cursor.');
    const reference = { agentId: leader, epoch, seq: 2, messageId: 'proposal-reply' };
    expect(await records.sourceMessage('worker', '/fixture', reference)).toMatchObject({
      lookup: 'found',
      source: { seq: 2, messageId: 'proposal-reply' },
    });
    await expect(records.sourceMessage('unrelated', '/fixture', reference)).rejects.toThrow(
      /access denied/i,
    );
  } finally {
    await records.close();
  }
});

test('reopening the record store preserves exact attachment references and observes rewind', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-conversation-records-'));
  directories.push(directory);
  const attachment = { id: 'fixture-attachment', name: 'Source excerpt', text: 'Pasted evidence' };
  const messages: MemorySourceMessage[] = [
    {
      seq: 1,
      turnId: 'actions',
      author: 'user',
      text: 'Check this excerpt.',
      attachments: [attachment],
    },
    {
      seq: 2,
      turnId: 'actions',
      author: 'tool',
      messageId: 'check-result',
      text: 'CURSOR_FORMAT PASS',
      tool: { kind: 'shell', name: 'check', status: 'completed', exitCode: 0 },
    },
  ];
  const options = {
    databasePath: path.join(directory, 'conversation.sqlite'),
    source: conversationTimeline(messages),
  };
  const initial = new ConversationRecords(options);
  try {
    initial.turn(leader, { turnId: 'actions', outcome: 'completed', scope });
    await initial.finalize(leader);
    expect((await initial.records(leader)).batches).toEqual([
      expect.objectContaining({
        attachmentSources: [expect.objectContaining({ seq: 1 })],
        sources: [expect.objectContaining({ seq: 2, messageId: 'check-result' })],
      }),
    ]);
  } finally {
    await initial.close();
  }

  const reopened = new ConversationRecords(options);
  try {
    expect((await reopened.records(leader)).batches).toHaveLength(1);
    expect(
      await reopened.sourceMessage(leader, '', { agentId: leader, epoch, seq: 1 }),
    ).toMatchObject({ lookup: 'found', source: { attachments: [attachment] } });
    messages.pop();
    reopened.observe(leader, true);
    await reopened.settled();
    expect((await reopened.records(leader)).batches).toHaveLength(0);
    expect(
      await reopened.sourceMessage(leader, '', { agentId: leader, epoch, seq: 2 }),
    ).toMatchObject({ lookup: 'not-found' });
  } finally {
    await reopened.close();
  }
});

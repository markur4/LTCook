import { expect, test } from 'bun:test';
import type { PaseoApi } from '@getpaseo/client';
import type { BugHunterSnapshot } from '../../../runtime/src/paseo-plugin/shared/bughunter.js';
import { observeBugHunter } from '../../../runtime/src/paseo-plugin/server/bughunter.js';

const details: BugHunterSnapshot = {
  available: true,
  hunts: [
    {
      id: 'selected-hunt',
      status: 'running',
      createdAt: 1,
      automatic: true,
      components: ['repository-index'],
      findings: [],
      conversations: [{ id: 'allowed-agent', role: 'Coordinator', stage: 'scan' }],
    },
    {
      id: 'other-hunt',
      status: 'running',
      createdAt: 2,
      automatic: false,
      components: [],
      findings: [],
      conversations: [{ id: 'other-agent', role: 'Investigator', stage: 'scan' }],
    },
  ],
};

test('BugHunter follows only the selected hunt’s authorized native chat and redacts it', async () => {
  const opened: string[] = [];
  let releaseCount = 0;
  const paseo = {
    agents: {
      ref(id: string) {
        opened.push(id);
        return {
          timeline: {
            subscribe: () => ({
              ready: Promise.resolve(),
              async release() {
                releaseCount++;
              },
            }),
            async refetch() {
              return {
                agentId: id,
                epoch: 'fixture',
                entries: [
                  { seqStart: 1, item: { type: 'user_message', text: 'Check indexing.' } },
                  { seqStart: 2, item: { type: 'tool_call', text: 'private tool output' } },
                  {
                    seqStart: 3,
                    item: { type: 'assistant_message', text: 'Recovered. token=fixture-secret' },
                  },
                ],
              };
            },
          },
        };
      },
    },
  } as unknown as PaseoApi;
  const observe = async (agentId: string) => {
    const stop = new AbortController();
    const snapshots: BugHunterSnapshot[] = [];
    await observeBugHunter(
      paseo,
      { workspaceId: 'workspace', huntId: 'selected-hunt', agentId },
      stop.signal,
      async (snapshot) => {
        snapshots.push(snapshot);
        stop.abort();
      },
      async () => details,
    );
    return snapshots[0];
  };
  expect(await observe('other-agent')).toEqual(details);
  expect(opened).toEqual([]);
  expect((await observe('allowed-agent'))?.chat).toEqual({
    agentId: 'allowed-agent',
    messages: [
      { id: 'fixture:1', role: 'user', text: 'Check indexing.' },
      { id: 'fixture:3', role: 'assistant', text: 'Recovered. token=<redacted>' },
    ],
  });
  expect(opened).toEqual(['allowed-agent']);
  expect(releaseCount).toBe(1);
});

test('BugHunter streams chat without repeated history reads and clears replaced archived text', async () => {
  const stop = new AbortController();
  const snapshots: BugHunterSnapshot[] = [];
  const entries: Array<{
    seqStart: number;
    item: { type: string; text: string; messageId?: string };
  }> = [{ seqStart: 1, item: { type: 'user_message', text: 'Check indexing.' } }];
  let updated: ((type?: string) => void) | undefined;
  let historyReads = 0;
  let archived = false;
  const paseo = {
    agents: {
      ref(id: string) {
        return {
          timeline: {
            subscribe(
              listener: (input: {
                epoch: string;
                seq?: number;
                event: { type: string; epoch: string; item: unknown };
              }) => void,
            ) {
              updated = (type = 'timeline') =>
                listener({
                  epoch: 'fixture',
                  seq: entries.at(-1)?.seqStart,
                  event: { type, epoch: 'replaced', item: entries.at(-1)?.item },
                });
              return { ready: Promise.resolve(), async release() {} };
            },
            async refetch() {
              historyReads++;
              return { agentId: id, epoch: 'fixture', entries: [...entries] };
            },
          },
        };
      },
    },
  } as unknown as PaseoApi;
  const deadline = setTimeout(() => stop.abort(), 5_000);
  try {
    await observeBugHunter(
      paseo,
      { workspaceId: 'workspace', huntId: 'selected-hunt', agentId: 'allowed-agent' },
      stop.signal,
      async (snapshot) => {
        snapshots.push(snapshot);
        if (snapshots.length === 1) {
          entries.push({
            seqStart: 2,
            item: { type: 'assistant_message', text: 'Investi', messageId: 'assistant' },
          });
          updated?.();
          entries.push({
            seqStart: 3,
            item: { type: 'assistant_message', text: 'gating.', messageId: 'assistant' },
          });
          updated?.();
        } else if (snapshots.length === 2) {
          updated?.('error');
        } else if (snapshots.length === 3) {
          updated?.('replacement');
          archived = true;
        } else {
          stop.abort();
        }
      },
      async () =>
        !archived
          ? details
          : {
              ...details,
              hunts: details.hunts.map((hunt) => ({
                ...hunt,
                conversations: hunt.conversations.map((conversation) => ({
                  ...conversation,
                  archived: true,
                })),
              })),
            },
    );
    expect(snapshots.map(({ chat }) => chat?.messages.map(({ text }) => text))).toEqual([
      ['Check indexing.'],
      ['Check indexing.', 'Investigating.'],
      ['Check indexing.', 'Investigating.'],
      [],
    ]);
    expect(snapshots[2]?.chat?.unavailable).toBe(true);
    expect(snapshots[3]?.chat?.archived).toBe(true);
    expect(historyReads).toBe(1);
  } finally {
    clearTimeout(deadline);
  }
});

test('BugHunter does not reopen an archived native agent as a live observation', async () => {
  const stop = new AbortController();
  const opened: string[] = [];
  const paseo = {
    agents: {
      ref(id: string) {
        opened.push(id);
        throw new Error('Archived agents must stay closed.');
      },
    },
  } as unknown as PaseoApi;
  const history = {
    ...details,
    hunts: details.hunts.map((hunt) => ({
      ...hunt,
      conversations: hunt.conversations.map((conversation) => ({
        ...conversation,
        archived: true,
      })),
    })),
  };
  let snapshot: BugHunterSnapshot | undefined;
  await observeBugHunter(
    paseo,
    { workspaceId: 'workspace', huntId: 'selected-hunt', agentId: 'allowed-agent' },
    stop.signal,
    async (next) => {
      snapshot = next;
      stop.abort();
    },
    async () => history,
  );
  expect(opened).toEqual([]);
  expect(snapshot?.chat).toEqual({ agentId: 'allowed-agent', archived: true, messages: [] });
});

test('a rejected history request cannot suppress a replacement timeline', async () => {
  const stop = new AbortController();
  const snapshots: BugHunterSnapshot[] = [];
  let replace: (() => void) | undefined;
  let historyReads = 0;
  const paseo = {
    agents: {
      ref(id: string) {
        return {
          timeline: {
            subscribe(listener: (input: { event: { type: string; epoch: string } }) => void) {
              replace = () => listener({ event: { type: 'replacement', epoch: 'new' } });
              return { ready: Promise.resolve(), async release() {} };
            },
            async refetch() {
              historyReads++;
              if (historyReads === 1) {
                replace?.();
                throw new Error('Old generation failed.');
              }
              return {
                agentId: id,
                epoch: 'new',
                entries: [
                  { seqStart: 1, item: { type: 'assistant_message', text: 'New history' } },
                ],
              };
            },
          },
        };
      },
    },
  } as unknown as PaseoApi;
  const deadline = setTimeout(() => stop.abort(), 3_000);
  try {
    await observeBugHunter(
      paseo,
      { workspaceId: 'workspace', huntId: 'selected-hunt', agentId: 'allowed-agent' },
      stop.signal,
      async (snapshot) => {
        snapshots.push(snapshot);
        if (snapshots.length === 2) stop.abort();
      },
      async () => details,
    );
    expect(snapshots[0]?.chat).toMatchObject({ messages: [] });
    expect(snapshots[1]?.chat).toMatchObject({
      messages: [{ id: 'new:1', role: 'assistant', text: 'New history' }],
    });
    expect(historyReads).toBe(2);
  } finally {
    clearTimeout(deadline);
  }
});

test('the first live event can establish a newer timeline than the initial history page', async () => {
  const stop = new AbortController();
  const paseo = {
    agents: {
      ref(id: string) {
        let live: (() => void) | undefined;
        return {
          timeline: {
            subscribe(listener: (input: unknown) => void) {
              live = () =>
                listener({
                  epoch: 'new',
                  seq: 3,
                  event: {
                    type: 'timeline',
                    item: { type: 'assistant_message', text: 'Current reply.' },
                  },
                });
              return { ready: Promise.resolve(), async release() {} };
            },
            async refetch() {
              live?.();
              return {
                agentId: id,
                epoch: 'old',
                entries: [{ seqStart: 1, item: { type: 'assistant_message', text: 'Obsolete.' } }],
              };
            },
          },
        };
      },
    },
  } as unknown as PaseoApi;
  let snapshot: BugHunterSnapshot | undefined;
  await observeBugHunter(
    paseo,
    { workspaceId: 'workspace', huntId: 'selected-hunt', agentId: 'allowed-agent' },
    stop.signal,
    async (next) => {
      snapshot = next;
      stop.abort();
    },
    async () => details,
  );
  expect(snapshot?.chat?.messages).toEqual([
    { id: 'new:3', role: 'assistant', text: 'Current reply.' },
  ]);
});

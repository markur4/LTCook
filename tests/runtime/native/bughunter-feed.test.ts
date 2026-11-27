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

test('BugHunter appends native chat updates and retains messages after a timeline read fails', async () => {
  const stop = new AbortController();
  const snapshots: BugHunterSnapshot[] = [];
  const entries = [{ seqStart: 1, item: { type: 'user_message', text: 'Check indexing.' } }];
  let updated: (() => void) | undefined;
  let failTimeline = false;
  const paseo = {
    agents: {
      ref(id: string) {
        return {
          timeline: {
            subscribe(listener: (input: { event: { type: string; item: unknown } }) => void) {
              updated = () => listener({ event: { type: 'timeline', item: entries.at(-1)?.item } });
              return { ready: Promise.resolve(), async release() {} };
            },
            async refetch() {
              if (failTimeline) throw new Error('Timeline unavailable.');
              return { agentId: id, epoch: 'fixture', entries: [...entries] };
            },
          },
        };
      },
    },
  } as unknown as PaseoApi;
  const deadline = setTimeout(() => stop.abort(), 4_000);
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
            item: { type: 'assistant_message', text: 'Investigating.' },
          });
          updated?.();
        } else if (snapshots.length === 2) {
          failTimeline = true;
          updated?.();
        } else {
          stop.abort();
        }
      },
      async () => details,
    );
    expect(snapshots.map(({ chat }) => chat?.messages.map(({ text }) => text))).toEqual([
      ['Check indexing.'],
      ['Check indexing.', 'Investigating.'],
      ['Check indexing.', 'Investigating.'],
    ]);
    expect(snapshots.at(-1)?.chat?.unavailable).toBe(true);
  } finally {
    clearTimeout(deadline);
  }
});

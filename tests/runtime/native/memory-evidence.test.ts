import { expect, test } from 'bun:test';
import { readPaseoMemoryEvidence } from '../../../runtime/src/paseo-plugin/server/memory-source';

type Refetch = Parameters<typeof readPaseoMemoryEvidence>[0]['refetch'];
type Page = Awaited<ReturnType<Refetch>>;

function canonicalPage(epoch: string, entries: Page['entries'] = []): Page {
  // > The adapter consumes only the agent's availability, the epoch and the entries.
  return {
    epoch,
    agent: {},
    error: null,
    gap: false,
    reset: false,
    staleCursor: false,
    entries,
  } as Page;
}

function assistant(seq: number, messageId: string, text: string): Page['entries'][number] {
  return {
    provider: 'test',
    timestamp: '',
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
    collapsed: [],
    item: { type: 'assistant_message', messageId, text },
  };
}

test('opens only the exact canonical entries cited by an authorized execution record', async () => {
  const refetch: Refetch = async (options) => {
    if (options?.direction === 'tail') return canonicalPage('current');
    expect(options?.projection).toBe('canonical');
    expect(options?.limit).toBe(1);
    expect(options?.cursor?.epoch).toBe('current');
    const seq = options!.cursor!.seq - 1;
    return canonicalPage('current', [assistant(seq, 'native-id', 'Verbatim commentary.')]);
  };
  const entries = await readPaseoMemoryEvidence(
    { refetch },
    'current',
    [
      { seq: 18, messageId: 'native-id' },
      { seq: 21, messageId: 'other-source' },
    ],
    new AbortController().signal,
  );
  expect(entries).toEqual([
    { seq: 18, source: { kind: 'agent', text: 'Verbatim commentary.' } },
    { seq: 21, source: null },
  ]);
});

test('a replacement after fetching execution details invalidates the entire evidence page', async () => {
  const refetch: Refetch = async (options) =>
    options?.direction === 'tail'
      ? canonicalPage('replacement')
      : canonicalPage('current', [assistant(18, 'native-id', 'Old evidence')]);
  expect(
    await readPaseoMemoryEvidence(
      { refetch },
      'current',
      [{ seq: 18, messageId: 'native-id' }],
      new AbortController().signal,
    ),
  ).toEqual([{ seq: 18, source: null }]);
});

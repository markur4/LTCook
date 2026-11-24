import { createHmac, randomUUID } from 'node:crypto';
import type { PaseoApi } from '@getpaseo/client';
import type { MemoryCursor, MemorySource } from '../session-memory/service.js';
import type { MemoryMessage } from '../session-memory/extraction.js';

const runtimePrefix = 'ltcook-runtime-';

function dispatchMarker(secret: string, agentId: string, nonce: string): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify([agentId, nonce]))
    .digest('base64url');
}

export function memoryDispatchId(secret: string, agentId: string): string {
  const nonce = randomUUID();
  return `${runtimePrefix}${nonce}.${dispatchMarker(secret, agentId, nonce)}`;
}

function promptAuthor(
  id: string | undefined,
  agentId: string,
  secret?: string,
): MemoryMessage['author'] {
  if (!id) return 'unknown';
  if (!id.startsWith(runtimePrefix)) return 'user';
  const [nonce, marker] = id.slice(runtimePrefix.length).split('.');
  return secret && nonce && marker === dispatchMarker(secret, agentId, nonce)
    ? 'runtime'
    : 'unknown';
}

/** Use the host timeline so provider-specific stores remain owned by Paseo. */
export function createPaseoMemorySource(api: PaseoApi, secret?: string): MemorySource {
  return {
    async read(agentId: string, cursor?: MemoryCursor, direction = 'after') {
      const timeline = api.agents.ref(agentId).timeline;
      if (!cursor && direction === 'after') {
        const tail = await timeline.refetch({
          direction: 'tail',
          projection: 'canonical',
          limit: 1,
        });
        if (tail.error || !tail.agent) throw new Error('Session Memory history is unavailable.');
        if (!tail.entries.length)
          return { epoch: tail.epoch, latest: -1, through: -1, reset: false, messages: [] };
        cursor = { epoch: tail.epoch, seq: Math.max(0, tail.window.minSeq - 1) };
      }
      const page = await timeline.refetch({
        direction,
        projection: 'canonical',
        cursor,
        limit: direction === 'before' ? 4 : 48,
      });
      if (page.error || !page.agent) throw new Error('Session Memory history is unavailable.');
      return {
        epoch: page.epoch,
        latest: page.window.minSeq === 0 ? -1 : page.window.maxSeq,
        through: page.endCursor?.seq ?? cursor?.seq ?? -1,
        reset: page.reset || page.staleCursor || page.gap,
        messages: readMessages(agentId, secret, page.entries),
      };
    },
  };
}

type Timeline = Awaited<ReturnType<ReturnType<PaseoApi['agents']['ref']>['timeline']['refetch']>>;

function readMessages(
  agentId: string,
  secret: string | undefined,
  entries: Timeline['entries'],
): MemoryMessage[] {
  return entries
    .flatMap(({ seqEnd, item }): MemoryMessage[] => {
      switch (item.type) {
        case 'user_message':
          return [
            {
              seq: seqEnd,
              author: promptAuthor(item.clientMessageId, agentId, secret),
              text: item.text.slice(0, 12000),
            },
          ];
        case 'assistant_message':
          return [{ seq: seqEnd, author: 'agent', text: item.text.slice(0, 12000) }];
        case 'tool_call':
          return item.agentMessage?.event === 'message'
            ? [{ seq: seqEnd, author: 'agent', text: item.agentMessage.text.slice(0, 12000) }]
            : [];
        default:
          return [];
      }
    })
    .filter(({ text }) => text.trim().length > 0);
}

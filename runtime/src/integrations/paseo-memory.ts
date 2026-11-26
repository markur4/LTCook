import { createHmac, randomUUID } from 'node:crypto';
import type { PaseoApi } from '@getpaseo/client';
import {
  MemoryHistoryUnavailableError,
  type MemoryCursor,
  type MemorySource,
} from '../session-memory/conversation.js';
import type { MemorySourceMessage } from '../session-memory/units.js';
import type { PastedDocuments } from '../session-memory/pasted-documents.js';
import { readMemoryMessages } from '../paseo-plugin/server/memory-source.js';

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
): MemorySourceMessage['author'] {
  if (!id) return 'unknown';
  if (!id.startsWith(runtimePrefix)) return 'user';
  const [nonce, marker] = id.slice(runtimePrefix.length).split('.');
  return secret && nonce && marker === dispatchMarker(secret, agentId, nonce)
    ? 'runtime'
    : 'unknown';
}

/** Use the host timeline so provider-specific stores remain owned by Paseo. */
export function createPaseoMemorySource(
  api: PaseoApi,
  secret?: string,
  documents?: PastedDocuments,
): MemorySource {
  return {
    invalidateAttachments: documents
      ? (agentId, epoch, from) => documents.invalidate(agentId, epoch, from)
      : undefined,
    watch(agentId, notify) {
      const unsubscribe = api.agents.ref(agentId).timeline.subscribe(({ event }) => {
        if (
          event.type === 'replacement' ||
          event.type === 'subscription_restored' ||
          (event.type === 'timeline' &&
            (event.item.type === 'user_message' ||
              (event.item.type === 'tool_call' && event.item.status !== 'running')))
        )
          notify();
      });
      void unsubscribe.ready.catch(() => {});
      return unsubscribe;
    },
    async read(agentId: string, cursor?: MemoryCursor, direction = 'after') {
      const timeline = api.agents.ref(agentId).timeline;
      if (!cursor && direction === 'after') {
        const tail = await timeline.refetch({
          direction: 'tail',
          projection: 'canonical',
          limit: 1,
        });
        if (tail.error || !tail.agent) throw new MemoryHistoryUnavailableError();
        if (!tail.entries.length)
          return { epoch: tail.epoch, latest: -1, through: -1, reset: false, messages: [] };
        cursor = { epoch: tail.epoch, seq: Math.max(0, tail.window.minSeq - 1) };
      }
      const page = await timeline.refetch({
        direction,
        projection: 'canonical',
        cursor,
        limit: 48,
      });
      if (page.error || !page.agent) throw new MemoryHistoryUnavailableError();
      const messages = readMemoryMessages(
        page.entries,
        (id) => promptAuthor(id, agentId, secret),
        true,
      );
      if (documents) {
        for (const message of messages) {
          if (message.author !== 'user' && message.author !== 'unknown') continue;
          const projected = await documents.project(agentId, page.epoch, message.seq, message.text);
          if (projected.attachments.length) Object.assign(message, projected);
        }
      }
      return {
        epoch: page.epoch,
        latest: page.window.minSeq === 0 ? -1 : page.window.maxSeq,
        start: page.startCursor?.seq,
        earliest: page.window.minSeq,
        through: page.endCursor?.seq ?? cursor?.seq ?? -1,
        reset: page.reset || page.staleCursor || page.gap,
        messages,
      };
    },
  };
}

import { createHmac, randomUUID } from 'node:crypto';
import type { PaseoApi } from '@getpaseo/client';
import type { MemoryCursor, MemorySource } from '../session-memory/service.js';
import type { MemorySourceMessage } from '../session-memory/units.js';
import type { PastedDocuments } from '../session-memory/pasted-documents.js';

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
            event.item.type === 'tool_call' &&
            event.item.status !== 'running')
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
        if (tail.error || !tail.agent) throw new Error('Session Memory history is unavailable.');
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
      if (page.error || !page.agent) throw new Error('Session Memory history is unavailable.');
      const messages = readMessages(agentId, secret, page.entries);
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

type Timeline = Awaited<ReturnType<ReturnType<PaseoApi['agents']['ref']>['timeline']['refetch']>>;

function readMessages(
  agentId: string,
  secret: string | undefined,
  entries: Timeline['entries'],
): MemorySourceMessage[] {
  return entries
    .flatMap(({ seqEnd, turnId, timestamp, item }): MemorySourceMessage[] => {
      const origin = { seq: seqEnd, turnId, timestamp };
      switch (item.type) {
        case 'user_message':
          return [
            {
              ...origin,
              messageId: item.messageId ?? item.clientMessageId,
              author: promptAuthor(item.clientMessageId, agentId, secret),
              text: item.text,
            },
          ];
        case 'assistant_message':
          return [{ ...origin, messageId: item.messageId, author: 'agent', text: item.text }];
        case 'tool_call': {
          if (item.status === 'running') return [];
          if (item.agentMessage?.event === 'message')
            return [
              { ...origin, intermediate: true, author: 'agent', text: item.agentMessage.text },
            ];
          const result = toolOutcome(item);
          return result
            ? [{ ...origin, messageId: item.callId, author: 'tool', text: result }]
            : [];
        }
        default:
          return [];
      }
    })
    .filter(({ text }) => text.trim().length > 0);
}

/** Preserve typed tool results and verification lines while omitting commands and arbitrary logs. */
function toolOutcome(
  item: Extract<Timeline['entries'][number]['item'], { type: 'tool_call' }>,
): string | undefined {
  if (item.status === 'running') return undefined;
  const { detail, status } = item;
  switch (detail.type) {
    case 'shell':
      return [
        typeof detail.exitCode === 'number'
          ? `Shell command ${status} with exit code ${detail.exitCode}.`
          : `Shell command ${status}.`,
        ...verificationLines(detail.output),
      ].join('\n');
    case 'edit':
    case 'write':
    case 'read':
      return `File ${detail.type} ${status} for ${JSON.stringify(detail.filePath)}.`;
    case 'search':
      return detail.toolName !== 'web_search' && typeof detail.numMatches === 'number'
        ? [
            `Workspace search ${status} with ${detail.numMatches} matches.`,
            ...(detail.filePaths ?? []),
          ].join('\n')
        : undefined;
    default:
      return undefined;
  }
}

function verificationLines(output?: string): string[] {
  if (!output) return [];
  return output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .filter((line) => {
      const result =
        /^\s*(?:\((?:pass|fail|skip)\)|[✓✗]|\d+\s+(?:passed|failed|skipped)|[A-Z][A-Z0-9_.-]*\s+(?:PASS|FAIL)\b|(?:prefill|generation|benchmark)\b.*\d)/i;
      return (
        result.test(line) &&
        !/\b(?:secret|password|credential|authorization|api[_ -]?key)\b/i.test(line)
      );
    });
}

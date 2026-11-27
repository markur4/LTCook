import { setTimeout as delay } from 'node:timers/promises';
import type { PaseoAgentHandle, PaseoApi } from '@getpaseo/client';
import type { z } from 'zod';
import type { bugHunterDetailsSchema, bugHunterSubscription } from '../shared/bughunter';
import { redactDiagnosticText } from '../shared/diagnostic-redaction';

type Details = z.infer<typeof bugHunterDetailsSchema>;
type Snapshot = z.infer<typeof bugHunterSubscription.event>;
type Chat = NonNullable<Snapshot['chat']>;
type Timeline = PaseoAgentHandle['timeline'];
type TimelinePage = Awaited<ReturnType<Timeline['refetch']>>;

const refreshMs = 1_000;
const tailLimit = 60;
const pageLimit = 3;
const messageLimit = 24;
const textLimit = 4_000;

function chatMessages(page: TimelinePage): Chat['messages'] {
  return page.entries.flatMap(({ item, seqStart }) => {
    if (item.type !== 'user_message' && item.type !== 'assistant_message') return [];
    const clean = redactDiagnosticText(item.text, process.env).trim();
    if (!clean) return [];
    const text = clean.length > textLimit ? `${clean.slice(0, textLimit - 1)}…` : clean;
    const role = item.type === 'user_message' ? 'user' : 'assistant';
    return [{ id: `${page.epoch}:${seqStart}`, role, text }];
  });
}

function observeConversation(agentId: string, timeline: Timeline, signal: AbortSignal) {
  let revision = 0;
  let replacements = 0;
  let deliveredRevision = -1;
  let refreshWithoutEvents = false;
  let released = false;
  let chat: Chat = { agentId, messages: [] };
  const observation = timeline.subscribe(({ event }) => {
    if (event.type === 'replacement' || event.type === 'subscription_restored') {
      replacements++;
      chat = { agentId, messages: [] };
    } else if (event.type === 'error') {
      refreshWithoutEvents = true;
    }
    if (
      event.type === 'replacement' ||
      event.type === 'subscription_restored' ||
      event.type === 'error' ||
      (event.type === 'timeline' &&
        (event.item.type === 'user_message' || event.item.type === 'assistant_message'))
    )
      revision++;
  });
  void observation.ready.then(
    () => {
      revision++;
    },
    () => {
      refreshWithoutEvents = true;
    },
  );
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', release);
    void observation.release().catch(() => {});
  };
  signal.addEventListener('abort', release, { once: true });
  return {
    release,
    messages: () => chat.messages,
    async read(): Promise<Chat> {
      if (revision === deliveredRevision && !refreshWithoutEvents && !chat.unavailable) return chat;
      const capturedRevision = revision;
      const capturedReplacements = replacements;
      try {
        const tail = await timeline.refetch({
          direction: 'tail',
          projection: 'canonical',
          limit: tailLimit,
        });
        if (tail.error || tail.agentId !== agentId)
          throw new Error('BugHunter conversation is unavailable.');
        let messages = chatMessages(tail);
        let page = tail;
        for (
          let pages = 1;
          pages < pageLimit && messages.length < messageLimit && !signal.aborted;
          pages++
        ) {
          if (!page.hasOlder || !page.startCursor) break;
          const older = await timeline
            .refetch({
              direction: 'before',
              cursor: page.startCursor,
              projection: 'canonical',
              limit: tailLimit,
            })
            .catch(() => undefined);
          if (
            !older ||
            older.error ||
            older.agentId !== agentId ||
            older.epoch !== tail.epoch ||
            older.reset ||
            older.staleCursor ||
            !older.entries.length
          )
            break;
          messages = [...chatMessages(older), ...messages];
          page = older;
        }
        if (capturedReplacements !== replacements || signal.aborted) return chat;
        const distinct = new Map(messages.map((message) => [message.id, message]));
        chat = { agentId, messages: [...distinct.values()].slice(-messageLimit) };
        // > A newer live event may have arrived while the tail request was in flight.
        deliveredRevision = capturedRevision;
      } catch {
        chat = { ...chat, unavailable: true };
      }
      return chat;
    },
  };
}

export async function observeBugHunter(
  paseo: PaseoApi,
  input: z.infer<typeof bugHunterSubscription.input>,
  signal: AbortSignal,
  push: (snapshot: Snapshot) => Promise<void>,
  readDetails: () => Promise<Details>,
): Promise<void> {
  let observation: ReturnType<typeof observeConversation> | undefined;
  let previous: string | undefined;
  let archivedMessages: Chat['messages'] = [];
  try {
    while (!signal.aborted) {
      const details = await readDetails().catch(() => ({ available: false, hunts: [] }));
      if (signal.aborted) return;
      const hunt = details.available && details.hunts.find(({ id }) => id === input.huntId);
      const conversation = hunt && hunt.conversations.find(({ id }) => id === input.agentId);
      if (!conversation || conversation.archived) {
        if (!conversation) archivedMessages = [];
        else if (observation) archivedMessages = observation.messages();
        observation?.release();
        observation = undefined;
      } else if (!observation) {
        archivedMessages = [];
        const { id } = conversation;
        observation = observeConversation(id, paseo.agents.ref(id).timeline, signal);
      }
      const chat =
        conversation &&
        (conversation.archived
          ? { agentId: conversation.id, archived: true, messages: archivedMessages }
          : await observation?.read());
      if (signal.aborted) return;
      const snapshot = chat ? { ...details, chat } : details;
      const serialized = JSON.stringify(snapshot);
      if (serialized !== previous) {
        previous = serialized;
        await push(snapshot);
      }
      await delay(refreshMs, undefined, { signal }).catch(() => {});
    }
  } finally {
    observation?.release();
  }
}

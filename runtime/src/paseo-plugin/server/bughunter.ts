import { setTimeout as delay } from 'node:timers/promises';
import type { PaseoAgentHandle, PaseoApi } from '@getpaseo/client';
import type { z } from 'zod';
import type { bugHunterDetailsSchema, bugHunterSubscription } from '../shared/bughunter';
import { redactDiagnosticText } from '../shared/diagnostic-redaction';

type Details = z.infer<typeof bugHunterDetailsSchema>;
type Snapshot = z.infer<typeof bugHunterSubscription.event>;
type Chat = NonNullable<Snapshot['chat']>;
type Timeline = PaseoAgentHandle['timeline'];

const refreshMs = 1_000;
const tailLimit = 60;
const messageLimit = 24;
const textLimit = 4_000;

type MessagePart = {
  sequence: number;
  role: 'user' | 'assistant';
  messageId?: string;
  text: string;
};

type MessageItem = {
  type: 'user_message' | 'assistant_message';
  text: string;
  messageId?: string;
};

function messagePart(item: MessageItem, sequence: number): MessagePart {
  return {
    sequence,
    role: item.type === 'user_message' ? 'user' : 'assistant',
    messageId: item.messageId,
    text: item.text,
  };
}

function observeConversation(agentId: string, timeline: Timeline, signal: AbortSignal) {
  let epoch: string | undefined;
  let generation = 0;
  let seeded = false;
  let unavailable = false;
  let through = -1;
  let released = false;
  const messages = new Map<string, MessagePart>();
  let waiting: MessagePart[] = [];

  const reset = (next?: string) => {
    epoch = next;
    generation++;
    seeded = false;
    unavailable = false;
    through = -1;
    messages.clear();
    waiting = [];
  };
  const append = (part: MessagePart) => {
    if (part.sequence <= through) return;
    through = part.sequence;
    const key = part.messageId ? `${part.role}:${part.messageId}` : String(part.sequence);
    const previous = messages.get(key);
    messages.set(key, {
      ...part,
      sequence: previous?.sequence ?? part.sequence,
      text: ((previous?.text ?? '') + part.text).slice(0, textLimit * 2),
    });
    if (messages.size > messageLimit) messages.delete(messages.keys().next().value!);
  };
  const renderMessages = (): Chat['messages'] =>
    [...messages.values()].flatMap(({ sequence, role, text }) => {
      const clean = redactDiagnosticText(text, process.env).trim();
      if (!clean) return [];
      return [
        {
          id: `${epoch}:${sequence}`,
          role,
          text: clean.length > textLimit ? `${clean.slice(0, textLimit - 1)}…` : clean,
        },
      ];
    });

  const observation = timeline.subscribe((update) => {
    const { event } = update;
    if (event.type === 'replacement') reset(event.epoch);
    if (event.type === 'subscription_restored') reset();
    if (event.type === 'error') {
      unavailable = true;
      seeded = true;
    }
    if (
      event.type !== 'timeline' ||
      !('epoch' in update) ||
      !update.epoch ||
      !('seq' in update) ||
      typeof update.seq !== 'number' ||
      (event.item.type !== 'user_message' && event.item.type !== 'assistant_message')
    )
      return;
    if (epoch && update.epoch !== epoch) reset(update.epoch);
    epoch = update.epoch;
    const part = messagePart(event.item, update.seq);
    if (seeded) append(part);
    else waiting = [...waiting.slice(-(tailLimit - 1)), part];
  });
  void observation.ready.catch(() => {
    unavailable = true;
  });
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', release);
    void observation.release().catch(() => {});
  };
  signal.addEventListener('abort', release, { once: true });
  return {
    release,
    messages: renderMessages,
    async read(): Promise<Chat> {
      if (!seeded) {
        const observedGeneration = generation;
        try {
          await observation.ready;
          if (signal.aborted || released) return { agentId, messages: [] };
          const tail = await timeline.refetch({
            direction: 'tail',
            projection: 'canonical',
            limit: tailLimit,
          });
          if (signal.aborted || released || generation !== observedGeneration)
            return { agentId, messages: renderMessages() };
          if (tail.error || tail.agentId !== agentId) throw new Error('Timeline unavailable.');
          if (epoch !== undefined && tail.epoch !== epoch) {
            reset(tail.epoch);
            return { agentId, messages: [] };
          }
          epoch = tail.epoch;
          for (const { item, seqStart } of tail.entries) {
            if (item.type === 'user_message' || item.type === 'assistant_message')
              append(messagePart(item, seqStart));
          }
          through = Math.max(through, tail.endCursor?.seq ?? -1);
        } catch {
          // > A failed history load must not cause additional native reads while
          // > a session is closing. Live events can still arrive on this subscription.
          unavailable = true;
        }
        seeded = true;
        for (const part of waiting) append(part);
        waiting = [];
      }
      return { agentId, ...(unavailable ? { unavailable: true } : {}), messages: renderMessages() };
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

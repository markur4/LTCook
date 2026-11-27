import { resolveModel } from '../runtime/src/models/aliases.js';
import type { MemorySource } from '../runtime/src/session-memory/conversation.js';
import { hostedConversationProvider } from '../runtime/src/session-memory/hosted.js';
import { ConversationInference } from '../runtime/src/session-memory/inference.js';
import { openConversationProductStore } from '../runtime/src/session-memory/product-store.js';
import { TrackerService } from '../runtime/src/session-memory/tracker.js';
import type { MemorySourceMessage } from '../runtime/src/session-memory/units.js';

const agentId = 'fixture-conversation';
const epoch = 'fixture-epoch';
const messages: MemorySourceMessage[] = [];
const source: MemorySource = {
  async read(_agentId, cursor, direction) {
    const latest = messages.at(-1)?.seq ?? -1;
    const entries =
      direction === 'before'
        ? messages.filter(({ seq }) => seq < (cursor?.seq ?? 0))
        : direction === 'after' || cursor
          ? messages.filter(({ seq }) => seq > (cursor?.seq ?? -1))
          : messages;
    return {
      epoch,
      latest,
      through: entries.at(-1)?.seq ?? cursor?.seq ?? -1,
      start: entries[0]?.seq,
      earliest: messages[0]?.seq,
      reset: Boolean(cursor && cursor.epoch !== epoch),
      messages: entries,
    };
  },
};

function requireCheck(pass: unknown, explanation: string): asserts pass {
  if (!pass) throw new Error(explanation);
}

async function evaluate() {
  const model = resolveModel('tiny', process.env);
  requireCheck(
    model.provider === 'openai-codex' && model.model === 'gpt-6-luna' && model.reasoning === 'low',
    'The agreed Agent Eval requires @tiny to resolve to Hosted GPT-6 Luna with low reasoning.',
  );
  const database = openConversationProductStore(':memory:');
  const inference = new ConversationInference(
    { hosted: hostedConversationProvider(model) },
    'hosted',
  );
  const tracker = new TrackerService(database, source, inference, 8000);
  const started = performance.now();

  function append(author: 'user' | 'agent', text: string) {
    const seq = messages.length + 1;
    messages.push({ seq, author, text, messageId: `message-${seq}` });
    return seq;
  }

  async function track(text: string) {
    const seq = append('user', text);
    tracker.observe(agentId);
    await tracker.settled(agentId);
    const view = await tracker.snapshot(agentId);
    const result = view.events.find(({ source }) => source.seq === seq)?.trackers[0]?.status;
    requireCheck(
      result === 'no-change' || result === 'changes',
      `Tracker #${seq} status: ${result}`,
    );
    const items = view.trackers[0]!.items;
    requireCheck(
      items.every(({ text }) => !/^\s*(?:[-*+]|\d+[.)])\s/m.test(text)),
      'Stored a Markdown list marker in a Tracked Item.',
    );
    return items;
  }

  try {
    const initial = await track(
      'We will keep the public cursor opaque so the storage format can change. Also, keep maintenance mode enabled until the queue drains.',
    );
    const cursor = initial.find(({ text }) => /opaque/i.test(text));
    const maintenance = initial.find(({ text }) => /maintenance mode/i.test(text));
    requireCheck(
      initial.length === 2 && cursor && maintenance && cursor.id !== maintenance.id,
      'Did not store the two independent decisions in separate Tracked Items.',
    );
    requireCheck(
      /storage format/i.test(cursor.text) &&
        /queue/i.test(maintenance.text) &&
        /drain/i.test(maintenance.text),
      'Omitted the cursor rationale or the condition for maintenance mode.',
    );
    append('agent', 'Proposal: use a 20-second retry interval for the worker queue.');
    const ambiguous = await track('Interesting. Is the deployment already live?');
    requireCheck(
      !ambiguous.some(({ text }) => /20.second/i.test(text)),
      'Recorded a tentative retry proposal as accepted.',
    );
    const proposal = append(
      'agent',
      'I propose using a 20-second retry interval for the worker queue.',
    );
    const accepted = await track('Yes, implement that.');
    const retry = accepted.find(({ text }) => /20.second/i.test(text));
    requireCheck(
      retry &&
        retry.sources.some(({ seq }) => seq === proposal) &&
        retry.sources.some(({ seq }) => seq === proposal + 1),
      'Missed the explicit approval or its proposal citation.',
    );
    const amended = await track(
      'Change that retry interval to 35 seconds. Keep the opaque public cursor.',
    );
    requireCheck(
      amended.some(({ id, text }) => id === retry.id && /35.second/i.test(text)) &&
        amended.some(({ text }) => /opaque/i.test(text)) &&
        !amended.some(({ text }) => /20.second/i.test(text)),
      'Incorrectly updated or retired a design decision.',
    );
    console.log(`Tracker passed in ${Math.round(performance.now() - started)} ms.`);
  } finally {
    await tracker.close();
    await inference.close();
    database.close();
  }
}

await evaluate();

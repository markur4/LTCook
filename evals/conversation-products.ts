import { resolveModel } from '../runtime/src/models/aliases.js';
import { ClarifyService } from '../runtime/src/session-memory/clarify.js';
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
  const clarify = new ClarifyService(database, source, inference, 8000);
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
    return view.trackers[0]!.items;
  }

  try {
    const initial = await track(
      'We will keep the public cursor opaque so the storage format can change.',
    );
    requireCheck(
      initial.some(({ text }) => /opaque/i.test(text)),
      'Missed the initial explicit design decision.',
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
    requireCheck(
      accepted.some(
        ({ text, sources }) =>
          /20.second/i.test(text) &&
          sources.some(({ seq }) => seq === proposal) &&
          sources.some(({ seq }) => seq === proposal + 1),
      ),
      'Missed the explicit approval or its proposal citation.',
    );
    const amended = await track(
      'Change that retry interval to 35 seconds. Keep the opaque public cursor.',
    );
    requireCheck(
      amended.some(({ text }) => /35.second/i.test(text)) &&
        amended.some(({ text }) => /opaque/i.test(text)) &&
        !amended.some(({ text }) => /20.second/i.test(text)),
      'Incorrectly updated or retired a design decision.',
    );
    console.log(`Tracker passed in ${Math.round(performance.now() - started)} ms.`);

    const clarifyStarted = performance.now();
    const reply = append(
      'agent',
      'We cap retries at 3 because the upstream has a tight quota; assuming it stays up, ' +
        'the recovery path should finish within 35 seconds. I have not run the integration tests. ' +
        'The unit tests passed. Redis connections are unchanged.',
    );
    append('agent', 'Later update: the integration tests passed and recovery took 22 seconds.');
    const text = await clarify.generate(agentId, {
      epoch,
      seq: reply,
      messageId: `message-${reply}`,
    });
    requireCheck(
      /\b(?:3|three)\b/i.test(text) &&
        /35\s*seconds/i.test(text) &&
        /quota/i.test(text) &&
        /(?:if|assuming|provided)/i.test(text) &&
        /(?:should|expect|estimate|predict)/i.test(text) &&
        /unit tests?.{0,60}pass/is.test(text) &&
        /(?:integration tests?.{0,60}(?:not|haven't|weren't)|(?:not|haven't|weren't).{0,60}integration tests?)/is.test(
          text,
        ) &&
        /Redis/i.test(text) &&
        !/22\s*seconds/i.test(text),
      'Clarify lost a claim, caveat, or outcome, or incorporated a later claim.',
    );
    console.log(`Clarify passed in ${Math.round(performance.now() - clarifyStarted)} ms.`);
    console.log(text);
    console.log(`Combined Agent Evals passed in ${Math.round(performance.now() - started)} ms.`);
  } finally {
    await tracker.close();
    await inference.close();
    database.close();
  }
}

await evaluate();

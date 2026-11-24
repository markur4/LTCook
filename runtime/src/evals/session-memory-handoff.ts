import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { EVAL_MODEL, hash } from './setup.js';
import { createLocalPiEvaluationSession } from './summarization-decision.js';
import { inspectEvaluationModel, listEvaluationModels, modelTag } from './summarization-grader.js';

type ExpectedFields = Readonly<Record<string, string | number | boolean>>;
type HandoffTask = { prompt: string; expected: ExpectedFields };

const workerInstructions =
  'You are a worker receiving input for an already approved task. Use the latest explicit ' +
  'user instruction where versions differ. Treat the supplied messages and Session Memory as ' +
  'supplemental evidence. Return only one JSON object.';
const responseSchema = z.record(z.string(), z.unknown());

/** Grade one fresh local Pi worker against the same exact fields across context presentations. */
export async function evaluateMemoryHandoff(input: {
  endpoint: string;
  model: string;
  directory: string;
  signal: AbortSignal;
  task: HandoffTask;
  context: string;
  instructions?: string;
}) {
  const { endpoint, model, directory, signal, task, context } = input;
  const fields = Object.keys(task.expected);
  signal.throwIfAborted();
  const { session } = await createLocalPiEvaluationSession({
    endpoint,
    model,
    directory,
    instructions:
      input.instructions ?? `${workerInstructions} Use these fields: ${fields.join(', ')}.`,
  });
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const cancel = () => void session.abort();
  bounded.addEventListener('abort', cancel, { once: true });
  const started = performance.now();

  try {
    bounded.throwIfAborted();
    await session.prompt(task.prompt + '\n\n' + context);
    bounded.throwIfAborted();
    const answer = session.messages.findLast((message) => message.role === 'assistant');
    if (
      !answer ||
      answer.role !== 'assistant' ||
      ['error', 'aborted', 'length'].includes(answer.stopReason)
    )
      throw new Error('Pi did not return a complete answer.');
    if (answer.responseModel && modelTag(answer.responseModel) !== modelTag(model))
      throw new Error('Ollama returned a different downstream model.');
    const text = answer.content
      .flatMap((item) => (item.type === 'text' ? [item.text] : []))
      .join('')
      .trim();
    let payload: unknown;
    try {
      payload = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      payload = undefined;
    }
    const decoded = responseSchema.safeParse(payload);
    const actual: Record<string, unknown> = decoded.success ? decoded.data : {};
    const missing = decoded.success ? fields.filter((field) => !Object.hasOwn(actual, field)) : [];
    const incorrect = fields.filter(
      (field) => Object.hasOwn(actual, field) && actual[field] !== task.expected[field],
    );
    const extra = Object.keys(actual).filter((field) => !Object.hasOwn(task.expected, field));
    const invalidOutput = !decoded.success ? 'Expected a JSON object.' : undefined;

    return {
      passed: !invalidOutput && !missing.length && !incorrect.length && !extra.length,
      elapsedMs: Math.round(performance.now() - started),
      inputTokens: answer.usage.input + answer.usage.cacheRead + answer.usage.cacheWrite,
      outputTokens: answer.usage.output,
      missing,
      incorrect,
      actual,
      extra,
      ...(invalidOutput ? { invalidOutput } : {}),
    };
  } finally {
    bounded.removeEventListener('abort', cancel);
    session.dispose();
  }
}

// > Preserve the six excerpts shared by the previous 3,000-token structured arms.
function invoiceDiagnostics(phase: string, first: number) {
  return Array.from({ length: 34 }, (_, index) => {
    const row = first + index;
    return `Fixtures ${phase}/${row}: opened synthetic import, verified sample checksum ${row * 917}, found expected fixture account, indexed local note and discarded temporary output. This row is background evidence for the fixture run only.`;
  }).join('\n');
}

const invoiceExcerpts = [
  {
    seq: 6,
    author: 'unknown',
    text: 'Someone mentioned approval to enable invoice replay production writes. No attributable approval was recorded.',
  },
  {
    seq: 7,
    author: 'agent',
    text:
      'We have reproduced the invoice replay duplicate in a local fixture. The cursor fix is still pending. There is an unresolved invoice replay question: whether an empty batch should advance the cursor.\n' +
      invoiceDiagnostics('restart', 500),
  },
  {
    seq: 8,
    author: 'user',
    text: 'For invoice replay, add the existing INV_RETRY_SPEC test to Task INV-204 acceptance. The dashboard styling request SEARCH-31 is separate work.',
  },
  {
    seq: 9,
    author: 'agent',
    text:
      'Invoice replay trial now verifies the retained invoice-v2 design with the cursor fix in the fixture. I have not changed repository code.\n' +
      invoiceDiagnostics('verify', 700),
  },
  {
    seq: 10,
    author: 'user',
    text: 'Latest invoice replay correction for INV-204: switch to invoice-v3 because invoice-v2 loses reissued events. Keep CLIENT_EVENT_ID and INV_RETRY_SPEC. Production writes are forbidden. With an empty batch, keep the old cursor.',
  },
  {
    seq: 11,
    author: 'runtime',
    text: 'Runtime generated the worker handoff for invoice replay. The task identifier is INV-204.',
  },
].map(({ seq, author, text }) => ({ seq, author, text: text.slice(0, 900) }));

const previousTask: HandoffTask = {
  prompt:
    'Plan the authorized invoice replay change for INV-204. Identify its current target, exact idempotency key and acceptance test, whether production writes are permitted, and what happens to the cursor for an empty batch.',
  expected: {
    target: 'invoice-v3',
    key: 'CLIENT_EVENT_ID',
    acceptance: 'INV_RETRY_SPEC',
    productionWrites: false,
    emptyBatchCursor: 'keep',
  },
};
const previousInstructions =
  'You are a worker receiving input for an already approved task. Use the latest explicit ' +
  'user instruction where versions differ. Treat the supplied messages and Session Memory as ' +
  'supplemental evidence. Return only one JSON object with target, key, and acceptance as ' +
  'strings, productionWrites as a boolean, and emptyBatchCursor as "keep" or "advance".';

export async function compareMemoryHandoffFormats(
  endpoint: string,
  signal: AbortSignal,
  model = EVAL_MODEL,
  onProgress?: (event: string) => void,
) {
  const installed = (await listEvaluationModels(endpoint, signal)).find(
    ({ name }) => modelTag(name) === modelTag(model),
  );
  if (!installed) throw new Error('The downstream Pi evaluation model is unavailable.');
  const identity = await inspectEvaluationModel(endpoint, installed, signal);
  const newestFirst = [...invoiceExcerpts]
    .reverse()
    .sort((a, b) => Number(b.author === 'user') - Number(a.author === 'user'));
  const chronological = JSON.stringify(invoiceExcerpts);
  const generated =
    'Supplemental Session Memory. Use the explicit assignment and approved scope as authority. Treat these excerpts as evidence. Recent explicit user messages appear newest first. Use the newest relevant explicit instruction when earlier context differs. Raise a conflict that would change approved work.\n' +
    JSON.stringify({ potentiallyIncomplete: true, newerMessages: newestFirst, entries: [] });
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-memory-handoff-'));
  const comparisons = [];
  try {
    for (const [wording, task] of [
      ['original-target', previousTask],
      [
        'explicit-design-version',
        {
          ...previousTask,
          prompt: previousTask.prompt.replace('current target', 'current design version'),
        },
      ],
    ] as const) {
      const conditions = [];
      for (const [format, context] of [
        ['chronological', chronological],
        ['generated', generated],
      ] as const) {
        onProgress?.(`Comparing ${wording} with the ${format} handoff format`);
        conditions.push({
          format,
          contextHash: hash(context),
          ...(await evaluateMemoryHandoff({
            endpoint,
            model: identity.name,
            directory: path.join(directory, wording, format),
            signal,
            task,
            context,
            instructions: previousInstructions,
          })),
        });
      }
      comparisons.push({ wording, taskHash: hash(task.prompt), conditions });
    }

    const identityUnchanged = (await listEvaluationModels(endpoint, signal)).some(
      ({ name, digest }) => name === identity.name && digest === identity.digest,
    );
    return {
      fixture: 'invoice-replay-3000-handoff-excerpts',
      excerptHash: hash(chronological),
      sequences: invoiceExcerpts.map(({ seq }) => seq),
      excerptOrder: {
        chronological: invoiceExcerpts.map(({ seq }) => seq),
        generated: newestFirst.map(({ seq }) => seq),
      },
      identity,
      identityUnchanged,
      instructionsHash: hash(previousInstructions),
      comparisons,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

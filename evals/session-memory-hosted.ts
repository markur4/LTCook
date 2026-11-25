import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { MemoryFixture } from '../runtime/src/evals/session-memory-fixtures.js';
import { LUNA_EVALUATION } from '../runtime/src/evals/setup.js';
import { prepareLunaPiEvaluation } from '../runtime/src/evals/summarization-decision.js';
import { modelTag } from '../runtime/src/evals/summarization-grader.js';
import { resolveModel } from '../runtime/src/models/aliases.js';
import { createHostedMemorySummarizer } from '../runtime/src/session-memory/hosted.js';
import type { SessionMemory } from '../runtime/src/session-memory/service.js';
import { asymmetricFixtures } from './session-memory-asymmetric-fixtures.js';
import { localMemoryFacts } from './session-memory-local.js';
import { matchesLocalDecision } from './session-memory-local-delegation.js';
import { candidateScreeningFixtures } from './session-memory-screening.js';
import {
  gradeSimplifiedLayer,
  realisticReferenceFixture,
  runHostedMemoryArm,
} from './session-memory-simplified.js';

const hostedModel = 'openai-codex/gpt-6-luna';
const minimumReplyReduction = 0.3;
const archivedArms = ['local-bullets', 'agent-reply-only'] as const;
const archivedReport = z.object({
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  rows: z.array(
    z.object({
      fixture: z.string(),
      arm: z.enum(archivedArms),
      provider: z.literal('openai-codex'),
      model: z.literal(LUNA_EVALUATION.model),
      level: z.literal('off'),
      requested: z.literal('off'),
      stopReason: z.string(),
      complete: z.boolean(),
      usage: z.object({ reasoning: z.literal(0) }).passthrough(),
      elapsedMs: z.number().nonnegative(),
      exactSystem: z.boolean(),
      exactUser: z.boolean(),
      text: z.string(),
    }),
  ),
});

/** Regrade the private asymmetric probe without sending a model request. */
export function regradeHostedAsymmetric(report: unknown) {
  const { revision, rows } = archivedReport.parse(report);
  const fixtures = asymmetricFixtures.map((fixture) => {
    const originals = [
      { seq: 1, author: 'user', text: fixture.user },
      { seq: 2, author: 'agent', text: fixture.reply },
    ] as const;
    const facts = fixture.facts.map((fact) => ({ ...fact, source: 2, critical: true }));
    const originalReplyBytes = Buffer.byteLength(fixture.reply);
    const userBytes = Buffer.byteLength(fixture.user);
    const arms = archivedArms.map((arm) => {
      const matching = rows.filter((entry) => entry.fixture === fixture.id && entry.arm === arm);
      const [row] = matching;
      if (!row || matching.length !== 1)
        throw new Error(`Expected one archived row for ${fixture.id}, ${arm}.`);
      const { text, usage, elapsedMs, exactUser, exactSystem } = row;
      const complete = row.complete && row.stopReason === 'stop';
      const bytes = Buffer.byteLength(text);
      const replyReduction = 1 - bytes / originalReplyBytes;
      const quality = gradeSimplifiedLayer(
        facts,
        complete ? [{ seq: 2, sources: [1, 2], text }] : [],
        originals,
      );
      return {
        arm,
        complete,
        exactUser,
        exactSystem,
        usage,
        elapsedMs,
        outputBytes: bytes,
        combinedBytes: userBytes + bytes,
        replyReduction,
        quality,
        passed: complete && exactUser && quality.passed && replyReduction >= minimumReplyReduction,
      };
    });
    return { fixture: fixture.id, originalReplyBytes, userBytes, arms };
  });
  if (rows.length !== fixtures.length * archivedArms.length)
    throw new Error('The saved asymmetric report contains unexpected fixture rows.');
  return {
    revision,
    provider: 'openai-codex',
    model: LUNA_EVALUATION.model,
    reasoning: 'none',
    minimumReplyReduction,
    fixtures,
    passed: fixtures.every(({ arms }) =>
      arms.some(({ arm, passed }) => arm === 'agent-reply-only' && passed),
    ),
  };
}

type Handoff = Awaited<ReturnType<SessionMemory['handoffDetails']>>;

function gradeHostedHandoff(fixture: MemoryFixture, handoff: Handoff, skipped: number[]) {
  const originals = fixture.turns.flat();
  const generated = handoff.entries.filter(
    ({ author, kind }) => author === 'summary' && kind === 'UAMP',
  );
  const facts = gradeSimplifiedLayer(fixture.facts, generated, originals);
  const skippedOriginals = skipped.map((seq) => {
    const original = originals.find((message) => message.seq === seq);
    const index = handoff.entries.findIndex(
      (entry) =>
        original !== undefined &&
        entry.seq === seq &&
        entry.author === original.author &&
        entry.text === original.text &&
        !entry.truncated,
    );
    return { seq, index, exact: index >= 0 };
  });
  const historical = handoff.selection?.evidence ?? [];
  const ordered = historical.every(
    ({ seq }, index) => index === 0 || historical[index - 1]!.seq <= seq,
  );
  const generatedSources = generated.map(({ sources, seq }) => sources ?? [seq]);
  const proposal = handoff.entries.findLastIndex(
    (entry) => generated.includes(entry) && entry.sources?.includes(1),
  );
  const approvalSource = (skipped.at(-1) ?? 0) + 1;
  const approval = handoff.entries.findIndex(
    (entry) => generated.includes(entry) && entry.sources?.includes(approvalSource),
  );
  const skippedInOrder = skippedOriginals.every(
    ({ index }, position) =>
      index > (skippedOriginals[position - 1]?.index ?? proposal) && index < approval,
  );
  const chronological =
    ordered && (!skipped.length || (proposal >= 0 && approval > proposal && skippedInOrder));
  const latest = originals.at(-1);
  const decision = handoff.selection?.decision;
  const latestOriginal =
    latest !== undefined &&
    decision?.author === 'user' &&
    decision.seq === latest.seq &&
    decision.text === latest.text &&
    !decision.truncated;
  return {
    generatedSources,
    facts,
    skippedOriginals,
    chronological,
    latestOriginal,
    originalHistory: handoff.selection?.originalHistory,
    contextIncomplete: handoff.selection?.contextIncomplete,
    passed:
      facts.passed &&
      chronological &&
      latestOriginal &&
      handoff.selection?.originalHistory === 'available' &&
      handoff.recoveredSources.length === 0,
  };
}

async function receiveSnapshotTask(
  handoff: string,
  fixture: MemoryFixture,
  signal: AbortSignal,
  auditOutput: boolean,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-hosted-memory-receiver-'));
  const expected = {
    ...fixture.task.expected,
    originalProposal: 1,
    userApproval: 7,
    automaticRebuild: false,
    workCompleted: false,
  };
  try {
    const openSession = await prepareLunaPiEvaluation(
      directory,
      signal,
      LUNA_EVALUATION.reasoning,
      true,
    );
    const { session } = await openSession({
      directory,
      instructions:
        'You are receiving a delegated repository task. Use the supplied handoff as your only evidence. ' +
        'Resolve the latest applicable approval from the earlier evidence. Reply with one JSON object ' +
        'containing only the requested keys. Use booleans for yes or no.',
    });
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const abort = () => void session.abort();
    bounded.addEventListener('abort', abort, { once: true });
    const started = performance.now();
    try {
      bounded.throwIfAborted();
      const reasoning = session.thinkingLevel;
      if (reasoning !== LUNA_EVALUATION.reasoning)
        throw new Error('The receiving agent requires high reasoning.');
      await session.prompt(
        fixture.task.prompt +
          ' Also say whether an automatic rebuild was approved and whether approved work has been performed. ' +
          'Give the source sequences for the first user proposal and the actual user approval. ' +
          `Return these keys: ${Object.keys(expected).join(', ')}.\n\n` +
          handoff,
      );
      signal.throwIfAborted();
      const reply = session.messages.findLast((message) => message.role === 'assistant');
      const text = reply?.content
        .flatMap((entry) => (entry.type === 'text' ? [entry.text] : []))
        .join('')
        .trim();
      const [object, extra] = text?.match(/\{[^{}]*\}/g) ?? [];
      const fenced = text?.match(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i);
      const answer =
        parseDecisionAnswer(text) ??
        parseDecisionAnswer(fenced?.[1]) ??
        (extra === undefined ? parseDecisionAnswer(object) : undefined);
      const formatted = answer !== undefined && (text === object || fenced?.[1]?.trim() === object);
      const returnedModel = reply?.responseModel ?? reply?.model;
      const complete = !bounded.aborted && reply?.stopReason === 'stop';
      return {
        worker: LUNA_EVALUATION,
        returnedModel,
        responseModel: reply?.responseModel,
        reasoning,
        complete,
        formatted,
        elapsedMs: performance.now() - started,
        expected,
        answer,
        usage: reply?.usage,
        ...(auditOutput ? { reply: text } : {}),
        passed:
          complete &&
          returnedModel !== undefined &&
          modelTag(returnedModel) === modelTag(LUNA_EVALUATION.model) &&
          answer !== undefined &&
          matchesLocalDecision(answer, expected),
      };
    } finally {
      bounded.removeEventListener('abort', abort);
      session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseDecisionAnswer(text: string | undefined) {
  if (text === undefined) return undefined;
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export async function qualifyHostedMemory(input: {
  signal: AbortSignal;
  auditOutput: boolean;
  progress: (label: string) => void;
}) {
  const { signal, auditOutput, progress } = input;
  const selection = resolveModel('tiny', { LTCOOK_MODEL_SMOL: hostedModel });
  if (selection.reasoning !== 'none' || selection.reasoningSource !== 'alias')
    throw new Error('The hosted Session Memory qualification requires @tiny with no reasoning.');
  const backend = createHostedMemorySummarizer(selection);
  const reference = realisticReferenceFixture();
  const fixtures = [
    { fixture: reference, requests: 2, critical: 5, skipped: [3, 4, 5, 6] },
    ...candidateScreeningFixtures()
      .filter(({ id }) =>
        [
          'semantic-export-header',
          'semantic-retry-correction',
          'semantic-manifest-reference',
        ].includes(id),
      )
      .map((fixture) => ({
        fixture,
        requests: fixture.id === 'semantic-manifest-reference' ? 2 : 1,
        critical: fixture.id === 'semantic-retry-correction' ? 3 : 4,
        skipped: fixture.id === 'semantic-manifest-reference' ? [3, 4] : [],
      })),
  ];
  if (fixtures.length !== 4)
    throw new Error('The four hosted qualification fixtures are required.');
  const cases = [];
  let receiverHandoff: string | undefined;
  for (const { fixture: original, requests, critical, skipped } of fixtures) {
    signal.throwIfAborted();
    const latest = original.turns.at(-1)?.find(({ author }) => author === 'user');
    if (!latest) throw new Error(`No neutral Task query for ${original.id}.`);
    const fixture = {
      ...original,
      focus: latest.text,
      facts: localMemoryFacts(original, 'local-template'),
    };
    progress(`Hosted Session Memory: ${fixture.id}`);
    let handoff: Handoff | undefined;
    const result = await runHostedMemoryArm(fixture, {
      signal,
      auditOutput,
      hosted: {
        summarize: backend.summarize,
        inference: {
          hosted: { model: selection.model, reasoning: 'off' },
          local: { model: 'unused', reasoning: 'none' },
        },
      },
      onHandoff(_text, details) {
        handoff = details;
      },
    });
    if (!handoff) throw new Error(`No Session Memory handoff for ${fixture.id}.`);
    const evidence = gradeHostedHandoff(fixture, handoff, skipped);
    const routing =
      result.inference?.mode === 'hosted' &&
      result.inference.model === selection.model &&
      result.inference.reasoning === 'off' &&
      result.requests.length === requests &&
      result.requests.every(
        ({ result, currentOnly }) =>
          currentOnly === true &&
          result.complete &&
          result.hosted?.serviceTier === 'default' &&
          result.hosted.providerModelVerified &&
          modelTag(result.hosted.model) === modelTag(selection.model) &&
          result.metrics?.thinkingPresent === false &&
          result.metrics?.reasoningTokens === 0,
      );
    const requestSources = result.requests.map(({ currentSources }) => currentSources);
    const generatedSources = result.sourcePreservation?.records
      .filter(({ state }) => state === 'summarized')
      .map(({ sources }) => sources);
    const passed =
      routing &&
      result.passed &&
      result.sourcePreservation?.passed === true &&
      result.quality.summarization.required === critical &&
      isDeepStrictEqual(requestSources, generatedSources) &&
      evidence.passed;
    cases.push({
      ...result,
      routing,
      handoffEvidence: evidence,
      ...(auditOutput ? { taskQuery: fixture.focus, handoff: handoff.text } : {}),
      passed,
    });
    if (fixture.id === reference.id && passed) receiverHandoff = handoff.text;
  }
  let receivingAgent;
  if (receiverHandoff) {
    progress(`Receiving agent: ${reference.id}, GPT-6 Luna high`);
    receivingAgent = await receiveSnapshotTask(
      receiverHandoff,
      reference,
      signal,
      auditOutput,
    ).catch((error: unknown) => {
      signal.throwIfAborted();
      return {
        worker: LUNA_EVALUATION,
        error: error instanceof Error ? error.message : String(error),
        passed: false,
      };
    });
  }
  return {
    selection,
    serviceTier: 'default',
    usage: backend.usage(),
    cases,
    receivingAgent: receivingAgent ?? { passed: false, skipped: 'Handoff did not qualify.' },
    passed: cases.every(({ passed }) => passed) && receivingAgent?.passed === true,
  };
}

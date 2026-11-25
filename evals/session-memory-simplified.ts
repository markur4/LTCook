import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  memoryAttachmentFixture,
  memoryDiscussionReferenceFixture,
  memoryFixtures,
  memoryHeldOutFixture,
  type MemoryFixture,
} from '../runtime/src/evals/session-memory-fixtures.js';
import {
  contradictsMemoryFact,
  namedMemoryOutcomes,
} from '../runtime/src/evals/session-memory-facts.js';
import { peakRunnerRss, residency } from '../runtime/src/evals/session-memory.js';
import {
  ollamaEndpoint,
  releaseOllamaModel,
  type OllamaSettings,
} from '../runtime/src/integrations/ollama.js';
import {
  memoryDispatchDeadlineMs,
  originalTokenCount,
  shortDiscussionTokens,
  SessionMemory,
  type MemorySearchEntry,
} from '../runtime/src/session-memory/service.js';
import { MemoryStore } from '../runtime/src/session-memory/store.js';
import {
  prepareMemorySummaries,
  originalUampDialogue,
  summarizeMemory,
  type MemoryHistoryEntry,
  type MemorySummaryFormat,
  type MemorySummaryResult,
} from '../runtime/src/session-memory/summarization.js';
import { estimateMemoryTokens } from '../runtime/src/session-memory/text.js';
import {
  identifyMemoryUnits,
  type MemorySourceMessage,
  type MemoryUnit,
} from '../runtime/src/session-memory/units.js';
import {
  contextSettings,
  contextTranscript,
  gradesMemoryFact,
  transcriptSource,
} from './session-memory-context.js';

import { semanticMemoryFixtures } from './session-memory-semantic-fixtures.js';

export const simplifiedArms = [
  'legacy-json',
  'deterministic-json',
  'deterministic-markdown',
] as const;
type Processing = (typeof simplifiedArms)[number];

const agentId = 'session-memory-evaluation';
const epoch = 'fixed-history';
export const simplifiedSeed = 17;

export function simplifiedCorpus() {
  return [...memoryFixtures, memoryAttachmentFixture(), memoryHeldOutFixture];
}

export function referenceFixture(): MemoryFixture {
  const fixture = memoryDiscussionReferenceFixture;
  const discussion = { sessionId: 'snapshot', planId: 'snapshot', passId: 'snapshot' };
  const taskScope = { ...discussion, taskId: 'snapshot' };
  const details = Array.from(
    { length: 14 },
    (_, index) =>
      `Item ${index + 1}: Record only applicable results. Keep the existing names and trace the verification to its original run. Defer each unrelated change.`,
  ).join('\n');
  const turns: MemorySourceMessage[][] = [
    fixture.turns[0]!.map((message) => ({
      ...message,
      scope: discussion,
      text: message.author === 'agent' ? message.text + '\n' + details : message.text,
    })),
    [
      { seq: 3, turnId: 'follow-up', scope: discussion, author: 'user', text: 'Can we use it?' },
      {
        seq: 4,
        turnId: 'follow-up',
        scope: discussion,
        author: 'agent',
        text: 'Yes, on compatible caches.',
      },
    ],
    [
      {
        seq: 5,
        turnId: 'reminder',
        scope: discussion,
        author: 'user',
        text: 'Please keep that option on the table.',
      },
      {
        seq: 6,
        turnId: 'reminder',
        scope: discussion,
        author: 'agent',
        text: 'It remains a proposal.',
      },
    ],
    [
      {
        seq: 7,
        turnId: 'approval',
        scope: taskScope,
        author: 'user',
        text:
          'Implement that, but preserve the existing API. Reject an automatic rebuild.\n' + details,
      },
      {
        seq: 8,
        turnId: 'approval',
        scope: taskScope,
        author: 'agent',
        text: 'I will follow the approval and constraints. No changes yet.',
      },
    ],
    [{ seq: 9, scope: taskScope, author: 'user', text: 'Carry out the approved restart work.' }],
  ];
  return {
    ...fixture,
    id: 'approval-after-skipped-discussion',
    turns,
    flushAfter: [8],
    originalSources: [1, 3, 5, 7, 8, 9],
    correctionSources: [7],
    facts: [
      {
        label: 'the initial snapshot reuse proposal was open',
        source: 1,
        kind: 'decision',
        critical: true,
        expected:
          /(?:propos\w*|consider\w*)[^\n]{0,120}selectWorkspaceSnapshot|selectWorkspaceSnapshot[^\n]{0,120}(?:propos\w*|consider\w*|unapproved|not (?:yet )?approved)/i,
        contradicts:
          /selectWorkspaceSnapshot[^.\n]{0,100}\b(?:is|was) approved\b|\b(?:user(?:['’]s approval)?|explicitly) approved\b[^.\n]{0,120}selectWorkspaceSnapshot/i,
      },
      {
        ...fixture.facts[0]!,
        source: 7,
        expected:
          /(?:approv\w*|implement\w*|agreed|accepted|decid\w*)[^\n]{0,140}(?:reuse|use|reusing)[^\n]{0,50}selectWorkspaceSnapshot|(?:reuse|use|reusing)[^\n]{0,50}selectWorkspaceSnapshot[^\n]{0,100}(?:approv\w*|agreed|accepted)/i,
        contradicts:
          /(?:did not approve|rejected|declined)\s+(?:the\s+)?(?:reuse\s+of\s+)?selectWorkspaceSnapshot/i,
      },
      { ...fixture.facts[1]!, source: 7 },
      {
        label: 'automatic rebuild rejected',
        source: 7,
        kind: 'decision',
        critical: true,
        expected:
          /(?:reject|omit|avoid|no|without|disallow)\w*\b[^.\n]{0,50}automatic rebuild|automatic rebuild[^.\n]{0,40}(?:reject|forbidden|disallow)/i,
        contradicts:
          /(?:approved|authorized)\s+(?:an?\s+)?automatic rebuild|automatic rebuild (?:was |is )?(?:approved|authorized|required)/i,
      },
      {
        label: 'requirements were not reported as completed work',
        source: 8,
        kind: 'finding',
        critical: true,
        expected:
          /(?:no (?:implementation|changes)|changes (?:have been |were )?not made|no (?:code or file|code|file) changes|changes (?:are |remain )?pending|work (?:has )?not started)/i,
        contradicts:
          /\b\d+ items (?:were |have been )?recorded\b|\bimplementation (?:was |is |has been )?completed\b/i,
      },
    ],
  };
}

function largeActionsFixture(): MemoryFixture {
  const first = 2;
  const last = 515;
  const actions: MemorySourceMessage[] = Array.from({ length: last - first + 1 }, (_, index) => {
    const seq = first + index;
    const text =
      seq === first
        ? 'MANY_ACTIONS_CHECK FAIL'
        : seq === last
          ? 'MANY_ACTIONS_CHECK PASS'
          : 'File write success for "runtime/src/report.ts".';
    return {
      seq,
      turnId: 'large',
      author: 'tool',
      text,
      tool:
        seq === first || seq === last
          ? {
              kind: 'shell',
              name: 'shell',
              status: seq === first ? 'failed' : 'completed',
              exitCode: seq === first ? 2 : 0,
            }
          : {
              kind: 'write',
              name: 'write',
              status: 'completed',
              filePath: 'runtime/src/report.ts',
            },
    };
  });
  return {
    id: 'large-action-batch',
    turns: [
      [
        {
          seq: 1,
          turnId: 'large',
          author: 'user',
          text: 'Run all batches and retain both observed outcomes.',
        },
        ...actions,
      ],
      [{ seq: last + 1, author: 'user', text: 'Report both outcomes of MANY_ACTIONS_CHECK.' }],
    ],
    flushAfter: [last],
    originalSources: [first, last],
    correctionSources: [last + 1],
    focus: 'MANY_ACTIONS_CHECK runtime/src/report.ts historical fail pass',
    task: {
      prompt: 'Report the check outcomes in order.',
      expected: { first: 'fail', last: 'pass' },
    },
    facts: [
      {
        source: first,
        label: 'first attempt failed',
        kind: 'progress',
        critical: true,
        expected: /MANY_ACTIONS_CHECK\s+FAIL\b/,
      },
      {
        source: last,
        label: 'last attempt passed',
        kind: 'progress',
        critical: true,
        expected: /MANY_ACTIONS_CHECK\s+PASS\b/,
      },
    ],
  };
}

type Evidence = Pick<MemorySearchEntry, 'seq' | 'sources' | 'text'>;

export function gradeSimplifiedLayer(
  facts: MemoryFixture['facts'],
  evidence: readonly Evidence[],
  originals: readonly MemorySourceMessage[],
) {
  const previousOutcomes = new Map(
    originals.map(({ seq, text }) => [seq, namedMemoryOutcomes(text)]),
  );
  const contradictions = evidence.flatMap((entry) => {
    const references = entry.sources ?? [entry.seq];
    const outcomes = references.flatMap((seq) => previousOutcomes.get(seq) ?? []);
    return namedMemoryOutcomes(entry.text).flatMap(({ name, status }) => {
      if (outcomes.some((outcome) => outcome.name === name && outcome.status === status)) return [];
      return [{ sources: references, name, status }];
    });
  });
  const results = facts.map((fact) => ({
    label: fact.label,
    source: fact.source,
    critical: !!fact.critical,
    retained: evidence.some((entry) => gradesMemoryFact(fact, entry)),
    contradicted: evidence.some(
      (entry) =>
        (entry.sources ?? [entry.seq]).includes(fact.source) &&
        contradictsMemoryFact(fact, entry.text),
    ),
  }));
  const critical = results.filter((fact) => fact.critical);
  return {
    facts: results,
    contradictions,
    retained: critical.filter(({ retained }) => retained).length,
    required: critical.length,
    passed:
      !contradictions.length &&
      critical.every(({ retained, contradicted }) => retained && !contradicted),
  };
}

export async function runSimplifiedMemoryArm(
  fixture: MemoryFixture,
  processing: Processing,
  input: {
    settings: OllamaSettings;
    digest: string;
    signal: AbortSignal;
    progress?: (message: string) => void;
    onHandoff?: (
      text: string,
      details: Awaited<ReturnType<SessionMemory['handoffDetails']>>,
    ) => void;
    auditOutput?: boolean;
    screening?: { weightsDigest: string };
    transformUampPrompt?: (
      prompt: Parameters<typeof summarizeMemory>[1],
    ) => Parameters<typeof summarizeMemory>[1];
  },
) {
  const { signal, digest } = input;
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-memory-simplified-'));
  const file = path.join(directory, 'memory.sqlite');
  const settings = input.screening
    ? { ...input.settings, cpuOnly: true }
    : contextSettings({ ...input.settings, cpuOnly: true }, simplifiedSeed);
  const endpoint = ollamaEndpoint(settings.endpoint);
  const { messages, prompts } = contextTranscript(fixture);
  const original = fixture.turns.flat();
  const processedBySequence = new Map(messages.map((message) => [message.seq, message]));
  let available: readonly MemorySourceMessage[] = messages;
  const source = transcriptSource(() => available, epoch);
  const requests: {
    type: MemorySummaryResult['type'];
    result: Omit<MemorySummaryResult, 'text' | 'content'>;
    cpuVerified: boolean;
    observedMs: number;
    loadedBytes?: number;
    peakRssBytes?: number;
    error?: string;
    audit?: { summary: string; prompt: string; systemPrompt: string };
  }[] = [];
  const memory = new SessionMemory({
    databasePath: file,
    source,
    processing,
    async summarize(type, prompt, turnSignal, _placement, onProgress, format) {
      if (type === 'UAMP' && input.transformUampPrompt) prompt = input.transformUampPrompt(prompt);
      const requestSignal = AbortSignal.any([turnSignal, signal, AbortSignal.timeout(120_000)]);
      const start = performance.now();
      try {
        const result = await summarizeMemory(
          settings,
          prompt,
          requestSignal,
          type,
          true,
          onProgress,
          format,
        );
        const observedMs = performance.now() - start;
        const loaded = await residency(endpoint, digest, signal);
        const { text: _text, content: _content, ...metrics } = result;
        requests.push({
          type,
          result: metrics,
          cpuVerified: !!loaded && loaded.bytes > 0 && loaded.gpuBytes === 0,
          observedMs,
          ...(input.screening
            ? {
                loadedBytes: loaded?.bytes,
                peakRssBytes: await peakRunnerRss(input.screening.weightsDigest),
              }
            : {}),
          ...(input.auditOutput
            ? {
                audit: {
                  summary: result.text,
                  prompt: prompt[1].content,
                  systemPrompt: prompt[0].content,
                },
              }
            : {}),
        });
        return result;
      } catch (error) {
        signal.throwIfAborted();
        const observedMs = performance.now() - start;
        requests.push({
          type,
          cpuVerified: false,
          observedMs,
          ...(input.screening && error instanceof Error ? { error: error.message } : {}),
          result: { type, complete: false, elapsedMs: observedMs },
        });
        throw error;
      }
    },
  });
  try {
    signal.throwIfAborted();
    // > Start each arm with the same model residency and no previous prompt cache.
    await releaseOllamaModel(settings, signal);
    const unhold = memory.holdForeground();
    try {
      for (const [turnId, outcome] of prompts) {
        const scope = messages.find((item) => item.turnId === turnId)?.scope;
        memory.turn(
          agentId,
          {
            turnId,
            outcome,
            scope,
            task: scope?.taskId ? fixture.taskContext : undefined,
            epoch,
            lastSeq: messages.findLast((item) => item.turnId === turnId)?.seq,
          },
          false,
        );
      }
      memory.finalize(agentId);
    } finally {
      unhold();
    }
    await memory.settled();
    signal.throwIfAborted();
    const store = new MemoryStore(file);
    let records;
    try {
      records = store.summaries(agentId, epoch);
    } finally {
      store.close();
    }
    const stored = records.filter(({ complete }) => complete);
    const generated = stored.filter(({ type, state }) => type === 'UAMP' && state !== 'skipped');
    const deterministic = stored.filter(({ state }) => state === 'recorded');
    const expectedUnits = identifyMemoryUnits(messages, prompts, 3000, true);
    const semanticFacts = fixture.facts.filter(({ source }) =>
      expectedUnits.some(
        ({ type, messages: unitMessages }) =>
          type === 'UAMP' &&
          (processing === 'legacy-json' ||
            originalTokenCount(unitMessages) >= shortDiscussionTokens) &&
          unitMessages.some(({ seq }) => seq === source),
      ),
    );
    const atomicFacts =
      processing === 'legacy-json'
        ? []
        : fixture.facts.filter(({ source, attachment }) =>
            expectedUnits.some(
              ({ type, instructions, messages: unitMessages }) =>
                type === 'AAB' &&
                (attachment ? (instructions ?? []) : unitMessages).some(
                  ({ seq }) => seq === source,
                ),
            ),
          );
    const readRecords = (selected: typeof records) =>
      memory.recordEntries(agentId, epoch, selected, signal);
    const allEvidence = await readRecords(stored);
    const summarization = gradeSimplifiedLayer(
      semanticFacts,
      await readRecords(generated),
      original,
    );
    const deterministicExecution = gradeSimplifiedLayer(
      atomicFacts,
      await readRecords(deterministic),
      original,
    );
    const sessionMemory = gradeSimplifiedLayer(fixture.facts, allEvidence, original);
    available = original.map((message) => processedBySequence.get(message.seq) ?? message);
    const assemble = (recover: boolean) =>
      memory.handoffDetails(
        agentId,
        fixture.focus,
        AbortSignal.any([signal, AbortSignal.timeout(memoryDispatchDeadlineMs)]),
        recover,
        undefined,
        fixture.turns.at(-1)?.find(({ author }) => author === 'user')?.scope,
      );
    const withoutRecovery = await assemble(false);
    const handoff = input.screening ? withoutRecovery : await assemble(true);
    input.onHandoff?.(handoff.text, handoff);
    const beforeRecovery = gradeSimplifiedLayer(fixture.facts, withoutRecovery.entries, original);
    const delegation = gradeSimplifiedLayer(fixture.facts, handoff.entries, original);
    const recovery = delegation.facts.flatMap(({ label, retained }, index) =>
      retained && !beforeRecovery.facts[index]?.retained ? [label] : [],
    );
    const search = input.screening
      ? undefined
      : await memory.search(agentId, '', fixture.focus, agentId, signal, true);
    const originalSearch = gradeSimplifiedLayer(
      fixture.facts,
      (search?.matches ?? []).flatMap(({ entries }) =>
        entries.filter(({ kind }) => kind === 'original-message'),
      ),
      original,
    );
    const expectedSkipped = stored.filter(
      ({ type, originalTokens }) =>
        type === 'UAMP' && originalTokens !== undefined && originalTokens < 256,
    );
    const skipPolicy =
      processing === 'legacy-json' ||
      records.every(
        ({ type, state, originalTokens }) =>
          type !== 'UAMP' ||
          originalTokens === undefined ||
          originalTokens < 256 === (state === 'skipped'),
      );
    const validRequests = requests.every(
      ({ result, cpuVerified }) => result.complete && cpuVerified,
    );
    const inferencePolicy =
      processing === 'legacy-json' || (skipPolicy && requests.every(({ type }) => type !== 'AAB'));
    const qualityPassed =
      summarization.passed &&
      deterministicExecution.passed &&
      sessionMemory.passed &&
      delegation.passed;
    const total = (value: (request: (typeof requests)[number]) => number | undefined) => {
      const values = requests.map(value);
      return values.some((item) => item === undefined)
        ? null
        : values.reduce<number>((sum, item) => sum + (item ?? 0), 0);
    };
    return {
      fixture: fixture.id,
      processing,
      requests,
      measurements: {
        requests: requests.length,
        aabRequests: requests.filter(({ type }) => type === 'AAB').length,
        inputTokens: total(({ result }) => result.usage?.inputTokens),
        generationTokens: total(({ result }) => result.usage?.outputTokens),
        cachedInputTokens: total(({ result }) => result.metrics?.cachedInputTokens),
        prefillMs: total(({ result }) => result.metrics?.prefillMs),
        generationMs: total(({ result }) => result.metrics?.generationMs),
        loadMs: total(({ result }) => result.metrics?.loadMs),
        isolatedCpuWallMs: total(({ observedMs }) => observedMs)!,
        storedMemoryBytes: Buffer.byteLength(JSON.stringify(records)),
        summaryBytes: generated.reduce(
          (bytes, record) =>
            bytes +
            record.parts.reduce(
              (sum, { content }) =>
                sum +
                Buffer.byteLength(typeof content === 'string' ? content : JSON.stringify(content)),
              0,
            ),
          0,
        ),
        sqliteBytes: (await stat(file)).size,
        handoffBytes: Buffer.byteLength(handoff.text),
        handoffEstimatedTokens: estimateMemoryTokens(handoff.text),
        skippedUamps: expectedSkipped.filter(({ state }) => state === 'skipped').length,
      },
      quality: {
        summarization,
        deterministicExecution,
        sessionMemory,
        beforeRecovery,
        delegation,
        originalSearch,
        originalSearchStatus: search?.status,
        recovery,
        recoveredSources: handoff.recoveredSources,
      },
      passed: validRequests && inferencePolicy && qualityPassed,
    };
  } finally {
    await memory.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function qualifySemanticMemory(
  input: Parameters<typeof runSimplifiedMemoryArm>[2] & { fixtureId?: string },
) {
  const fixtures = semanticMemoryFixtures.filter(
    ({ id }) => !input.fixtureId || id === input.fixtureId,
  );
  if (!fixtures.length) throw new Error('Unknown semantic Session Memory fixture.');
  const cases = [];
  for (const fixture of fixtures) {
    input.progress?.(`Semantic qualification: ${fixture.id}`);
    const result = await runSimplifiedMemoryArm(fixture, 'deterministic-markdown', input);
    const { required } = result.quality.summarization;
    cases.push({
      ...result,
      passed: result.passed && required > 0 && result.requests.length > 0,
    });
  }
  return { seed: simplifiedSeed, cases, passed: cases.every(({ passed }) => passed) };
}

export async function diagnoseApprovalReference(input: {
  settings: OllamaSettings;
  digest: string;
  signal: AbortSignal;
  auditOutput: boolean;
  progress?: (label: string) => void;
}) {
  const { signal, digest } = input;
  const settings = contextSettings({ ...input.settings, cpuOnly: true }, simplifiedSeed);
  const endpoint = ollamaEndpoint(settings.endpoint);
  const fixture = referenceFixture();
  const [proposal, firstSkipped, secondSkipped, approval] = fixture.turns;
  const prior: MemoryUnit = { type: 'UAMP', messages: proposal!, scope: proposal![0]?.scope };
  const current: MemoryUnit = {
    type: 'UAMP',
    messages: approval!,
    scope: approval![0]?.scope,
    task: fixture.taskContext,
  };
  const skipped = [secondSkipped!, firstSkipped!].map((messages) => ({
    id: messages[0]!.turnId!,
    messages,
  }));
  const run = async (
    prompt: ReturnType<typeof prepareMemorySummaries>[number]['prompt'],
    format: MemorySummaryFormat,
  ) => {
    await releaseOllamaModel(settings, signal);
    const result = await summarizeMemory(settings, prompt, signal, 'UAMP', true, () => {}, format);
    const loaded = await residency(endpoint, digest, signal);
    const cpuVerified = !!loaded && loaded.bytes > 0 && loaded.gpuBytes === 0;
    if (!cpuVerified) throw new Error('Approval diagnostic requires verified CPU inference.');
    return result;
  };
  input.progress?.('Generate one preceding Markdown UAMP for the matched approval replays.');
  const anchorPrompt = prepareMemorySummaries(prior, [], undefined, { format: 'markdown' })[0]!
    .prompt;
  const anchor = await run(anchorPrompt, 'markdown');
  if (!anchor.complete) throw new Error('The preceding UAMP generation was incomplete.');
  const generated: MemoryHistoryEntry = {
    id: 'UAMP:1:2',
    type: 'UAMP',
    scope: current.scope,
    content: anchor.content,
    format: 'markdown',
  };
  const original: MemoryHistoryEntry = {
    ...generated,
    format: undefined,
    content: originalUampDialogue(proposal!),
  };
  const symbol = 'selectWorkspaceSnapshot';
  const variants = [
    { name: 'generated-records', anchor: generated },
    { name: 'original-records', anchor: original },
    { name: 'generated-dialogue', anchor: generated, contextStyle: 'dialogue' as const },
  ];
  const originals = fixture.turns.flat();
  const anchorQuality = gradeSimplifiedLayer(
    fixture.facts.filter(({ source }) => source <= 2),
    [{ seq: 2, sources: [1, 2], text: anchor.text }],
    originals,
  );
  const results = [];
  for (const variant of variants) {
    const policy = { skipped, contextStyle: variant.contextStyle };
    const markdown = prepareMemorySummaries(current, [variant.anchor], undefined, {
      ...policy,
      format: 'markdown',
    })[0]!;
    const json = prepareMemorySummaries(current, [variant.anchor], undefined, {
      ...policy,
      format: 'json',
    })[0]!;
    for (const format of ['json', 'markdown'] as const) {
      input.progress?.(`${variant.name} ${format}`);
      const prompt = [
        format === 'json' ? json.prompt[0]! : markdown.prompt[0]!,
        {
          role: 'user' as const,
          content:
            format === 'json'
              ? markdown.prompt[1]!.content.replace(
                  'Reply with the Markdown summary only.',
                  'Reply with the compact JSON only.',
                )
              : markdown.prompt[1]!.content,
        },
      ];
      const result = await run(prompt, format);
      const quality = gradeSimplifiedLayer(
        fixture.facts.filter(({ source }) => source >= 7),
        result.complete ? [{ seq: 8, sources: markdown.sources, text: result.text }] : [],
        originals,
      );
      results.push({
        variant: variant.name,
        format,
        quality,
        complete: result.complete,
        contextTokens: markdown.historyEstimatedTokens,
        referentInPrompt: markdown.historyText.includes(symbol),
        referentInAnswer: result.text.includes(symbol),
        inferenceMs: result.elapsedMs,
        usage: result.usage,
        ...(input.auditOutput ? { prompt, reply: result.text } : {}),
      });
    }
  }
  return {
    seed: simplifiedSeed,
    anchorQuality,
    referentInGeneratedAnchor: anchor.text.includes(symbol),
    ...(input.auditOutput ? { anchorPrompt, anchor: anchor.text } : {}),
    results,
  };
}

export async function compareSimplifiedMemory(
  input: Parameters<typeof runSimplifiedMemoryArm>[2] & { fixtureId?: string },
) {
  const fixtures = simplifiedCorpus().filter(
    ({ id }) => !input.fixtureId || input.fixtureId === id,
  );
  const controlFixtures = [referenceFixture(), largeActionsFixture()].filter(
    ({ id }) => !input.fixtureId || input.fixtureId === id,
  );
  if (!fixtures.length && !controlFixtures.length)
    throw new Error('Unknown Session Memory fixture.');
  const scenarios: Awaited<ReturnType<typeof runSimplifiedMemoryArm>>[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    for (let offset = 0; offset < simplifiedArms.length; offset++) {
      const arm = simplifiedArms[(index + offset) % simplifiedArms.length]!;
      input.progress?.(`${fixture.id} ${arm}`);
      scenarios.push(await runSimplifiedMemoryArm(fixture, arm, input));
    }
  }
  const controls = [];
  for (const fixture of controlFixtures) {
    for (const arm of simplifiedArms.slice(1)) {
      input.progress?.(`${fixture.id} ${arm}`);
      controls.push(await runSimplifiedMemoryArm(fixture, arm, input));
    }
  }
  const totals = (processing: Processing) => {
    const arms = scenarios.filter((scenario) => scenario.processing === processing);
    const requests = arms.reduce((sum, arm) => sum + arm.measurements.requests, 0);
    const isolatedCpuWallMs = arms.reduce(
      (sum, arm) => sum + arm.measurements.isolatedCpuWallMs,
      0,
    );
    const retained = (layer: 'sessionMemory' | 'delegation') =>
      arms.reduce((sum, arm) => sum + arm.quality[layer].retained, 0);
    return {
      processing,
      requests,
      isolatedCpuWallMs,
      sessionMemoryCritical: retained('sessionMemory'),
      delegationCritical: retained('delegation'),
      passed: arms.every(({ passed }) => passed),
    };
  };
  const arms = simplifiedArms.map(totals);
  const baseline = arms[0]!;
  const candidate = arms[2]!;
  const reduction = (before: number, after: number) => (before ? 1 - after / before : null);
  const requestReduction = reduction(baseline.requests, candidate.requests);
  const cpuReduction = reduction(baseline.isolatedCpuWallMs, candidate.isolatedCpuWallMs);
  return {
    seed: simplifiedSeed,
    scenarios,
    controls,
    arms,
    performance: { requestReduction, cpuReduction, target: 0.3 },
    passed:
      candidate.passed &&
      (input.fixtureId !== undefined ||
        (candidate.sessionMemoryCritical === 14 && candidate.delegationCritical === 14)) &&
      controls
        .filter(({ processing }) => processing === 'deterministic-markdown')
        .every(({ passed }) => passed),
  };
}

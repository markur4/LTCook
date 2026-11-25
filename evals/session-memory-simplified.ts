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
import { residency } from '../runtime/src/evals/session-memory.js';
import {
  ollamaEndpoint,
  releaseOllamaModel,
  type OllamaSettings,
} from '../runtime/src/integrations/ollama.js';
import {
  memoryDispatchDeadlineMs,
  SessionMemory,
  type MemorySearchEntry,
} from '../runtime/src/session-memory/service.js';
import { MemoryStore } from '../runtime/src/session-memory/store.js';
import {
  summarizeMemory,
  type MemorySummaryResult,
} from '../runtime/src/session-memory/summarization.js';
import { estimateMemoryTokens } from '../runtime/src/session-memory/text.js';
import type { MemorySourceMessage } from '../runtime/src/session-memory/units.js';
import {
  contextSettings,
  contextTranscript,
  gradesMemoryFact,
  transcriptSource,
} from './session-memory-context.js';

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

function referenceFixture(): MemoryFixture {
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
        ...fixture.facts[0]!,
        source: 7,
        expected:
          /(?=.*\b(?:approv\w*|implement\w*|agreed|accepted|decid\w*)\b)(?=.*\b(?:reuse|use|reusing)\b)(?=.*\bselectWorkspaceSnapshot\b)/is,
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

async function runArm(
  fixture: MemoryFixture,
  processing: Processing,
  input: {
    settings: OllamaSettings;
    digest: string;
    signal: AbortSignal;
    progress?: (message: string) => void;
  },
) {
  const { signal, digest } = input;
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-memory-simplified-'));
  const file = path.join(directory, 'memory.sqlite');
  const settings = contextSettings({ ...input.settings, cpuOnly: true }, simplifiedSeed);
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
  }[] = [];
  const memory = new SessionMemory({
    databasePath: file,
    source,
    processing,
    async summarize(type, prompt, turnSignal, _placement, _onProgress, format) {
      const requestSignal = AbortSignal.any([turnSignal, signal, AbortSignal.timeout(120_000)]);
      const start = performance.now();
      try {
        const result = await summarizeMemory(
          settings,
          prompt,
          requestSignal,
          type,
          true,
          undefined,
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
        });
        return result;
      } catch (error) {
        signal.throwIfAborted();
        const observedMs = performance.now() - start;
        requests.push({
          type,
          cpuVerified: false,
          observedMs,
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
    const semanticFacts = fixture.facts.filter((fact) =>
      records.some(
        ({ type, state, sources }) =>
          type === 'UAMP' && state !== 'skipped' && sources.some(({ seq }) => seq === fact.source),
      ),
    );
    const atomicFacts = fixture.facts.filter((fact) =>
      deterministic.some(({ sources, attachmentSources }) =>
        (fact.attachment ? (attachmentSources ?? []) : sources).some(
          ({ seq }) => seq === fact.source,
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
    const handoff = await assemble(true);
    const beforeRecovery = gradeSimplifiedLayer(fixture.facts, withoutRecovery.entries, original);
    const delegation = gradeSimplifiedLayer(fixture.facts, handoff.entries, original);
    const recovery = delegation.facts.flatMap(({ label, retained }, index) =>
      retained && !beforeRecovery.facts[index]?.retained ? [label] : [],
    );
    const search = await memory.search(agentId, '', fixture.focus, agentId, signal, true);
    const originalSearch = gradeSimplifiedLayer(
      fixture.facts,
      search.matches.flatMap(({ entries }) =>
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
        originalSearchStatus: search.status,
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

export async function compareSimplifiedMemory(input: Parameters<typeof runArm>[2]) {
  const fixtures = simplifiedCorpus();
  const scenarios: Awaited<ReturnType<typeof runArm>>[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    for (let offset = 0; offset < simplifiedArms.length; offset++) {
      const arm = simplifiedArms[(index + offset) % simplifiedArms.length]!;
      input.progress?.(`${fixture.id} ${arm}`);
      scenarios.push(await runArm(fixture, arm, input));
    }
  }
  const controls = [];
  for (const fixture of [referenceFixture(), largeActionsFixture()]) {
    for (const arm of simplifiedArms.slice(1)) {
      input.progress?.(`${fixture.id} ${arm}`);
      controls.push(await runArm(fixture, arm, input));
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
      candidate.sessionMemoryCritical === 14 &&
      candidate.delegationCritical === 14 &&
      controls
        .filter(({ processing }) => processing === 'deterministic-markdown')
        .every(({ passed }) => passed),
  };
}

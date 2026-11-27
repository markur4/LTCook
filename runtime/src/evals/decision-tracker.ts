import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ResolvedModel } from '../models/aliases.js';
import { trackerGapReasons } from '../paseo-plugin/client/tracker-presentation.js';
import { providerInferenceFailure } from '../services/inference-recovery.js';
import type { MemorySource } from '../session-memory/conversation.js';
import { hostedConversationProvider } from '../session-memory/hosted.js';
import {
  ConversationInference,
  type ConversationPrompt,
  type ConversationProvider,
  type InferenceResponse,
} from '../session-memory/inference.js';
import { openConversationProductStore } from '../session-memory/product-store.js';
import { TrackerStore } from '../session-memory/tracker-store.js';
import {
  TrackerService,
  trackerExtractionInstructions,
  type TrackerObservation,
} from '../session-memory/tracker.js';
import type { MemorySourceMessage } from '../session-memory/units.js';
import type { EvalSetup } from './contracts.js';
import {
  decisionTrackerFixtures,
  type DecisionTrackerFixture,
} from './decision-tracker-fixtures.js';
import {
  auditDecisionTrackerInstructions,
  calibrateDecisionTrackerGrader,
  gradeDecisionTrackerCase,
  summarizeDecisionTrackerGrades,
  type DecisionTrackerGrader,
} from './decision-tracker-grading.js';
import { openDecisionTrackerTimeline } from './decision-tracker-timeline.js';
import { sanitizeEvaluationText } from './diagnostics.js';
import type { EvalEngine } from './service.js';
import { prepareHostedPiEvaluation } from './summarization-decision.js';

const trackerId = 'design-decisions';
const fixtureEpoch = 'decision-tracker-fixture';
const runtimeErrorText: readonly string[] = [
  ...Object.values(trackerGapReasons),
  'The provider did not complete the request.',
  'maximum context length exceeded',
];
type Verdict = 'passed' | 'failed' | 'blocked';
type Check = {
  verdict: Verdict;
  stage: string;
  metric?: 'revisionAccuracy' | 'recoveryCorrectness' | 'idempotency';
  name: string;
  expected: unknown;
  observed: unknown;
};

function controlledTimeline(messages: MemorySourceMessage[], pageSize: number): MemorySource {
  return {
    async read(_agentId, cursor, direction = 'after') {
      const latest = messages.at(-1)?.seq ?? -1;
      const page =
        direction === 'before'
          ? messages.filter(({ seq }) => seq < (cursor?.seq ?? 0)).slice(-pageSize)
          : direction === 'tail'
            ? messages.slice(-pageSize)
            : messages.filter(({ seq }) => seq > (cursor?.seq ?? -1)).slice(0, pageSize);
      return {
        epoch: fixtureEpoch,
        latest,
        through: page.at(-1)?.seq ?? cursor?.seq ?? -1,
        start: page[0]?.seq,
        earliest: messages[0]?.seq,
        reset: Boolean(cursor && cursor.epoch !== fixtureEpoch),
        messages: page,
      };
    },
  };
}

function scriptedCompletion(
  fixture: DecisionTrackerFixture,
  { input }: ConversationPrompt,
  sequence: (seq: number) => number,
  nativeSeq: (seq: number) => number,
  fixtureItemId: ReadonlyMap<number, string>,
  attempts: Map<number, number>,
): InferenceResponse {
  const request = JSON.parse(input) as {
    current: { seq: number };
    trackers: { id: string; items: { id: string }[] }[];
  };
  const seq = sequence(request.current.seq);
  const index = attempts.get(seq) ?? 0;
  attempts.set(seq, index + 1);
  const scripted = fixture.responses?.[seq] ?? 'no-change';
  const response =
    typeof scripted === 'object' && 'attempts' in scripted
      ? (scripted.attempts[Math.min(index, scripted.attempts.length - 1)] ?? 'no-change')
      : scripted;
  if (response === 'context-rejection')
    throw providerInferenceFailure(
      { authentication: 'Fixture authentication failure.', model: 'Fixture model failure.' },
      400,
      'maximum context length exceeded',
    );
  if (response === 'invalid-output') return { text: '{invalid', complete: true };
  const trackers = request.trackers.map(({ id, items }) => ({
    trackerId: id,
    changes: (response === 'no-change' ? [] : [response]).map((change) => {
      const sources = change.sources.map(nativeSeq);
      if (change.type === 'add') return { ...change, sources };
      const itemId = items.find((item) => item.id === fixtureItemId.get(change.targetSource))?.id;
      if (change.type === 'retire') return { type: change.type, itemId, sources };
      return { type: change.type, text: change.text, itemId, sources };
    }),
  }));
  return { text: JSON.stringify({ trackers }), complete: true };
}

type CaseOptions = {
  directory: string;
  inputTokens: number;
  signal: AbortSignal;
  provider?: ConversationProvider;
  nativeTimeline?: { appRoot: string; nodeExecutable: string };
};

function resultVerdict(checks: readonly { verdict: Verdict }[]): Verdict {
  if (checks.some(({ verdict }) => verdict === 'failed')) return 'failed';
  return checks.some(({ verdict }) => verdict === 'blocked') ? 'blocked' : 'passed';
}

function errorReason(error: unknown) {
  return sanitizeEvaluationText(error instanceof Error ? error.message : 'Unknown failure.');
}

/** Drive production Tracker over disposable SQLite state and read back every checkpoint. */
export async function runDecisionTrackerCase(
  fixture: DecisionTrackerFixture,
  options: CaseOptions,
) {
  const { directory, signal, provider, nativeTimeline } = options;
  const started = performance.now();
  await mkdir(directory, { recursive: true });
  let inputTokens = options.inputTokens;
  if (fixture.budgetOffset !== undefined) {
    const probe = await runDecisionTrackerCase(
      { ...fixture, budgetOffset: undefined },
      {
        ...options,
        provider: undefined,
        directory: path.join(directory, 'budget-probe'),
        inputTokens: Number.MAX_SAFE_INTEGER,
      },
    );
    const request = probe.observations.find(({ stage }) => stage === 'token-budgeting');
    if (request?.stage !== 'token-budgeting')
      throw new Error('The budget fixture did not construct a request for calibration.');
    inputTokens = request.estimatedTokens + fixture.budgetOffset;
  }

  const native =
    fixture.native && nativeTimeline
      ? await openDecisionTrackerTimeline({ ...nativeTimeline, directory, signal })
      : undefined;
  const checks: Check[] = [];
  if (fixture.native && !native)
    checks.push({
      verdict: 'blocked',
      stage: 'evidence-selection',
      name: 'Native Pi/Paseo timeline',
      expected: 'Disposable native history',
      observed: 'Native runtime prerequisites are unavailable.',
    });
  const messages: MemorySourceMessage[] = [];
  const source = native?.source ?? controlledTimeline(messages, fixture.pageSize ?? 48);
  const agentId = native?.agentId ?? fixture.id;
  const databasePath = path.join(directory, 'conversation-products.sqlite');
  const evidenceSequence = new Map<number, number>();
  const timelineSequence = new Map<number, number>();
  const logicalSeq = (seq: number) => evidenceSequence.get(seq) ?? seq;
  const nativeSeq = (seq: number) => timelineSequence.get(seq) ?? seq;
  const observations: TrackerObservation[] = [];
  const aliases = new Map<string, string>();
  const completedRequests = new Set<number>();
  const attempts = new Map<number, number>();
  const inferenceUsage: NonNullable<InferenceResponse['usage']>[] = [];
  const requests: { seq: number; evidence: number[]; sent: boolean }[] = [];
  let sent = 0;
  let interrupted: (() => void) | undefined;
  let providerUnavailable = false;
  let instance: ReturnType<typeof open> | undefined;
  let closing: Promise<void> | undefined;

  const completion: ConversationProvider = async (prompt, requestSignal) => {
    sent++;
    const bounded = AbortSignal.any([signal, requestSignal]);
    bounded.throwIfAborted();
    if (interrupted) {
      interrupted();
      await delay(2_147_483_647, undefined, { signal: bounded });
    }
    const seq = requests.findLast(({ sent }) => sent)?.seq;
    let result: InferenceResponse;
    if (provider) {
      result = await provider(prompt, bounded);
    } else {
      const state = instance && new TrackerStore(instance.database).load(agentId);
      const eventSequences = new Map(
        state?.events.map(({ id, source }) => [id, logicalSeq(source.seq)]),
      );
      const fixtureItemId = new Map<number, string>();
      for (const revision of state?.revisions ?? []) {
        const seq = revision.eventId && eventSequences.get(revision.eventId);
        if (typeof seq === 'number' && !revision.invalidated && revision.text !== null)
          fixtureItemId.set(seq, revision.itemId);
      }
      result = scriptedCompletion(fixture, prompt, logicalSeq, nativeSeq, fixtureItemId, attempts);
    }
    if (seq !== undefined && result.complete) completedRequests.add(seq);
    return result;
  };
  const validate = provider?.validate;
  if (validate)
    completion.validate = (requestSignal) => validate(AbortSignal.any([signal, requestSignal]));
  function open() {
    const database = openConversationProductStore(databasePath);
    const inference = new ConversationInference({ hosted: completion }, 'hosted', ({ usage }) => {
      if (usage) inferenceUsage.push(usage);
    });
    const tracker = new TrackerService(database, source, inference, inputTokens, (entry) => {
      const seq = logicalSeq(entry.seq);
      if ('evidence' in entry) {
        const evidence = entry.evidence.map(logicalSeq);
        observations.push({ ...entry, seq, evidence });
        requests.push({
          seq,
          evidence,
          sent: entry.stage === 'request-sent',
        });
      } else observations.push({ ...entry, seq });
    });
    return { database, inference, tracker };
  }

  function close() {
    const current = instance;
    instance = undefined;
    if (!current) return closing;
    closing = (async () => {
      try {
        await current.tracker.close();
      } finally {
        try {
          await current.inference.close();
        } finally {
          current.database.close();
        }
      }
    })();
    return closing;
  }
  const abort = () => void close()?.catch(() => undefined);

  const checkpoints: Awaited<ReturnType<typeof persisted>>[] = [];
  async function persisted(step: number) {
    const reader = openConversationProductStore(databasePath);
    const tracker = new TrackerService(
      reader,
      source,
      {
        async complete() {
          throw new Error('A persisted checkpoint cannot call inference.');
        },
      },
      inputTokens,
    );
    try {
      const state = new TrackerStore(reader).load(agentId);
      const snapshot = await tracker.snapshot(agentId);
      const eventSequences = new Map(
        state.events.map(({ id, source }) => [id, logicalSeq(source.seq)]),
      );
      const revisions = state.revisions
        .filter(({ trackerId: id }) => id === trackerId)
        .map(({ itemId, text, invalidated, sources, eventId }) => ({
          itemId,
          text,
          invalidated: Boolean(invalidated),
          sources: sources.map(({ seq }) => logicalSeq(seq)),
          seq: eventId === undefined ? undefined : eventSequences.get(eventId),
        }));
      const cursor = state.cursor?.seq ?? -1;
      return {
        step,
        cursor: native
          ? Math.max(
              -1,
              ...[...timelineSequence].flatMap(([seq, position]) =>
                position <= cursor ? [seq] : [],
              ),
            )
          : cursor,
        nativeCursor: cursor,
        historyUnavailable: snapshot.historyUnavailable,
        eligible: messages.filter(({ author }) => author === 'user').map(({ seq }) => seq),
        events: snapshot.events.flatMap(({ source: reference, trackers }) => {
          const event = trackers.find(({ trackerId: id }) => id === trackerId);
          return event
            ? [{ seq: logicalSeq(reference.seq), status: event.status, reason: event.reason }]
            : [];
        }),
        items:
          snapshot.trackers
            .find(({ id }) => id === trackerId)
            ?.items.map(({ id, text, sources }) => ({
              id,
              text,
              sources: sources.map(({ seq }) => logicalSeq(seq)),
            })) ?? [],
        revisions,
        requests: sent,
      };
    } finally {
      await tracker.close();
      reader.close();
    }
  }

  function check(
    name: string,
    stage: string,
    passed: boolean,
    expected: unknown,
    observed: unknown,
    metric?: Check['metric'],
  ) {
    checks.push({ name, stage, verdict: passed ? 'passed' : 'failed', expected, observed, metric });
  }

  try {
    signal.throwIfAborted();
    if (fixture.native && !native) throw new Error('Native timeline is unavailable.');
    instance = open();
    signal.addEventListener('abort', abort, { once: true });
    if (fixture.seedItems?.length) {
      const store = new TrackerStore(instance.database);
      const state = store.load(agentId);
      state.revisions = fixture.seedItems.map((text, index) => ({
        trackerId,
        text,
        itemId: `fixture-seed-${index}`,
        sources: [],
        manual: false,
      }));
      store.save(agentId, state);
    }
    for (const [stepIndex, step] of fixture.steps.entries()) {
      signal.throwIfAborted();
      const previousSent = sent;
      for (const message of step.messages ?? []) {
        if (native) {
          if (message.author !== 'user') throw new Error('The native case accepts user prompts.');
          const sequence = await native.append(message.text);
          evidenceSequence.set(sequence, message.seq);
          timelineSequence.set(message.seq, sequence);
        }
        messages.push({ ...message, messageId: `fixture-${message.seq}` });
      }
      signal.throwIfAborted();
      if (!instance || step.action === 'reopen') {
        await close();
        instance = open();
      }
      if (step.action && typeof step.action === 'object') {
        const epoch = (await source.read(agentId, undefined, 'tail')).epoch;
        instance.tracker.recover(agentId, {
          type: step.action.recover,
          trackerId,
          source: { epoch, seq: nativeSeq(step.action.seq) },
        });
      }
      if (step.action === 'interrupt') {
        const entering = Promise.withResolvers<void>();
        interrupted = entering.resolve;
        instance.tracker.observe(agentId);
        await Promise.race([entering.promise, instance.tracker.settled(agentId)]);
        await close();
        interrupted = undefined;
      } else {
        instance.tracker.observe(agentId);
        await instance.tracker.settled(agentId);
      }
      let actual = await persisted(stepIndex);
      if (fixture.eventualProgress && stepIndex === fixture.steps.length - 1) {
        const { seq, status } = fixture.eventualProgress;
        const deadline = performance.now() + 250;
        while (
          performance.now() < deadline &&
          !actual.events.some((event) => event.seq === seq && event.status === status)
        ) {
          await delay(20, undefined, { signal });
          actual = await persisted(stepIndex);
        }
      }
      checkpoints.push(actual);
      const eligible = messages
        .filter(({ author, seq }) => author === 'user' && nativeSeq(seq) <= actual.nativeCursor)
        .map(({ seq }) => seq);
      const recorded = actual.events.map(({ seq }) => seq);
      check(
        'Durable coverage behind ingestion cursor',
        'persistence',
        eligible.every((seq) => recorded.includes(seq)),
        eligible,
        recorded,
      );
      const reportedComplete = actual.events
        .filter(({ status }) => status === 'changes' || status === 'no-change')
        .map(({ seq }) => seq);
      check(
        'Complete coverage has completed inference',
        'coverage',
        reportedComplete.every((seq) => completedRequests.has(seq)),
        [...completedRequests],
        reportedComplete,
      );
      check(
        'Canonical timeline remains available',
        'evidence-selection',
        !actual.historyUnavailable,
        true,
        !actual.historyUnavailable,
      );
      check(
        'No prefix or runtime error in stored decisions',
        'state-mutation',
        actual.items.every(
          ({ text }) =>
            !/^\s*(?:[-*+]|\d+[.)])\s/m.test(text) &&
            !runtimeErrorText.some((message) => text.toLowerCase().includes(message.toLowerCase())),
        ),
        'Plain decision text',
        actual.items.map(({ id, text }) => ({ id, text })),
      );
      signal.throwIfAborted();
      providerUnavailable ||= Boolean(
        provider &&
        actual.events.some(
          ({ reason }) =>
            reason === 'authentication' || reason === 'configuration' || reason === 'transient',
        ),
      );
      if (providerUnavailable) break;
      const expected = step.expect;
      if (!expected) continue;
      for (const [seq, status] of Object.entries(expected.coverage ?? {})) {
        const event = actual.events.find((entry) => entry.seq === Number(seq));
        const observedFailure = observations.findLast(
          (entry) => entry.seq === Number(seq) && 'outcome' in entry,
        );
        const stage =
          event?.reason === 'budget'
            ? 'token-budgeting'
            : observedFailure
              ? observedFailure.stage
              : event?.reason === 'source'
                ? 'evidence-selection'
                : event?.reason === 'transient'
                  ? 'hosted-inference'
                  : step.action
                    ? 'recovery'
                    : 'coverage';
        check(
          `Coverage for message ${seq}`,
          stage,
          event?.status === status,
          status,
          event,
          step.action === 'observe'
            ? 'idempotency'
            : step.action
              ? 'recoveryCorrectness'
              : undefined,
        );
      }
      if (expected.requests !== undefined) {
        check(
          'Inference requests for checkpoint',
          'request-construction',
          sent - previousSent === expected.requests,
          expected.requests,
          sent - previousSent,
          step.action === 'observe' ? 'idempotency' : undefined,
        );
      }
      if (expected.revisions !== undefined) {
        const revisionCount = actual.revisions.filter(({ invalidated }) => !invalidated).length;
        check(
          'Persisted revision count',
          'state-mutation',
          revisionCount === expected.revisions,
          expected.revisions,
          revisionCount,
          step.action === 'observe' ? 'idempotency' : undefined,
        );
      }
      if (expected.items) {
        check(
          'Active Notebook item count',
          'state-mutation',
          actual.items.length === expected.items.length,
          expected.items.length,
          actual.items.length,
        );
        for (const item of expected.items) {
          const cited = actual.items.filter(({ sources }) =>
            item.sources.every((seq) => sources.includes(seq)),
          );
          const matching =
            provider && cited.length === 1
              ? cited
              : cited.filter(
                  ({ text }) =>
                    !item.textIncludes ||
                    text.toLowerCase().includes(item.textIncludes.toLowerCase()),
                );
          const previousId = aliases.get(item.alias);
          const match = matching.length === 1 ? matching[0] : undefined;
          check(
            `Persisted item and identity for ${item.alias}`,
            'state-mutation',
            Boolean(match && (!previousId || match.id === previousId)),
            { ...item, id: previousId },
            matching,
            step.action === 'observe' ? 'idempotency' : undefined,
          );
          if (match && !previousId) aliases.set(item.alias, match.id);
        }
      }
      for (const { seq } of step.messages ?? []) {
        const response = fixture.responses?.[seq];
        if (
          !response ||
          typeof response !== 'object' ||
          !('type' in response) ||
          (response.type !== 'update' && response.type !== 'retire')
        )
          continue;
        const original = actual.revisions.find(
          (revision) =>
            revision.seq === response.targetSource &&
            !revision.invalidated &&
            revision.text !== null,
        );
        const revised = actual.revisions.find(
          (revision) => revision.seq === seq && !revision.invalidated,
        );
        check(
          `Revision keeps item identity for message ${seq}`,
          'state-mutation',
          Boolean(
            original &&
            revised &&
            original.itemId === revised.itemId &&
            (response.type === 'retire' ? revised.text === null : revised.text !== null),
          ),
          { itemId: original?.itemId, type: response.type },
          revised,
          'revisionAccuracy',
        );
      }
    }
    for (const [seq, expected] of Object.entries(fixture.requiredEvidence ?? {})) {
      if (!providerUnavailable || completedRequests.has(Number(seq))) {
        const sentEvidence = [
          ...new Set(
            requests
              .filter((entry) => entry.sent && entry.seq === Number(seq))
              .flatMap(({ evidence }) => evidence),
          ),
        ].sort((a, b) => a - b);
        const excludedByBudget = observations.some(
          (entry) =>
            entry.stage === 'token-budgeting' &&
            entry.seq === Number(seq) &&
            entry.estimatedTokens > inputTokens,
        );
        check(
          `Required evidence available to inference for message ${seq}`,
          excludedByBudget ? 'token-budgeting' : 'evidence-selection',
          expected.every((reference) => sentEvidence.includes(reference)),
          expected,
          sentEvidence,
        );
      }
    }
    if (!providerUnavailable) {
      if (fixture.eventualProgress) {
        const { seq, status, itemAlias } = fixture.eventualProgress;
        const final = checkpoints.at(-1);
        const coverage = final?.events.find((event) => event.seq === seq);
        const expected = fixture.expectedDecisions.find(({ alias }) => alias === itemAlias);
        const matches =
          expected &&
          final?.items.filter(({ sources }) =>
            expected.sources.every((source) => sources.includes(source)),
          );
        const item =
          itemAlias === undefined
            ? undefined
            : (aliases.get(itemAlias) ?? (matches?.length === 1 ? matches[0]?.id : undefined));
        check(
          'Automatic eventual progress',
          'recovery',
          coverage?.status === status &&
            (itemAlias === undefined ||
              Boolean(item && final?.items.some(({ id }) => id === item))),
          fixture.eventualProgress,
          { coverage, item },
          'recoveryCorrectness',
        );
      }
    } else {
      checks.push({
        verdict: 'blocked',
        stage: 'hosted-inference',
        name: 'Hosted provider availability',
        expected: 'Completed Hosted request',
        observed: checkpoints.at(-1)?.events.filter(({ status }) => status === 'failed'),
      });
    }
  } catch (error) {
    checks.push({
      verdict: 'blocked',
      stage: signal.aborted ? 'deadline' : 'evaluation',
      name: 'Fixture execution',
      expected: 'Completed fixture',
      observed: errorReason(error),
    });
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      await close();
    } finally {
      await native?.close();
    }
  }
  const failure = checks.find(({ verdict }) => verdict === 'failed');
  return {
    id: fixture.id,
    title: fixture.title,
    mode: fixture.mode,
    inputTokens,
    verdict: resultVerdict(checks),
    elapsedMs: performance.now() - started,
    ...(failure ? { failureStage: failure.stage } : {}),
    ...(checkpoints.some(({ events }) => events.some(({ reason }) => reason === 'budget'))
      ? { budgetMessage: trackerGapReasons.budget }
      : {}),
    checks,
    checkpoints,
    observations,
    requests,
    inferenceUsage,
    expectedDecisions: fixture.expectedDecisions,
    requiredEvidence: fixture.requiredEvidence,
  };
}

type EvaluationConfiguration =
  { inputTokens: number; model: ResolvedModel } | { blocked: string; inputTokens?: number };

type CaseResult = Awaited<ReturnType<typeof runDecisionTrackerCase>>;
type CaseReport = CaseResult & {
  deterministicVerdict: Verdict;
  semantic?: Awaited<ReturnType<typeof gradeDecisionTrackerCase>>;
  blocker?: string;
  deadline?: { timeoutMs: number; referenceRuns: string[] };
};

function blockedCase(
  fixture: DecisionTrackerFixture,
  inputTokens: number,
  blocker: string,
): CaseReport {
  return {
    id: fixture.id,
    title: fixture.title,
    mode: fixture.mode,
    inputTokens,
    verdict: 'blocked',
    deterministicVerdict: 'blocked',
    elapsedMs: 0,
    checks: [],
    checkpoints: [],
    observations: [],
    requests: [],
    inferenceUsage: [],
    blocker,
    expectedDecisions: fixture.expectedDecisions,
    requiredEvidence: fixture.requiredEvidence,
  };
}

function tally<T>(entries: readonly T[], passed: (entry: T) => boolean) {
  return { passed: entries.filter(passed).length, total: entries.length };
}

function metrics(cases: readonly CaseReport[]) {
  const checks = cases.flatMap((report) => report.checks);
  const matching = (metric: Check['metric']) =>
    tally(
      checks.filter((check) => check.metric === metric),
      (check) => check.verdict === 'passed',
    );
  const coverage = cases.flatMap((report) => {
    const final = report.checkpoints.at(-1);
    if (!final) return [];
    return final.eligible.map((seq) => {
      const status = final.events.find((entry) => entry.seq === seq)?.status;
      const available = report.requests
        .filter((request) => request.sent && request.seq === seq)
        .flatMap(({ evidence }) => evidence);
      return (
        (status === 'changes' || status === 'no-change') &&
        (report.requiredEvidence?.[seq] ?? [seq]).every((source) => available.includes(source))
      );
    });
  });
  return {
    revisionAccuracy: matching('revisionAccuracy'),
    extractionCoverage: tally(coverage, (covered) => covered),
    recoveryCorrectness: matching('recoveryCorrectness'),
    idempotency: matching('idempotency'),
  };
}

type EvalTiming = Pick<Parameters<EvalEngine>[0], 'budget' | 'learned'>;
type SuiteOptions = EvalTiming & {
  directory: string;
  signal: AbortSignal;
  setup: EvalSetup;
  deterministicOnly?: boolean;
  configuration: EvaluationConfiguration;
  appRoot?: string;
  nodeExecutable?: string;
  python?: string;
  provider?: (model: ResolvedModel) => ConversationProvider;
  grader?: DecisionTrackerGrader;
  fixtures?: readonly DecisionTrackerFixture[];
  onProgress?(report: DecisionTrackerReport, caseId?: string): Promise<void> | void;
};

type DecisionTrackerReport = {
  setup: EvalSetup;
  deterministicOnly: boolean;
  inputTokens: number | undefined;
  model?: ResolvedModel;
  graderModel?: { provider: string; model: string; reasoning: 'high' };
  promptHash: string;
  fixtureHash: string;
  verdict: Verdict;
  complete: boolean;
  cases: CaseReport[];
  deterministicResults: ReturnType<typeof metrics> & { verdict: Verdict };
  semanticResults?: ReturnType<typeof summarizeDecisionTrackerGrades>;
  instructionAudit?: Awaited<ReturnType<typeof auditDecisionTrackerInstructions>>;
  calibration?: Awaited<ReturnType<typeof calibrateDecisionTrackerGrader>>;
  blockers: string[];
  elapsedMs: number;
};

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function effectiveInstructions(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const database = openConversationProductStore(path.join(directory, 'audit.sqlite'));
  try {
    const tracker = new TrackerStore(database)
      .load('audit')
      .trackers.find(({ id }) => id === trackerId);
    if (!tracker) throw new Error('The production Decision Tracker was not found.');
    return [trackerExtractionInstructions, tracker.instructions].join('\n\n');
  } finally {
    database.close();
  }
}

async function createGrader(directory: string, candidate: ResolvedModel, signal: AbortSignal) {
  const modelId = candidate.model === 'gpt-6.2-sol' ? 'gpt-6-luna' : 'gpt-6.2-sol';
  await mkdir(directory, { recursive: true });
  const createSession = await prepareHostedPiEvaluation(directory, signal, modelId, 'high', {
    subscriptionOnly: true,
  });
  const grader: DecisionTrackerGrader = async (instructions, input, active) => {
    const bounded = AbortSignal.any([active, AbortSignal.timeout(120_000)]);
    bounded.throwIfAborted();
    const { session } = await createSession({ directory, instructions });
    const abort = () => void session.abort();
    bounded.addEventListener('abort', abort, { once: true });
    try {
      bounded.throwIfAborted();
      if (session.thinkingLevel !== 'high')
        throw new Error('Pi did not retain the configured grader reasoning level.');
      await session.prompt(JSON.stringify(input));
      bounded.throwIfAborted();
      const answer = session.messages.findLast(({ role }) => role === 'assistant');
      if (!answer || answer.role !== 'assistant' || answer.stopReason !== 'stop')
        throw new Error('The hosted Pi grader did not complete its response.');
      if (answer.responseModel && answer.responseModel !== createSession.model)
        throw new Error('Hosted Pi returned a different grader model.');
      return answer.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
    } finally {
      bounded.removeEventListener('abort', abort);
      session.dispose();
    }
  };
  return {
    grader,
    model: {
      provider: createSession.provider,
      model: createSession.model,
      reasoning: 'high' as const,
    },
  };
}

/** Qualify Hosted extraction and persistence within a shared Agent Evals run. */
export async function evaluateDecisionTracker(
  options: SuiteOptions,
): Promise<DecisionTrackerReport> {
  const {
    directory,
    signal,
    setup,
    configuration,
    deterministicOnly = false,
    fixtures = decisionTrackerFixtures,
    onProgress,
  } = options;
  const started = performance.now();
  const instructions = await effectiveInstructions(directory);
  const model = 'model' in configuration ? configuration.model : undefined;
  const inputTokens = configuration.inputTokens;
  const hosted = model ? (options.provider ?? hostedConversationProvider)(model) : undefined;
  const blocker = 'blocked' in configuration ? configuration.blocked : undefined;
  const selected = [
    ...fixtures.filter(({ mode }) => mode === 'deterministic'),
    ...(!deterministicOnly ? fixtures.filter(({ mode }) => mode === 'live') : []),
  ];
  const cases = selected.map((fixture) =>
    blockedCase(fixture, inputTokens ?? 0, 'Awaiting execution.'),
  );
  const report: DecisionTrackerReport = {
    setup,
    deterministicOnly,
    inputTokens,
    model,
    promptHash: fingerprint(instructions),
    fixtureHash: fingerprint(selected),
    cases,
    verdict: 'blocked',
    complete: false,
    deterministicResults: { verdict: 'blocked', ...metrics(cases) },
    blockers: [],
    elapsedMs: 0,
  };
  let grader = options.grader;
  let graderPrepared = false;
  const semanticCaseCount = selected.filter(({ mode }) => mode === 'live').length;

  const checkpoint = async (caseId?: string) => {
    report.deterministicResults = {
      verdict: resultVerdict(
        cases.map(({ deterministicVerdict }) => ({ verdict: deterministicVerdict })),
      ),
      ...metrics(cases),
    };
    report.semanticResults = deterministicOnly
      ? undefined
      : summarizeDecisionTrackerGrades(
          cases.flatMap(({ semantic }) => (semantic ? [semantic] : [])),
          semanticCaseCount,
        );
    report.verdict = resultVerdict([
      ...cases,
      ...(!deterministicOnly && report.instructionAudit
        ? [{ verdict: report.instructionAudit.status }]
        : []),
    ]);
    report.elapsedMs = performance.now() - started;
    await onProgress?.(report, caseId);
  };

  const prepareGrader = async () => {
    if (graderPrepared) return;
    graderPrepared = true;
    try {
      if (!grader && model) {
        const prepared = await createGrader(path.join(directory, 'grader'), model, signal);
        grader = prepared.grader;
        report.graderModel = prepared.model;
      }
      if (grader) {
        report.calibration = await calibrateDecisionTrackerGrader(grader, signal);
        report.instructionAudit = await auditDecisionTrackerInstructions(
          instructions,
          grader,
          signal,
        );
        if (report.calibration.status !== 'passed')
          report.blockers.push('Hosted semantic grading failed calibration.');
      }
    } catch (error) {
      report.blockers.push(errorReason(error));
      grader = undefined;
    }
  };

  report.instructionAudit = await auditDecisionTrackerInstructions(instructions);
  for (const [index, fixture] of selected.entries()) {
    if (signal.aborted) {
      cases[index] = blockedCase(
        fixture,
        inputTokens ?? 0,
        'The evaluation deadline expired or the run was cancelled.',
      );
      continue;
    }
    await checkpoint(fixture.id);
    if (inputTokens === undefined || (fixture.mode === 'live' && !hosted)) {
      cases[index] = blockedCase(
        fixture,
        inputTokens ?? 0,
        blocker ?? 'Hosted Tracker configuration is unavailable.',
      );
      await checkpoint();
      continue;
    }
    const identity =
      model && fixture.mode === 'live'
        ? {
            scenario: `decision-tracker:${fixture.id}`,
            thinking: 'low' as const,
            provenanceKey: fingerprint([setup, model, inputTokens, fixture, report.promptHash]),
          }
        : undefined;
    const deadline = identity && options.budget?.(identity);
    const active = AbortSignal.any([signal, AbortSignal.timeout(deadline?.timeoutMs ?? 120_000)]);
    try {
      const result = await runDecisionTrackerCase(fixture, {
        directory: path.join(directory, fixture.id),
        inputTokens,
        provider: fixture.mode === 'live' ? hosted : undefined,
        nativeTimeline:
          options.appRoot && options.nodeExecutable
            ? { appRoot: options.appRoot, nodeExecutable: options.nodeExecutable }
            : undefined,
        signal: active,
      });
      const outcome: CaseReport = {
        ...result,
        verdict:
          fixture.mode === 'live' && result.verdict === 'passed' ? 'blocked' : result.verdict,
        deterministicVerdict: result.verdict,
        deadline,
      };
      cases[index] = outcome;
      await checkpoint();
      if (fixture.mode === 'live' && result.verdict !== 'blocked') {
        await prepareGrader();
        if (!active.aborted && grader && report.calibration?.status === 'passed') {
          outcome.semantic = await gradeDecisionTrackerCase(grader, {
            fixture,
            items: result.checkpoints.at(-1)?.items ?? [],
            requests: result.requests,
            signal: active,
          });
          outcome.verdict = resultVerdict([result, { verdict: outcome.semantic.status }]);
        } else {
          outcome.verdict = resultVerdict([result, { verdict: 'blocked' }]);
          outcome.blocker = 'Calibrated Hosted grading was unavailable or timed out.';
        }
      }
      if (identity && options.learned && !active.aborted)
        await options.learned(identity, {
          elapsedMs: result.elapsedMs,
          success: outcome.verdict === 'passed',
        });
    } catch (error) {
      const previous = cases[index];
      const message = errorReason(error);
      if (previous?.checks.length) {
        previous.blocker = message;
        if (previous.verdict !== 'failed') previous.verdict = 'blocked';
      } else {
        cases[index] = blockedCase(fixture, inputTokens, message);
      }
    }
    await checkpoint();
  }
  report.complete = !signal.aborted;
  await checkpoint();
  return report;
}

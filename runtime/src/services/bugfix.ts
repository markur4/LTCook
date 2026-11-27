import { createHash } from 'node:crypto';
import { sanitizeEvaluationText } from '../evals/diagnostics.js';
import { bugScanBrief } from './bugscan-integration.js';
import type { BugScanFinding, BugScanHunt } from './bugscan.js';

type StageKind =
  | 'prepare'
  | 'implement'
  | 'correct'
  | 'verify'
  | 'review'
  | 'commit'
  | 'push'
  | 'pull-request'
  | 'integrate'
  | 'install'
  | 'recovery'
  | 'issue';

export interface BugFixStage {
  kind: StageKind;
  attempt?: number;
  remedyId?: string;
}

export interface BugFixRemedy {
  id: string;
  kind: 'proper-fix' | 'workaround';
  description: string;
  acceptanceCriteria: string[];
  affectedRevisions: string[];
  finding: BugScanFinding;
  status: 'candidate' | 'ready' | 'resolved' | 'blocked';
  evidence?: string;
}

export interface BugFixRecovery {
  behaviorId: string;
  runningBuild: string;
  runningRevision: string;
  passed: boolean;
}

export interface BugFixActionResult {
  status: 'completed' | 'blocked' | 'failed';
  evidence: string;
  checkout?: string;
  branch?: string;
  sessionId?: string;
  passId?: string;
  verifiedTree?: string;
  reviewedRevision?: string;
  commitRevision?: string;
  integratedRevision?: string;
  pullRequest?: string;
  installedBuild?: string;
  installedRevision?: string;
  recovery?: BugFixRecovery;
}

export type BugFixReconciliation =
  | { state: 'applied'; result: BugFixActionResult }
  | { state: 'not-applied' | 'uncertain'; evidence: string };

export type BugFixTargetEvidence = {
  outcome: 'present' | 'resolved' | 'blocked';
  evidence: string;
};

interface BugFixOperation {
  stage: BugFixStage;
  state: 'pending' | 'settled';
  result?: BugFixActionResult;
}

export interface BugFixBatch {
  id: string;
  huntId: string;
  scope: string;
  targetBranch: string;
  grantRevision: string;
  targetRevision?: string;
  remedies: BugFixRemedy[];
  status: 'queued' | 'running' | 'paused' | 'blocked' | 'failed' | 'budget-exhausted' | 'completed';
  failure?: string;
  failureReport?: string;
  elapsedMs: number;
  activeSince?: number;
  settlementPending?: boolean;
  checkout?: string;
  branch?: string;
  sessionId?: string;
  passId?: string;
  verifiedTree?: string;
  reviewedRevision?: string;
  commitRevision?: string;
  integratedRevision?: string;
  pullRequest?: string;
  installedBuild?: string;
  installedRevision?: string;
  recoveredRemedies: string[];
  operations: BugFixOperation[];
}

export interface BugFixState {
  batches: BugFixBatch[];
}

export interface BugFixOptions {
  load(): BugFixState | undefined;
  save(state: BugFixState): void;
  authorize(batch: BugFixBatch, stage: BugFixStage, remedy?: BugFixRemedy): boolean;
  targetRevision(batch: BugFixBatch, signal: AbortSignal): Promise<string>;
  revalidate(
    batch: BugFixBatch,
    remedy: BugFixRemedy,
    targetRevision: string,
    signal: AbortSignal,
  ): Promise<BugFixTargetEvidence>;
  perform(batch: BugFixBatch, stage: BugFixStage, signal: AbortSignal): Promise<BugFixActionResult>;
  reconcile(
    batch: BugFixBatch,
    stage: BugFixStage,
    signal: AbortSignal,
  ): Promise<BugFixReconciliation>;
  reportFailure?(batch: BugFixBatch, brief: string, signal: AbortSignal): Promise<string>;
  settle?(batch: BugFixBatch): Promise<void>;
  now?: () => number;
  budgetMs?: number;
  corrections?: number;
}

const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const maxBudgetMs = 45 * 60_000;
const localObservation = new Set<StageKind>(['install', 'recovery']);

function detail(value: string): string {
  return sanitizeEvaluationText(value) || 'No additional evidence was recorded.';
}

function stageKey({ kind, attempt, remedyId }: BugFixStage): string {
  return JSON.stringify([kind, attempt, remedyId]);
}

function candidates(hunt: BugScanHunt): BugFixRemedy[] {
  return hunt.findings.flatMap((finding, index) => {
    const remedy = finding.remedy;
    if (!remedy || remedy.kind === 'operational' || finding.confidence !== 'demonstrated')
      return [];
    const revisions = finding.groupIds.map(
      (id) => hunt.groups.find((group) => group.id === id)?.sourceRevision,
    );
    if (
      !revisions.length ||
      revisions.some((revision) => !revision || !revisionPattern.test(revision))
    )
      return [];
    return [
      {
        id: `${hunt.id}:${index + 1}`,
        kind: remedy.kind,
        description: remedy.description,
        acceptanceCriteria: remedy.acceptanceCriteria,
        affectedRevisions: [
          ...new Set(revisions.filter((revision): revision is string => Boolean(revision))),
        ],
        finding: {
          ...finding,
          technicalDebt: finding.technicalDebt.filter(({ decision }) => decision === 'immediate'),
        },
        status: 'candidate',
      },
    ];
  });
}

class StageStopped extends Error {
  constructor(
    readonly status: 'blocked' | 'failed',
    evidence: string,
  ) {
    super(evidence);
  }
}

function requireEvidence(result: BugFixActionResult): void {
  if (result.status !== 'completed') throw new StageStopped(result.status, result.evidence);
}

/** Checkpoints the same Pass before invoking a workflow or making a delivery change. */
export class BugFixService {
  private readonly state: BugFixState;
  private readonly now: () => number;
  private readonly budgetMs: number;
  private readonly corrections: number;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closed = false;

  constructor(private readonly options: BugFixOptions) {
    this.now = options.now ?? Date.now;
    this.budgetMs = Math.max(1, options.budgetMs ?? maxBudgetMs);
    this.corrections = Math.max(0, Math.min(2, Math.trunc(options.corrections ?? 2)));
    this.state = options.load() ?? { batches: [] };
    for (const batch of this.state.batches) {
      if (batch.activeSince !== undefined) {
        batch.elapsedMs += Math.max(0, this.now() - batch.activeSince);
        delete batch.activeSince;
        if (options.settle && batch.checkout) batch.settlementPending = true;
      }
      if (batch.status === 'running') batch.status = 'queued';
    }
    this.persist();
  }

  list(): readonly BugFixBatch[] {
    return structuredClone(this.state.batches);
  }

  enqueue(
    hunt: BugScanHunt,
    input: { targetBranch: string; grantRevision: string },
  ): BugFixBatch | undefined {
    if (this.closed || hunt.status !== 'completed') return undefined;
    const existing = this.state.batches.find(
      ({ huntId, scope }) => huntId === hunt.id && scope === hunt.scope,
    );
    if (existing) return structuredClone(existing);
    const remedies = candidates(structuredClone(hunt));
    if (!remedies.length) return undefined;
    const batch: BugFixBatch = {
      id: createHash('sha256')
        .update(JSON.stringify([hunt.scope, hunt.id]))
        .digest('hex')
        .slice(0, 32),
      huntId: hunt.id,
      scope: hunt.scope,
      ...input,
      status: 'queued',
      remedies,
      elapsedMs: hunt.elapsedMs,
      operations: [],
      recoveredRemedies: [],
    };
    if (!remedies.some((remedy) => this.options.authorize(batch, { kind: 'implement' }, remedy)))
      return undefined;
    this.state.batches.push(batch);
    this.persist();
    this.dispatch();
    return structuredClone(batch);
  }

  dispatch(): void {
    if (this.closed) return;
    for (const batch of this.state.batches) {
      if (batch.status !== 'queued' || this.active.has(batch.scope)) continue;
      const controller = new AbortController();
      batch.status = 'running';
      batch.activeSince = this.now();
      this.persist();
      const done = Promise.resolve()
        .then(() => this.run(batch, controller.signal))
        .finally(() => {
          this.active.delete(batch.scope);
          this.dispatch();
        });
      this.active.set(batch.scope, { controller, done });
    }
  }

  pause(id: string): void {
    const batch = this.state.batches.find((item) => item.id === id);
    if (!batch || (batch.status !== 'running' && batch.status !== 'queued')) return;
    const running = batch.status === 'running';
    batch.status = 'paused';
    this.persist();
    if (running) this.active.get(batch.scope)?.controller.abort();
  }

  resume(id: string): void {
    const batch = this.state.batches.find((item) => item.id === id);
    if (!batch || !['paused', 'blocked', 'failed', 'budget-exhausted'].includes(batch.status))
      return;
    batch.status = 'queued';
    delete batch.failure;
    this.persist();
    this.dispatch();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.all([...this.active.values()].map(({ done }) => done));
  }

  private persist(): void {
    this.options.save(structuredClone(this.state));
  }

  private async reconcile(
    batch: BugFixBatch,
    operation: BugFixOperation,
    signal: AbortSignal,
  ): Promise<void> {
    const observed = await this.options.reconcile(batch, operation.stage, signal);
    if (observed.state === 'uncertain') throw new StageStopped('blocked', observed.evidence);
    if (observed.state === 'not-applied' && !observed.evidence.trim())
      throw new StageStopped('blocked', 'The earlier operation could not be reconciled.');
    if (observed.state === 'applied') this.apply(batch, operation, observed.result);
    else batch.operations.splice(batch.operations.indexOf(operation), 1);
    this.persist();
  }

  private async stage(batch: BugFixBatch, stage: BugFixStage, signal: AbortSignal) {
    signal.throwIfAborted();
    const previous = batch.operations.find(
      ({ stage: existing }) => stageKey(existing) === stageKey(stage),
    );
    if (previous?.result) return previous.result;
    if (!localObservation.has(stage.kind) && !this.options.authorize(batch, stage))
      throw new StageStopped('blocked', `The standing grant no longer authorizes ${stage.kind}.`);
    const operation: BugFixOperation = { stage, state: 'pending' };
    batch.operations.push(operation);
    this.persist();
    const result = await this.options.perform(structuredClone(batch), stage, signal);
    if (result.status === 'blocked') {
      // > A blocked result asserts the operation did not change external state.
      batch.operations.splice(batch.operations.indexOf(operation), 1);
      this.persist();
    } else {
      this.apply(batch, operation, result);
    }
    return result;
  }

  private apply(batch: BugFixBatch, operation: BugFixOperation, result: BugFixActionResult): void {
    const { kind, remedyId } = operation.stage;
    const safe = { ...result, evidence: detail(result.evidence) };
    operation.state = 'settled';
    operation.result = safe;
    if (result.status === 'completed') {
      if (kind === 'prepare') {
        batch.checkout = result.checkout;
        batch.branch = result.branch;
      }
      if (kind === 'implement' || kind === 'correct') {
        batch.sessionId = result.sessionId ?? batch.sessionId;
        batch.passId = result.passId ?? batch.passId;
      }
      if (kind === 'verify') batch.verifiedTree = result.verifiedTree;
      if (kind === 'review') batch.reviewedRevision = result.reviewedRevision;
      if (kind === 'commit') batch.commitRevision = result.commitRevision;
      if (kind === 'pull-request') batch.pullRequest = result.pullRequest;
      if (kind === 'integrate') batch.integratedRevision = result.integratedRevision;
      if (kind === 'install' && result.installedRevision === batch.integratedRevision) {
        batch.installedRevision = result.installedRevision;
        batch.installedBuild = result.installedBuild;
      }
      const proof = result.recovery;
      if (
        kind === 'recovery' &&
        remedyId &&
        proof?.passed &&
        proof.behaviorId === remedyId &&
        batch.installedBuild &&
        proof.runningBuild === batch.installedBuild &&
        proof.runningRevision === batch.integratedRevision
      ) {
        if (!batch.recoveredRemedies.includes(remedyId)) batch.recoveredRemedies.push(remedyId);
      }
    }
    this.persist();
  }

  private async select(batch: BugFixBatch, signal: AbortSignal): Promise<void> {
    if (batch.checkout) return;
    const current = await this.options.targetRevision(batch, signal);
    if (!revisionPattern.test(current))
      throw new StageStopped('blocked', 'The current target revision is unavailable.');
    batch.targetRevision = current;
    for (const remedy of batch.remedies) {
      signal.throwIfAborted();
      if (!this.options.authorize(batch, { kind: 'implement' }, remedy)) {
        remedy.status = 'blocked';
        remedy.evidence = 'The standing grant does not cover this remedy.';
        continue;
      }
      try {
        const evidence = await this.options.revalidate(batch, remedy, current, signal);
        remedy.status =
          evidence.outcome === 'present' && evidence.evidence.trim()
            ? 'ready'
            : evidence.outcome === 'resolved' && evidence.evidence.trim()
              ? 'resolved'
              : 'blocked';
        remedy.evidence = detail(evidence.evidence);
      } catch (error) {
        signal.throwIfAborted();
        remedy.status = 'blocked';
        remedy.evidence = detail(
          error instanceof Error ? error.message : 'Revalidation did not complete.',
        );
      }
      this.persist();
    }
  }

  private async execute(batch: BugFixBatch, signal: AbortSignal): Promise<void> {
    await this.select(batch, signal);
    const ready = batch.remedies.filter(({ status }) => status === 'ready');
    if (!ready.length) {
      if (batch.remedies.every(({ status }) => status === 'resolved')) return;
      throw new StageStopped(
        'blocked',
        'None of the remedies has confirmed target evidence and authorization.',
      );
    }
    const conflict = this.state.batches.some(
      (other) =>
        other !== batch &&
        other.scope === batch.scope &&
        (other.settlementPending ||
          other.operations.some(
            ({ state, stage }) => state === 'pending' && !localObservation.has(stage.kind),
          )),
    );
    if (conflict)
      throw new StageStopped(
        'blocked',
        'An earlier Pass has an unreconciled action in this repository.',
      );
    if (!batch.checkout) requireEvidence(await this.stage(batch, { kind: 'prepare' }, signal));
    if (!batch.checkout)
      throw new StageStopped('blocked', 'The approved checkout was not established.');
    let reviewed = false;
    for (let attempt = 0; attempt <= this.corrections; attempt++) {
      const implementation = await this.stage(
        batch,
        { kind: attempt ? 'correct' : 'implement', attempt },
        signal,
      );
      if (implementation.status === 'failed' && attempt < this.corrections) continue;
      requireEvidence(implementation);
      if (!batch.passId)
        throw new StageStopped('blocked', 'The workflow did not identify the shared Pass.');
      const verification = await this.stage(batch, { kind: 'verify', attempt }, signal);
      if (verification.status === 'failed' && attempt < this.corrections) continue;
      requireEvidence(verification);
      if (!revisionPattern.test(verification.verifiedTree ?? ''))
        throw new StageStopped('blocked', 'Verification did not identify the checked tree.');
      requireEvidence(await this.stage(batch, { kind: 'commit', attempt }, signal));
      if (!revisionPattern.test(batch.commitRevision ?? ''))
        throw new StageStopped('blocked', 'The verified repair commit was not established.');
      requireEvidence(await this.stage(batch, { kind: 'push', attempt }, signal));
      requireEvidence(await this.stage(batch, { kind: 'pull-request' }, signal));
      if (!batch.pullRequest)
        throw new StageStopped('blocked', 'The draft pull request was not established.');
      const review = await this.stage(batch, { kind: 'review', attempt }, signal);
      if (review.status === 'failed' && attempt < this.corrections) continue;
      requireEvidence(review);
      reviewed =
        revisionPattern.test(verification.verifiedTree ?? '') &&
        verification.verifiedTree === review.reviewedRevision;
      if (reviewed) break;
      throw new StageStopped('blocked', 'Review and verification did not establish the same tree.');
    }
    if (!reviewed) throw new StageStopped('failed', 'The Pass did not produce an accepted review.');
    requireEvidence(await this.stage(batch, { kind: 'integrate' }, signal));
    if (!revisionPattern.test(batch.integratedRevision ?? ''))
      throw new StageStopped('blocked', 'Integration did not establish a target revision.');
    await this.observeRecovery(batch, ready, signal);
  }

  private async observeRecovery(
    batch: BugFixBatch,
    repairs: BugFixRemedy[],
    signal: AbortSignal,
  ): Promise<void> {
    if (!batch.installedBuild) {
      const installation = await this.stage(batch, { kind: 'install' }, signal);
      if (installation.status !== 'completed' || !batch.installedBuild) {
        this.clearObservation(batch, { kind: 'install' });
        throw new StageStopped(
          'blocked',
          'Integration completed. A repaired running build has not been observed.',
        );
      }
    }
    for (const { id } of repairs) {
      if (batch.recoveredRemedies.includes(id)) continue;
      const stage: BugFixStage = { kind: 'recovery', remedyId: id };
      await this.stage(batch, stage, signal);
      if (!batch.recoveredRemedies.includes(id)) this.clearObservation(batch, stage);
    }
    if (repairs.some(({ id }) => !batch.recoveredRemedies.includes(id)))
      throw new StageStopped(
        'blocked',
        'Integration completed. The formerly failing behavior has not been verified on the repaired running build.',
      );
  }

  private clearObservation(batch: BugFixBatch, stage: BugFixStage): void {
    batch.operations = batch.operations.filter(
      (operation) => stageKey(operation.stage) !== stageKey(stage),
    );
    this.persist();
  }

  private async run(batch: BugFixBatch, outerSignal: AbortSignal): Promise<void> {
    const timeLeft = Math.max(0, this.budgetMs - batch.elapsedMs);
    const budget = AbortSignal.timeout(Math.ceil(timeLeft));
    const signal = AbortSignal.any([outerSignal, budget]);
    let canSettle = !batch.settlementPending;
    let complete = false;
    try {
      if (batch.settlementPending) {
        await this.settle(batch);
        canSettle = true;
      }
      for (const operation of batch.operations.filter(({ state }) => state === 'pending')) {
        outerSignal.throwIfAborted();
        await this.reconcile(
          batch,
          operation,
          AbortSignal.any([outerSignal, AbortSignal.timeout(10_000)]),
        );
      }
      if (timeLeft === 0)
        throw new StageStopped('blocked', 'The active execution budget has been exhausted.');
      await this.execute(batch, signal);
      signal.throwIfAborted();
      complete = true;
    } catch (error) {
      if (batch.status === 'paused') return;
      if (this.closed && outerSignal.aborted) {
        batch.status = 'queued';
        return;
      }
      batch.status =
        budget.aborted || timeLeft === 0
          ? 'budget-exhausted'
          : error instanceof StageStopped
            ? error.status
            : batch.operations.some(({ state }) => state === 'pending')
              ? 'blocked'
              : 'failed';
      batch.failure = detail(error instanceof Error ? error.message : 'BugFix could not complete.');
      if (
        this.options.reportFailure &&
        canSettle &&
        !signal.aborted &&
        (!batch.integratedRevision || batch.status === 'failed')
      ) {
        try {
          batch.failureReport = detail(
            await this.options.reportFailure(
              structuredClone(batch),
              bugScanBrief('failure-report'),
              signal,
            ),
          );
        } catch {
          // > Keep the durable operation and failure evidence if reporting is unavailable.
        }
      }
    } finally {
      if (canSettle && this.options.settle && batch.checkout) {
        try {
          await this.settle(batch);
        } catch (error) {
          batch.status = 'blocked';
          batch.failure = detail(
            error instanceof Error ? error.message : 'The native Pass could not be settled.',
          );
        }
      }
      if (complete && !batch.settlementPending && batch.status === 'running')
        batch.status = 'completed';
      batch.elapsedMs += Math.max(0, this.now() - (batch.activeSince ?? this.now()));
      delete batch.activeSince;
      this.persist();
    }
  }

  private async settle(batch: BugFixBatch): Promise<void> {
    if (!this.options.settle) return;
    batch.settlementPending = true;
    this.persist();
    await this.options.settle(structuredClone(batch));
    delete batch.settlementPending;
    this.persist();
  }
}

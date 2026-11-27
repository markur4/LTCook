import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeController } from '../core/runtime.js';
import type {
  BugFixAction,
  BugFixAuthorization,
  BugFixRepository,
} from '../core/bugfix-authorization.js';
import type { BugScanService } from './bugscan.js';
import { createBugFixDelivery } from './bugfix-delivery.js';
import {
  BugFixService,
  type BugFixActionResult,
  type BugFixBatch,
  type BugFixRemedy,
  type BugFixStage,
  type BugFixState,
} from './bugfix.js';

const actionForStage: Partial<Record<BugFixStage['kind'], BugFixAction>> = {
  prepare: 'worktree.create',
  implement: 'source.edit',
  correct: 'source.edit',
  verify: 'verify',
  review: 'verify',
  commit: 'git.commit',
  push: 'git.push',
  'pull-request': 'pr.open',
  integrate: 'pr.merge',
  issue: 'issue.write',
};

function repairPaths(remedy: BugFixRemedy): readonly string[] {
  return [...new Set(remedy.finding.repairPaths ?? [])];
}

function blocked(evidence: string): BugFixActionResult {
  return { status: 'blocked', evidence };
}

/** Compose the authorized repair service without exposing authority to the native Team. */
export async function startBugFix(input: {
  runtime: RuntimeController;
  bugScan: BugScanService;
  workspaceRoot: string;
  stateDirectory: string;
  budgetMs: number;
  qualified: () => boolean;
}) {
  const { runtime, bugScan, workspaceRoot, stateDirectory, qualified, budgetMs } = input;
  const worktreeDirectory = path.join(stateDirectory, 'bugfix-worktrees');
  await mkdir(worktreeDirectory, { recursive: true, mode: 0o700 });
  if ((await realpath(worktreeDirectory)) !== worktreeDirectory)
    throw new Error('BugFix worktree directory must not use a symbolic link.');
  let repository: BugFixRepository | undefined;
  let authorization: BugFixAuthorization | undefined;
  function allows(batch: BugFixBatch, action: BugFixAction, remedy: BugFixRemedy, target?: string) {
    const paths = target === undefined ? repairPaths(remedy) : [target];
    return (
      repository &&
      batch.scope === repository.root &&
      (target === undefined || repairPaths(remedy).includes(target)) &&
      authorization?.authorize({
        revision: batch.grantRevision,
        repository,
        targetBranch: batch.targetBranch,
        repairKind: remedy.kind,
        action,
        paths,
      }) === true
    );
  }
  function allowsStage(batch: BugFixBatch, stage: BugFixStage, remedy?: BugFixRemedy): boolean {
    const action = actionForStage[stage.kind];
    if (!action) return true;
    if (remedy) return Boolean(allows(batch, action, remedy));
    const selected = batch.remedies.filter(({ status }) => status === 'ready');
    return (selected.length ? selected : batch.remedies).every((candidate) =>
      allows(batch, action, candidate),
    );
  }
  const delivery = createBugFixDelivery({
    worktreeDirectory,
    qualified,
    expectedRemote: () => repository?.remote,
    authorize: (batch, stage) => {
      if (!allowsStage(batch, stage))
        throw new Error('The standing grant does not authorize this BugFix action.');
    },
    allowedPath: (batch, file) =>
      batch.remedies.some(
        (candidate) =>
          candidate.status === 'ready' && allows(batch, 'source.edit', candidate, file),
      ),
    async recheck(batch, remedy, targetRevision) {
      const hunt = bugScan.list().find(({ id }) => id === batch.huntId);
      const exactFailure = hunt?.groups.some(
        ({ id, sourceRevision, evidence }) =>
          remedy.finding.groupIds.includes(id) &&
          sourceRevision === targetRevision &&
          evidence.some(
            ({ outcome, code }) =>
              outcome === 'failure' ||
              outcome === 'degraded' ||
              code === 'repository-index.stalled',
          ),
      );
      if (exactFailure && remedy.affectedRevisions.every((revision) => revision === targetRevision))
        return {
          outcome: 'present',
          evidence:
            'The confirmed failing operation was observed on this exact target source revision.',
        };
      return {
        outcome: 'blocked',
        evidence:
          'The recorded failure does not establish that the same defect remains on the current target.',
      };
    },
  });
  const verified = await delivery.inspectRepository(workspaceRoot, AbortSignal.timeout(10_000));
  if (!verified.remote)
    throw new Error('Dev mode needs a repository with a verified GitHub origin.');
  repository = { root: verified.root, remote: verified.remote };
  const approved = runtime.bugFixAuthorization(repository);
  authorization = approved;
  const records = runtime.bugHunterRecords<BugFixState>(repository.root, 'bugfix');
  const activeNative = new Map<string, { sessionId: string; passId: string }>();
  async function attach(batch: BugFixBatch, signal: AbortSignal) {
    if (!batch.checkout) throw new Error('BugFix has no authorized shared checkout.');
    const selected = batch.remedies.filter(({ status }) => status === 'ready');
    const native = await runtime.startBugFixPass({
      workspaceRoot: batch.checkout,
      recordWorkspaceRoot: batch.scope,
      huntId: batch.huntId,
      requestId: batch.id,
      tasks: selected.map((remedy) => ({
        id: remedy.id,
        kind: remedy.kind,
        paths: repairPaths(remedy),
        brief: remedy.description,
        acceptance: remedy.acceptanceCriteria.join('\n'),
      })),
      authorize: (action, taskId, file) => {
        const remedy = selected.find(({ id }) => id === taskId);
        return (
          remedy !== undefined &&
          Boolean(allows(batch, action === 'edit' ? 'source.edit' : 'verify', remedy, file))
        );
      },
      signal,
    });
    activeNative.set(batch.id, native);
    return native;
  }
  function finishIntegration(batch: BugFixBatch, result: BugFixActionResult) {
    if (
      result.status === 'completed' &&
      result.integratedRevision &&
      batch.sessionId &&
      batch.passId &&
      batch.reviewedRevision
    ) {
      runtime.completeBugFixPass(batch.sessionId, batch.passId, {
        reviewedTree: batch.reviewedRevision,
        integratedCommit: result.integratedRevision,
      });
    }
    return result;
  }
  const service = new BugFixService({
    ...records,
    budgetMs,
    authorize: allowsStage,
    targetRevision: delivery.targetRevision,
    revalidate: delivery.revalidate,
    async reconcile(batch, stage, signal) {
      const result = await delivery.reconcile(batch, stage, signal);
      if (stage.kind === 'integrate' && result.state === 'applied')
        finishIntegration(batch, result.result);
      return result;
    },
    async perform(batch, stage, signal) {
      if (stage.kind === 'implement') {
        if (!batch.checkout) return blocked('BugFix has no authorized shared checkout.');
        const native = await attach(batch, signal);
        const result = await runtime.awaitBugFixImplementation(
          native.sessionId,
          native.passId,
          signal,
        );
        if (result.completed)
          return {
            status: 'completed',
            evidence: 'The eligible native Tasks completed.',
            ...native,
          };
        return {
          status: 'failed',
          evidence: 'One or more repair Tasks did not complete.',
          ...native,
        };
      }
      if (stage.kind === 'correct') {
        if (!batch.sessionId || !batch.passId) return blocked('No native repair Pass is attached.');
        await attach(batch, signal);
        const prior = batch.operations.findLast(({ result }) => result?.status === 'failed');
        const result = await runtime.retryBugFixImplementation(
          batch.sessionId,
          batch.passId,
          `${batch.id}:${stage.attempt ?? 1}`,
          signal,
          prior?.stage.kind === 'review'
            ? 'review'
            : prior?.stage.kind === 'verify'
              ? 'verification'
              : 'implementation',
          prior?.result?.evidence,
        );
        return result.completed
          ? { status: 'completed', evidence: 'The corrected repair Tasks completed.' }
          : { status: 'failed', evidence: 'One or more correction Tasks did not complete.' };
      }
      if (stage.kind === 'review') {
        if (!batch.sessionId || !batch.passId || !batch.verifiedTree)
          return blocked(
            'The combined verification and native repair Pass are required for review.',
          );
        await attach(batch, signal);
        const result = await runtime.awaitBugFixReview(
          batch.sessionId,
          batch.passId,
          batch.verifiedTree,
          signal,
        );
        return result.outcome === 'accepted'
          ? {
              status: 'completed',
              evidence: 'Independent review accepted the verified tree.',
              reviewedRevision: result.reviewedTree,
            }
          : { status: 'failed', evidence: 'The independent review requested corrections.' };
      }
      if (stage.kind === 'install' || stage.kind === 'recovery')
        return blocked(
          'There is no verified observation of the formerly failing behavior on a repaired running build.',
        );
      const result = await delivery.perform(batch, stage, signal);
      return stage.kind === 'integrate' ? finishIntegration(batch, result) : result;
    },
    async settle(batch) {
      const native =
        activeNative.get(batch.id) ??
        (batch.sessionId && batch.passId
          ? { sessionId: batch.sessionId, passId: batch.passId }
          : undefined);
      if (native) {
        await runtime.haltBugFixPass(native.sessionId, native.passId);
        activeNative.delete(batch.id);
      }
    },
    async reportFailure(batch, brief, signal) {
      const report = await runtime.investigateBugScan({
        workspaceRoot: stateDirectory,
        recordWorkspaceRoot: batch.scope,
        huntId: batch.huntId,
        requestId: `${batch.id}:failure-report`,
        role: 'coordinator',
        brief,
        evidence: { status: batch.status, failure: batch.failure },
        signal,
      });
      return report.summary;
    },
  });
  return {
    service,
    authorization: approved,
    poll() {
      if (bugScan.list().some(({ status }) => status === 'running')) return;
      const grant = approved.current();
      if (!grant) return;
      for (const hunt of bugScan.list())
        service.enqueue(hunt, { targetBranch: grant.targetBranch, grantRevision: grant.revision });
      service.dispatch();
    },
  };
}

import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeController } from '../core/runtime.js';
import type {
  BugFixAction,
  BugFixAuthorization,
  BugFixRepository,
} from '../core/bugfix-authorization.js';
import { openRepositoryWorkspace, type RepositoryWorkspace } from '../repository/workspace.js';
import type { BugScanHunt, BugScanService } from './bugscan.js';
import { repositoryIndexWorkspaceId, type RepositoryIndexDiagnostic } from './repository-index.js';
import { createBugFixDelivery } from './bugfix-delivery.js';
import { createBugHunterIssueReporter, type BugHunterIssueEntry } from './bughunter-issues.js';
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

export function indexProgressProof(
  hunt: BugScanHunt | undefined,
  remedy: BugFixRemedy,
  diagnostic: RepositoryIndexDiagnostic,
): boolean {
  if (
    diagnostic.code !== 'repository-index.completed' ||
    diagnostic.outcome !== 'success' ||
    !diagnostic.generation ||
    !Number.isFinite(diagnostic.elapsedMs) ||
    diagnostic.elapsedMs < 0
  )
    return false;
  return (
    remedy.finding.groupIds.every((id) => {
      const group = hunt?.groups.find((candidate) => candidate.id === id);
      return (
        group?.component === 'repository-index' &&
        group.evidence.length > 0 &&
        group.evidence.every(
          ({ code, workspaceId, operationId, progressDeadlineMs }) =>
            code === 'repository-index.stalled' &&
            workspaceId === diagnostic.workspaceId &&
            operationId !== diagnostic.operationId &&
            progressDeadlineMs !== undefined &&
            diagnostic.elapsedMs < progressDeadlineMs,
        )
      );
    }) && remedy.finding.groupIds.length > 0
  );
}

/** Compose the authorized repair service without exposing authority to the native Team. */
export async function startBugFix(input: {
  runtime: RuntimeController;
  bugScan: BugScanService;
  workspaceRoot: string;
  stateDirectory: string;
  budgetMs: number;
  qualified: () => boolean;
  canStart?: () => boolean;
  readPublishedIndex?: (workspace: RepositoryWorkspace) => Promise<string | undefined>;
  runningBuild?: { identity: string; sourceRevision: string };
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
  const configuredRepository = repository;
  const workspace = await openRepositoryWorkspace(repository.root);
  const indexWorkspaceId = repositoryIndexWorkspaceId(workspace);
  let indexObservation: RepositoryIndexDiagnostic | undefined;
  const recoveryAttempts = new Map<string, string>();
  const issueRecords = runtime.bugHunterRecords<BugHunterIssueEntry[]>(
    repository.root,
    'issue-publication',
  );
  const issueReporter = createBugHunterIssueReporter({
    ...issueRecords,
    repository: {
      root: repository.root,
      slug: new URL(repository.remote).pathname.slice(1),
    },
    authorize(draft) {
      const grant = approved.current();
      if (
        !grant ||
        !approved.authorize({
          revision: grant.revision,
          repository: configuredRepository,
          targetBranch: grant.targetBranch,
          action: 'issue.write',
        })
      )
        return false;
      return bugScan
        .list()
        .some((hunt) =>
          hunt.findings.some(
            (finding, index) =>
              draft.id === `${hunt.id}:${index + 1}` &&
              finding.confidence === 'demonstrated' &&
              (finding.remedy !== undefined ||
                finding.technicalDebt.some(({ decision }) => decision === 'deferred')),
          ),
        );
    },
  });
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
  const correctionRequestId = (batch: BugFixBatch, stage: BugFixStage) =>
    `${batch.id}:${stage.attempt ?? 1}`;
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
    canStart: input.canStart,
    authorize: allowsStage,
    targetRevision: delivery.targetRevision,
    revalidate: delivery.revalidate,
    async reconcile(batch, stage, signal) {
      if (stage.kind === 'implement' || stage.kind === 'correct' || stage.kind === 'review') {
        if (!batch.checkout)
          return { state: 'uncertain', evidence: 'The expected shared checkout is unavailable.' };
        const recorded = runtime.observeBugFixPass({
          recordWorkspaceRoot: batch.scope,
          requestId: batch.id,
          workspaceRoot: batch.checkout,
          reviewedTree: batch.verifiedTree,
          correctionRequestId:
            stage.kind === 'correct' ? correctionRequestId(batch, stage) : undefined,
        });
        if (stage.kind === 'implement') {
          if (!recorded)
            return { state: 'not-applied', evidence: 'No native implementation Pass was created.' };
          if (recorded.implementation)
            return {
              state: 'applied',
              result: {
                status: recorded.implementation,
                evidence: 'Reconciled the persisted native repair Task outcomes.',
                sessionId: recorded.sessionId,
                passId: recorded.passId,
              },
            };
        } else if (stage.kind === 'correct') {
          if (recorded && !recorded.correctionRecorded)
            return { state: 'not-applied', evidence: 'No native correction was prepared.' };
          if (recorded?.correction)
            return {
              state: 'applied',
              result: {
                status: recorded.correction,
                evidence: 'Reconciled the persisted native correction Task outcomes.',
              },
            };
        } else if (recorded && !recorded.reviewRecorded) {
          return { state: 'not-applied', evidence: 'No native review evidence was registered.' };
        } else if (recorded?.review && batch.verifiedTree) {
          return {
            state: 'applied',
            result:
              recorded.review === 'accepted'
                ? {
                    status: 'completed',
                    evidence: 'Reconciled native review acceptance for the verified tree.',
                    reviewedRevision: batch.verifiedTree,
                  }
                : { status: 'failed', evidence: 'The recorded review requested corrections.' },
          };
        }
        return { state: 'uncertain', evidence: 'The native Task outcome remains uncertain.' };
      }
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
          correctionRequestId(batch, stage),
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
          batch.targetRevision,
        );
        return result.outcome === 'accepted'
          ? {
              status: 'completed',
              evidence: 'Independent review accepted the verified tree.',
              reviewedRevision: result.reviewedTree,
            }
          : { status: 'failed', evidence: 'The independent review requested corrections.' };
      }
      if (stage.kind === 'install') {
        const build = input.runningBuild;
        return build && build.sourceRevision === batch.integratedRevision
          ? {
              status: 'completed',
              evidence: 'The running build provenance matches the integrated revision.',
              installedBuild: build.identity,
              installedRevision: build.sourceRevision,
            }
          : blocked('A running build bound to the integrated revision has not been observed.');
      }
      if (stage.kind === 'recovery') {
        const build = input.runningBuild;
        const remedy = batch.remedies.find(({ id }) => id === stage.remedyId);
        const hunt = bugScan.list().find(({ id }) => id === batch.huntId);
        const observation = indexObservation;
        if (
          build &&
          build.identity === batch.installedBuild &&
          build.sourceRevision === batch.integratedRevision &&
          remedy &&
          observation?.generation &&
          indexProgressProof(hunt, remedy, observation)
        ) {
          await workspace.assertUnchanged();
          const generation = await input.readPublishedIndex?.(workspace);
          signal.throwIfAborted();
          if (generation !== observation.generation || indexObservation !== observation)
            return blocked('The current usable index generation could not confirm recovery.');
          return {
            status: 'completed',
            evidence: `Managed index reconciliation refreshed the affected workspace before its deadline (operation ${observation.operationId}).`,
            recovery: {
              behaviorId: remedy.id,
              runningBuild: build.identity,
              runningRevision: build.sourceRevision,
              passed: true,
            },
          };
        }
        return blocked(
          'There is no verified observation of the formerly failing behavior on a repaired running build.',
        );
      }
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
    issueReporter,
    observeIndexDiagnostic(diagnostic: RepositoryIndexDiagnostic) {
      if (diagnostic.workspaceId !== indexWorkspaceId) return;
      if (diagnostic.code === 'repository-index.completed' && diagnostic.generation)
        indexObservation = diagnostic;
      else if (
        diagnostic.outcome === 'failure' ||
        diagnostic.outcome === 'blocked' ||
        diagnostic.code === 'repository-index.stalled'
      )
        indexObservation = undefined;
    },
    poll() {
      const hunts = bugScan.list();
      if (hunts.some(({ status }) => status === 'running')) return;
      const grant = approved.current();
      if (!grant) return;
      for (const hunt of hunts)
        service.enqueue(hunt, { targetBranch: grant.targetBranch, grantRevision: grant.revision });
      const observation = indexObservation;
      for (const batch of service.list()) {
        if (
          batch.status !== 'blocked' ||
          !batch.integratedRevision ||
          batch.integratedRevision !== input.runningBuild?.sourceRevision
        )
          continue;
        if (!batch.installedBuild) {
          service.resume(batch.id);
        } else if (
          observation &&
          recoveryAttempts.get(batch.id) !== observation.operationId &&
          batch.remedies.some(
            (remedy) =>
              remedy.status === 'ready' &&
              !batch.recoveredRemedies.includes(remedy.id) &&
              indexProgressProof(
                hunts.find(({ id }) => id === batch.huntId),
                remedy,
                observation,
              ),
          )
        ) {
          recoveryAttempts.set(batch.id, observation.operationId);
          service.resume(batch.id);
        }
      }
      service.dispatch();
    },
  };
}

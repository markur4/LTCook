import { expect, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BugFixService,
  type BugFixActionResult,
  type BugFixBatch,
  type BugFixOptions,
  type BugFixStage,
  type BugFixState,
} from '../../../runtime/src/services/bugfix.js';
import type { BugScanHunt } from '../../../runtime/src/services/bugscan.js';

const source = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const merged = 'c'.repeat(40);
const repairedBuild = 'deployment:' + 'd'.repeat(64);
const grant = { targetBranch: 'main', grantRevision: 'grant' };

function hunt(id = 'hunt'): BugScanHunt {
  return {
    id,
    scope: '/fixture',
    createdAt: 0,
    automatic: false,
    status: 'completed',
    elapsedMs: 0,
    groups: [{ id: 'group', component: 'index', sourceRevision: source, evidence: [] }],
    checkpoints: {},
    findings: [
      {
        groupIds: ['group'],
        confidence: 'demonstrated',
        violatedExpectation: 'Index completes.',
        mechanism: 'The lease remains held.',
        cause: 'Release skips failure.',
        contributingConditions: [],
        evidence: ['Forced rejection retained the lease.'],
        remedy: {
          kind: 'proper-fix',
          description: 'Release the index lease on rejection.',
          acceptanceCriteria: ['The queued refresh succeeds after rejection.'],
        },
        technicalDebt: [
          {
            problem: 'Keep release scoped.',
            decision: 'immediate',
            rationale: 'Required for repair.',
          },
          { problem: 'Refactor leases.', decision: 'deferred', rationale: 'Separate work.' },
        ],
      },
    ],
  };
}

function success(stage: BugFixStage): BugFixActionResult {
  const base: BugFixActionResult = { status: 'completed', evidence: 'Observed at the fixture.' };
  switch (stage.kind) {
    case 'prepare':
      return { ...base, checkout: '/isolated-fixture', branch: 'bugfix/fixture' };
    case 'implement':
    case 'correct':
      return { ...base, passId: 'pass', sessionId: 'session' };
    case 'verify':
      return { ...base, verifiedTree: tree };
    case 'review':
      return { ...base, reviewedRevision: tree };
    case 'commit':
      return { ...base, commitRevision: source };
    case 'pull-request':
      return { ...base, pullRequest: 'https://example.invalid/pull/1' };
    case 'integrate':
      return { ...base, integratedRevision: merged };
    case 'install':
      return { ...base, installedBuild: repairedBuild, installedRevision: merged };
    case 'recovery':
      return {
        ...base,
        recovery: {
          behaviorId: stage.remedyId!,
          runningBuild: repairedBuild,
          runningRevision: merged,
          passed: true,
        },
      };
    default:
      return base;
  }
}

function fixture(options: Partial<BugFixOptions> = {}) {
  let state: BugFixState | undefined;
  const stages: BugFixStage[] = [];
  const defaults: BugFixOptions = {
    load: () => state,
    save: (snapshot) => {
      state = snapshot;
    },
    authorize: () => true,
    targetRevision: async () => source,
    revalidate: async () => ({ outcome: 'present', evidence: 'Reproduced on the current main.' }),
    perform: async (_batch, stage) => {
      stages.push(stage);
      return success(stage);
    },
    reconcile: async () => ({ state: 'not-applied', evidence: 'Checked the fixture state.' }),
    ...options,
  };
  return { open: () => new BugFixService(defaults), stages };
}

async function settled(service: BugFixService, id = 'hunt'): Promise<BugFixBatch> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const batch = service.list().find(({ huntId }) => huntId === id);
    if (batch && batch.status !== 'running' && batch.status !== 'queued') return batch;
    await delay(5);
  }
  throw new Error('BugFix did not settle.');
}

test('keeps deferred findings outside the repair batch and skips fixes proven to be upstream', async () => {
  const input = hunt();
  input.findings.push(structuredClone(input.findings[0]!));
  const f = fixture({
    revalidate: async (_batch, remedy) => ({
      outcome: remedy.id.endsWith(':2') ? 'resolved' : 'present',
      evidence: 'Checked the current target revision.',
    }),
  });
  const service = f.open();
  try {
    service.enqueue(input, grant);
    const batch = await settled(service);
    expect(batch.status).toBe('completed');
    expect(batch.remedies.map(({ status }) => status)).toEqual(['ready', 'resolved']);
    expect(batch.remedies[0]?.finding.technicalDebt.map(({ decision }) => decision)).toEqual([
      'immediate',
    ]);
    expect(batch.recoveredRemedies).toEqual(['hunt:1']);
    expect(f.stages.filter(({ kind }) => kind === 'prepare')).toHaveLength(1);
  } finally {
    await service.close();
  }
});

test('records integration while withholding recovery until the same behavior passes on the repaired build', async () => {
  let proofMatches = false;
  const f = fixture({
    perform: async (_batch, stage) => {
      if (stage.kind === 'recovery' && !proofMatches)
        return {
          ...success(stage),
          recovery: {
            behaviorId: stage.remedyId!,
            runningBuild: 'other-build',
            runningRevision: merged,
            passed: true,
          },
        };
      return success(stage);
    },
  });
  const service = f.open();
  try {
    const job = service.enqueue(hunt(), grant)!;
    const blocked = await settled(service);
    expect(blocked).toMatchObject({
      status: 'blocked',
      integratedRevision: merged,
      recoveredRemedies: [],
    });
    proofMatches = true;
    service.resume(job.id);
    expect(await settled(service)).toMatchObject({
      status: 'completed',
      recoveredRemedies: ['hunt:1'],
    });
  } finally {
    await service.close();
  }
});

test('persists an uncertain publication and reconciles it on restart before doing more delivery', async () => {
  let publishCalls = 0;
  let confirmed = false;
  const f = fixture({
    perform: async (_batch, stage) => {
      if (stage.kind === 'push') {
        publishCalls++;
        throw new Error('The connection closed after sending the request.');
      }
      return success(stage);
    },
    reconcile: async (_batch, stage) =>
      confirmed && stage.kind === 'push'
        ? { state: 'applied', result: success(stage) }
        : { state: 'uncertain', evidence: 'Remote state is unknown.' },
  });
  const initial = f.open();
  const job = initial.enqueue(hunt(), grant)!;
  expect((await settled(initial)).status).toBe('blocked');
  await initial.close();

  const resumed = f.open();
  try {
    resumed.resume(job.id);
    expect((await settled(resumed)).status).toBe('blocked');
    expect(publishCalls).toBe(1);
    confirmed = true;
    resumed.resume(job.id);
    expect((await settled(resumed)).status).toBe('completed');
    expect(publishCalls).toBe(1);
  } finally {
    await resumed.close();
  }
});

test('applies the shared budget and stops when a standing grant is revoked between actions', async () => {
  let allowed = true;
  const f = fixture({
    authorize: () => allowed,
    budgetMs: 500,
    perform: async (_batch, stage) => {
      if (stage.kind === 'prepare') allowed = false;
      return success(stage);
    },
  });
  const service = f.open();
  try {
    service.enqueue({ ...hunt('used'), elapsedMs: 500 }, grant);
    expect((await settled(service, 'used')).status).toBe('budget-exhausted');
    service.enqueue(hunt(), grant);
    expect(await settled(service)).toMatchObject({
      status: 'blocked',
      checkout: '/isolated-fixture',
    });
    expect((await settled(service)).passId).toBeUndefined();
  } finally {
    await service.close();
  }
});

test('publishes a draft before review and publishes corrections on the same Pass', async () => {
  const operations: string[] = [];
  const f = fixture({
    perform: async (batch, stage) => {
      operations.push(stage.kind);
      if (stage.kind === 'review') {
        expect(batch.pullRequest).toBe('https://example.invalid/pull/1');
        if (stage.attempt === 0)
          return { status: 'failed', evidence: 'Reviewer requested correction.' };
      }
      if (stage.kind === 'correct') expect(batch.passId).toBe('pass');
      return success(stage);
    },
  });
  const service = f.open();
  try {
    service.enqueue(hunt(), grant);
    expect((await settled(service)).status).toBe('completed');
    expect(operations).toEqual([
      'prepare',
      'implement',
      'verify',
      'commit',
      'push',
      'pull-request',
      'review',
      'correct',
      'verify',
      'commit',
      'push',
      'review',
      'integrate',
      'install',
      'recovery',
    ]);
  } finally {
    await service.close();
  }
});

test('retains the native Pass on initial implementation failure for authorized correction', async () => {
  const f = fixture({
    perform: async (batch, stage) => {
      if (stage.kind === 'implement')
        return { ...success(stage), status: 'failed', evidence: 'Implementation failed.' };
      if (stage.kind === 'correct') {
        expect(batch.sessionId).toBe('session');
        expect(batch.passId).toBe('pass');
      }
      return success(stage);
    },
  });
  const service = f.open();
  try {
    service.enqueue(hunt(), grant);
    expect(await settled(service)).toMatchObject({ status: 'completed', passId: 'pass' });
  } finally {
    await service.close();
  }
});

test('a previously blocked Pass releases the scope so independent work can run', async () => {
  const f = fixture({
    revalidate: async (batch) =>
      batch.huntId === 'first'
        ? { outcome: 'blocked', evidence: 'Current source lacks evidence.' }
        : { outcome: 'present', evidence: 'Current source reproduces the defect.' },
  });
  const service = f.open();
  try {
    service.enqueue(hunt('first'), grant);
    service.enqueue(hunt('second'), grant);
    expect((await settled(service, 'first')).status).toBe('blocked');
    expect((await settled(service, 'second')).status).toBe('completed');
  } finally {
    await service.close();
  }
});

test('keeps the execution slot until the native Pass settles', async () => {
  let reachedSettlement = false;
  let release!: () => void;
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({
    settle: async (batch) => {
      if (batch.huntId !== 'first') return;
      reachedSettlement = true;
      await finished;
    },
  });
  const service = f.open();
  try {
    service.enqueue(hunt('first'), grant);
    service.enqueue(hunt('second'), grant);
    for (let attempt = 0; attempt < 100 && !reachedSettlement; attempt++) await delay(5);
    expect(reachedSettlement).toBe(true);
    expect(service.list().map(({ status }) => status)).toEqual(['running', 'queued']);
    release();
    expect((await settled(service, 'second')).status).toBe('completed');
  } finally {
    release();
    await service.close();
  }
});

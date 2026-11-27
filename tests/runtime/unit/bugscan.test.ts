import { expect, test } from 'bun:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BugScanService,
  type BugScanRequest,
  type BugScanState,
} from '../../../runtime/src/services/bugscan.js';

const now = Date.parse('2026-11-20T12:00:00Z');
const build = `deployment:${'a'.repeat(64)}`;
const first = 'workspace-one';
const second = 'workspace-two';

function event(operationId: string, fields: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    eventId: `record-${operationId}`,
    operationId,
    timestamp: new Date(now).toISOString(),
    code: 'repository-index.retrying',
    component: 'repository-index',
    outcome: 'failure',
    severity: 'warn',
    buildIdentity: build,
    ...fields,
  });
}

function answer(request: BugScanRequest) {
  const groups = request.role === 'investigator' ? request.groups.slice(0, 1) : request.groups;
  return {
    findings: [
      {
        groupIds: groups.map(({ id }) => id),
        confidence: 'demonstrated',
        violatedExpectation: 'Refresh should publish a generation.',
        mechanism: 'The worker exits before publication.',
        cause: 'The builder rejects the current format.',
        contributingConditions: ['A refresh started while artifacts were being staged.'],
        evidence: ['No output was available at the publication step.'],
        remedy: {
          kind: 'proper-fix',
          description: 'Reject a partial artifact before refresh starts.',
          acceptanceCriteria: ['Valid generation publishes with a fully staged artifact.'],
        },
        technicalDebt: [
          {
            problem: 'The artifact store has no consistency signal.',
            decision: 'deferred',
            rationale: 'The immediate change can validate the required files.',
          },
        ],
      },
    ],
  };
}

async function withLog(check: (logPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-bugscan-'));
  try {
    await check(path.join(directory, 'diagnostics.jsonl'));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error('The hunt did not reach its expected state.');
}

test('persists the read position and counts distinct warning operations across a restart', () =>
  withLog(async (logPath) => {
    let state: BugScanState | undefined;
    let calls = 0;
    const create = () =>
      new BugScanService({
        logPath,
        load: () => state,
        save: (value) => {
          state = value;
        },
        scopeFor: () => first,
        resolveSource: async () => 'c'.repeat(40),
        investigate: async (request) => {
          calls++;
          return answer(request);
        },
        canStartAutomatic: () => true,
        now: () => now,
      });
    const prefix = event('distinct-3');
    await appendFile(
      logPath,
      `${event('distinct-1')}\n${event('distinct-1')}\n${event('distinct-2')}\n${prefix.slice(0, 17)}`,
    );
    const prior = create();
    await prior.ingest();
    expect(prior.list()).toHaveLength(0);
    expect(state?.pending).toHaveLength(2);
    expect(state?.cursor?.offset).toBeGreaterThan(0);
    await prior.close();

    await appendFile(logPath, `${prefix.slice(17)}\n`);
    const resumed = create();
    try {
      await resumed.ingest();
      await eventually(() => resumed.list()[0]?.status === 'completed');
      const hunt = resumed.list()[0];
      expect(hunt?.groups[0]?.evidence).toHaveLength(3);
      expect(hunt?.groups[0]?.sourceRevision).toBe('c'.repeat(40));
      expect(hunt?.findings[0]?.technicalDebt).toMatchObject([{ decision: 'deferred' }]);
      expect(calls).toBe(1);
      await appendFile(logPath, `${event('distinct-1')}\n`);
      await resumed.ingest();
      expect(resumed.list()).toHaveLength(1);
      expect(state?.pending).toHaveLength(0);
    } finally {
      await resumed.close();
    }
  }));

test('a single stall starts a hunt and known dependency, test and recursive events are filtered', () =>
  withLog(async (logPath) => {
    let request: BugScanRequest | undefined;
    const service = new BugScanService({
      logPath,
      load: () => undefined,
      save: () => {},
      scopeFor: () => first,
      resolveSource: async () => undefined,
      investigate: async (input) => {
        request = input;
        return answer(input);
      },
      canStartAutomatic: () => true,
      now: () => now,
    });
    try {
      await appendFile(
        logPath,
        [
          event('known-dependency', { severity: 'critical', context: { dependencyOutage: true } }),
          event('test-fixture', { severity: 'critical', context: { deliberateFailure: true } }),
          event('recursive-error', { severity: 'critical', component: 'bughunter' }),
          event('stalled', {
            message: 'Authorization: Bearer seeded-secret',
            code: 'repository-index.stalled',
            severity: 'error',
            outcome: 'incomplete',
          }),
          '',
        ].join('\n'),
      );
      await service.ingest();
      await eventually(() => service.list()[0]?.status === 'blocked');
      expect(request?.groups[0]?.evidence.map((item) => item.operationId)).toEqual(['stalled']);
      expect(JSON.stringify(request)).not.toContain('seeded-secret');
      expect(service.list()[0]?.findings[0]).toMatchObject({ confidence: 'hypothesis' });
      expect(service.list()[0]?.findings[0]?.remedy).toBeUndefined();
    } finally {
      await service.close();
    }
  }));

test('a paused hunt releases capacity and a later manual investigation can proceed', () =>
  withLog(async (logPath) => {
    let firstRequestCount = 0;
    const service = new BugScanService({
      logPath,
      load: () => undefined,
      save: () => {},
      scopeFor: (item) => (item.operationId === 'first' ? first : second),
      resolveSource: async () => 'f'.repeat(40),
      investigate: async (request, signal) => {
        if (request.scope === first && ++firstRequestCount === 1) {
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        }
        return answer(request);
      },
      now: () => now,
    });
    try {
      await appendFile(logPath, `${event('first')}\n${event('second')}\n`);
      await service.trigger(first);
      await eventually(() => firstRequestCount === 1);
      service.pause(first);
      await service.trigger(second);
      await eventually(() =>
        service.list().some((item) => item.scope === second && item.status === 'completed'),
      );
      const paused = service.list().find((item) => item.scope === first);
      expect(paused?.status).toBe('paused');
      if (!paused) throw new Error('The original hunt should still exist.');
      service.resume(paused.id);
      await eventually(() =>
        service.list().some((item) => item.id === paused.id && item.status === 'completed'),
      );
      expect(firstRequestCount).toBe(2);
    } finally {
      await service.close();
    }
  }));

test('more than two groups delegate in bounded waves before the Coordinator consolidates', () =>
  withLog(async (logPath) => {
    let workers = 0;
    let peakWorkers = 0;
    const requests: BugScanRequest[] = [];
    const service = new BugScanService({
      logPath,
      load: () => undefined,
      save: () => {},
      scopeFor: () => first,
      resolveSource: async () => 'f'.repeat(40),
      investigate: async (request) => {
        requests.push(request);
        if (request.role === 'investigator') {
          peakWorkers = Math.max(peakWorkers, ++workers);
          await Bun.sleep(5);
          workers--;
        }
        return answer(request);
      },
      maxConcurrentAgents: 2,
      now: () => now,
    });
    try {
      await appendFile(
        logPath,
        ['runtime', 'paseo', 'pi']
          .map((component) => event(component, { component, code: `${component}.failure` }))
          .join('\n') + '\n',
      );
      await service.trigger(first);
      await eventually(() => service.list()[0]?.status === 'completed');
      expect(peakWorkers).toBe(2);
      expect(requests.map((request) => request.role)).toEqual([
        'investigator',
        'investigator',
        'investigator',
        'coordinator',
      ]);
      expect(requests.at(-1)?.findings).toHaveLength(3);
      expect(service.list()[0]?.findings[0]?.groupIds).toHaveLength(3);
    } finally {
      await service.close();
    }
  }));

test('an investigation failure releases later work and preserves the generic report', () =>
  withLog(async (logPath) => {
    const service = new BugScanService({
      logPath,
      load: () => undefined,
      save: () => {},
      scopeFor: (item) => (item.operationId === 'first' ? first : second),
      resolveSource: async () => 'f'.repeat(40),
      investigate: async (request) => {
        if (request.phase === 'failure-report')
          return { summary: 'Review the model availability.' };
        if (request.scope === first) throw new Error('Provider unavailable.');
        return answer(request);
      },
      now: () => now,
    });
    try {
      await appendFile(logPath, `${event('first')}\n${event('second')}\n`);
      await service.trigger(first);
      await service.trigger(second);
      await eventually(() =>
        service.list().some((item) => item.scope === second && item.status === 'completed'),
      );
      expect(service.list().find((item) => item.scope === first)).toMatchObject({
        status: 'failed',
        failure: 'Provider unavailable.',
        failureReport: 'Review the model availability.',
      });
    } finally {
      await service.close();
    }
  }));

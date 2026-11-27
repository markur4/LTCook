import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { sanitizeEvaluationText } from '../evals/diagnostics.js';

const minute = 60_000;
const thresholdWindowMs = 30 * minute;
const dayMs = 24 * 60 * minute;
const maxLineBytes = 256 * 1024;
const recordText = z.string().min(1).max(4096);
const sourceRevision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const eventSchema = z.object({
  eventId: z.string().min(1).max(128),
  timestamp: z.string(),
  code: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  component: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  severity: z.enum(['info', 'warn', 'error', 'critical']),
  outcome: z
    .enum(['success', 'failure', 'cancelled', 'blocked', 'incomplete', 'degraded'])
    .optional(),
  operationId: z.string().min(1).max(128).optional(),
  buildIdentity: z
    .string()
    .regex(/^(?:source:[a-f0-9]{40}|[a-z0-9-]+:[a-f0-9]{64})$/)
    .optional(),
  sourceRevision: sourceRevision.optional(),
  message: z.string().optional(),
  cause: z.unknown().optional(),
  context: z
    .object({
      workspaceId: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      sessionId: z.string().min(1).max(128).optional(),
      deliberateFailure: z.boolean().optional(),
      dependencyOutage: z.boolean().optional(),
    })
    .optional(),
});

type DiagnosticInput = z.infer<typeof eventSchema>;

export type BugScanEvidence = Pick<
  DiagnosticInput,
  'eventId' | 'code' | 'component' | 'severity' | 'outcome' | 'buildIdentity' | 'sourceRevision'
> & {
  receivedAt: number;
  operationId: string;
  message?: string;
  cause?: string;
};

const remedySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('proper-fix'),
    description: recordText,
    acceptanceCriteria: z.array(recordText).min(1).max(16),
  }),
  z.object({
    kind: z.literal('workaround'),
    description: recordText,
    acceptanceCriteria: z.array(recordText).min(1).max(16),
    limitations: recordText,
    removalConditions: recordText,
    longTermRemedy: recordText,
  }),
  z.object({
    kind: z.literal('operational'),
    description: recordText,
    acceptanceCriteria: z.array(recordText).min(1).max(16),
  }),
]);

const findingSchema = z.object({
  groupIds: z.array(z.string().min(1).max(128)).min(1).max(64),
  confidence: z.enum(['demonstrated', 'hypothesis']),
  violatedExpectation: recordText,
  mechanism: recordText,
  cause: recordText,
  contributingConditions: z.array(recordText).max(32),
  evidence: z.array(recordText).min(1).max(32),
  repairPaths: z
    .array(
      z
        .string()
        .min(1)
        .max(1024)
        .refine(
          (value) =>
            !/[\\:\u0000-\u001f\u007f]/u.test(value) &&
            value.split('/').every((part) => part && part !== '.' && part !== '..'),
        ),
    )
    .max(64)
    .optional(),
  remedy: remedySchema.optional(),
  technicalDebt: z
    .array(
      z.object({
        problem: recordText,
        decision: z.enum(['immediate', 'deferred']),
        rationale: recordText,
      }),
    )
    .max(32),
});

export const bugScanFindingsSchema = z.object({ findings: z.array(findingSchema).max(64) });
export type BugScanFinding = z.infer<typeof findingSchema>;

export interface BugScanGroup {
  id: string;
  component: string;
  buildIdentity?: string;
  sourceRevision?: string;
  sourceBlocker?: string;
  evidence: BugScanEvidence[];
}

export interface BugScanRequest {
  huntId: string;
  requestId: string;
  scope: string;
  phase: 'investigate' | 'consolidate' | 'failure-report';
  role: 'coordinator' | 'investigator';
  workerSlot?: 0 | 1 | 2;
  groups: BugScanGroup[];
  findings: BugScanFinding[];
  failure?: string;
}

export interface BugScanHunt {
  id: string;
  scope: string;
  createdAt: number;
  automatic: boolean;
  automaticStartedAt?: number;
  status: 'queued' | 'running' | 'completed' | 'blocked' | 'failed' | 'paused' | 'budget-exhausted';
  groups: BugScanGroup[];
  findings: BugScanFinding[];
  checkpoints: Record<string, BugScanFinding[]>;
  elapsedMs: number;
  retry?: number;
  failure?: string;
  failureReport?: string;
}

export interface BugScanState {
  cursor: { fileIdentity: string; offset: number; discarding: boolean } | null;
  pending: { scope: string; evidence: BugScanEvidence }[];
  hunts: BugScanHunt[];
}

interface BugScanOptions {
  logPath: string;
  load: () => BugScanState | undefined;
  save: (state: BugScanState) => void;
  scopeFor: (event: DiagnosticInput) => string | undefined;
  resolveSource: (
    buildIdentity: string | undefined,
    scope: string,
    signal: AbortSignal,
    candidateRevision?: string,
  ) => Promise<string | undefined>;
  investigate: (request: BugScanRequest, signal: AbortSignal) => Promise<unknown>;
  canStartAutomatic?: () => boolean;
  canStartHunt?: () => boolean;
  now?: () => number;
  maxConcurrentAgents?: number;
  budgetMs?: number;
}

type ActiveHunt = {
  controller: AbortController;
  done: Promise<void>;
  initializedAt: number;
  initialElapsedMs: number;
  hunt: BugScanHunt;
};

function isFailure(event: DiagnosticInput): boolean {
  if (event.context?.deliberateFailure || event.context?.dependencyOutage) return false;
  if (/^bug(?:scan|fix|hunter)(?:[._-]|$)/.test(event.component)) return false;
  if (['success', 'cancelled', 'blocked'].includes(event.outcome ?? '')) return false;
  return (
    event.severity === 'critical' ||
    event.code === 'repository-index.stalled' ||
    ((event.severity === 'warn' || event.severity === 'error') &&
      (event.outcome === 'failure' || event.outcome === 'degraded'))
  );
}

function sanitize(value: string): string {
  return sanitizeEvaluationText(value) || '<omitted>';
}

function diagnosticCause(value: unknown): string | undefined {
  if (typeof value === 'string') return sanitize(value);
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string')
    return sanitize(value.message);
  return undefined;
}

function groupKey(item: BugScanEvidence): string {
  return JSON.stringify([item.component, item.buildIdentity]);
}

function groupsFor(evidence: BugScanEvidence[]): BugScanGroup[] {
  const groups = new Map<string, BugScanGroup>();
  for (const item of evidence) {
    const key = groupKey(item);
    let group = groups.get(key);
    if (!group) {
      group = {
        id: createHash('sha256').update(key).digest('hex'),
        component: item.component,
        buildIdentity: item.buildIdentity,
        evidence: [],
      };
      groups.set(key, group);
    }
    group.evidence.push(item);
  }
  return [...groups.values()];
}

function cleanFindings(raw: unknown, groups: BugScanGroup[]): BugScanFinding[] {
  const parsed = bugScanFindingsSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .slice(0, 8)
      .map(({ path, code }) => `${path.join('.') || 'report'} (${code})`);
    throw new Error(
      `The investigation report did not match the findings contract. Invalid fields: ${fields.join(', ')}.`,
    );
  }
  const known = new Map(groups.map((group) => [group.id, group]));
  const covered = new Set<string>();
  const result = parsed.data.findings.map((finding) => {
    const groupIds = [...new Set(finding.groupIds)];
    for (const id of groupIds) {
      if (!known.has(id))
        throw new Error('The investigation report referenced an unknown bug group.');
      covered.add(id);
    }
    const remedy = finding.remedy;
    const sourceMissing = groupIds.some((id) => !known.get(id)?.sourceRevision);
    const confidence =
      sourceMissing && remedy?.kind !== 'operational' ? 'hypothesis' : finding.confidence;
    const cleanRemedy =
      confidence === 'demonstrated' && remedy
        ? {
            ...remedy,
            description: sanitize(remedy.description),
            acceptanceCriteria: remedy.acceptanceCriteria.map(sanitize),
            ...(remedy.kind === 'workaround'
              ? {
                  limitations: sanitize(remedy.limitations),
                  removalConditions: sanitize(remedy.removalConditions),
                  longTermRemedy: sanitize(remedy.longTermRemedy),
                }
              : {}),
          }
        : undefined;
    return {
      groupIds,
      confidence,
      violatedExpectation: sanitize(finding.violatedExpectation),
      mechanism: sanitize(finding.mechanism),
      cause: sanitize(finding.cause),
      contributingConditions: finding.contributingConditions.map(sanitize),
      evidence: finding.evidence.map(sanitize),
      repairPaths: finding.repairPaths?.filter((entry) => sanitize(entry) === entry),
      remedy: cleanRemedy,
      technicalDebt: finding.technicalDebt.map((debt) => ({
        problem: sanitize(debt.problem),
        decision: debt.decision,
        rationale: sanitize(debt.rationale),
      })),
    } satisfies BugScanFinding;
  });
  if (covered.size !== known.size)
    throw new Error('The investigation report did not account for the assigned evidence.');
  return result;
}

/** Owns read-only diagnostic intake and investigations through the runtime's storage and Team. */
export class BugScanService {
  private readonly state: BugScanState;
  private readonly now: () => number;
  private readonly workers: number;
  private readonly budgetMs: number;
  private readonly active = new Map<string, ActiveHunt>();
  private reading?: Promise<void>;
  private closed = false;

  constructor(private readonly options: BugScanOptions) {
    this.now = options.now ?? Date.now;
    this.workers = Math.max(1, Math.min(3, options.maxConcurrentAgents ?? 3));
    this.budgetMs = Math.max(1, options.budgetMs ?? 45 * minute);
    this.state = options.load() ?? { cursor: null, pending: [], hunts: [] };
    for (const hunt of this.state.hunts) {
      if (hunt.status === 'running') hunt.status = 'queued';
    }
    this.persist();
  }

  list(): readonly BugScanHunt[] {
    return structuredClone(this.state.hunts);
  }

  ingest(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.checkpointActiveTime();
    return this.readPending().then(() => this.dispatch());
  }

  async trigger(scope: string): Promise<void> {
    if (this.closed) throw new Error('BugScan is closed.');
    await this.readPending();
    const existing = this.state.hunts.find(
      (hunt) => hunt.scope === scope && hunt.status === 'queued',
    );
    if (existing) existing.automatic = false;
    else this.enqueue(scope, false, this.takeEvidence(scope));
    this.persist();
    this.dispatch();
  }

  pause(scope: string): void {
    const hunt = this.state.hunts.find((item) => item.scope === scope && item.status === 'running');
    if (!hunt) return;
    hunt.status = 'paused';
    this.persist();
    this.active.get(scope)?.controller.abort();
  }

  resume(huntId: string): void {
    const hunt = this.state.hunts.find(
      (item) => item.id === huntId && (item.status === 'paused' || item.status === 'blocked'),
    );
    if (!hunt) return;
    if (hunt.status === 'blocked') {
      hunt.retry = (hunt.retry ?? 0) + 1;
      hunt.checkpoints = {};
      delete hunt.failure;
    }
    hunt.status = 'queued';
    this.persist();
    this.dispatch();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const { controller } of this.active.values()) controller.abort();
    await this.reading?.catch(() => {});
    await Promise.all([...this.active.values()].map(({ done }) => done));
  }

  private persist(): void {
    this.options.save(structuredClone(this.state));
  }

  private readPending(): Promise<void> {
    this.reading ??= this.readDiagnostics().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  private checkpointActiveTime(): void {
    if (!this.active.size) return;
    const now = this.now();
    for (const { hunt, initializedAt, initialElapsedMs } of this.active.values())
      hunt.elapsedMs = initialElapsedMs + Math.max(0, now - initializedAt);
    this.persist();
  }

  private async readDiagnostics(): Promise<void> {
    const file = await open(this.options.logPath, 'r').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!file) return;
    try {
      const info = await file.stat({ bigint: true });
      const fileIdentity = `${info.dev}:${info.ino}`;
      const size = Number(info.size);
      if (this.state.cursor?.fileIdentity !== fileIdentity || this.state.cursor.offset > size)
        this.state.cursor = { fileIdentity, offset: 0, discarding: false };
      const cursor = this.state.cursor;
      const buffer = Buffer.alloc(maxLineBytes);
      while (cursor.offset < size && !this.closed) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(size - cursor.offset, buffer.length),
          cursor.offset,
        );
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        let start = 0;
        for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
          if (!cursor.discarding) this.acceptDiagnostic(chunk.toString('utf8', start, end));
          cursor.discarding = false;
          start = end + 1;
        }
        if (start === 0 && (cursor.discarding || bytesRead === buffer.length)) {
          cursor.discarding = true;
          start = bytesRead;
        }
        if (!start) break;
        cursor.offset += start;
        this.persist();
      }
    } finally {
      await file.close();
    }
  }

  private acceptDiagnostic(line: string): void {
    let input: unknown;
    try {
      input = JSON.parse(line);
    } catch {
      return;
    }
    const result = eventSchema.safeParse(input);
    if (!result.success || !isFailure(result.data)) return;
    const event = result.data;
    const scope = this.options.scopeFor(event);
    const receivedAt = Date.parse(event.timestamp);
    if (!scope || !Number.isFinite(receivedAt) || receivedAt > this.now()) return;
    const operationId = sanitize(event.operationId ?? event.eventId);
    const evidence: BugScanEvidence = {
      eventId: sanitize(event.eventId),
      code: event.code,
      component: event.component,
      severity: event.severity,
      outcome: event.outcome,
      buildIdentity: event.buildIdentity,
      sourceRevision: event.sourceRevision,
      operationId,
      receivedAt,
      message: event.message === undefined ? undefined : sanitize(event.message),
      cause: diagnosticCause(event.cause),
    };
    const sameOperation = (other: BugScanEvidence) =>
      other.operationId === operationId &&
      other.component === event.component &&
      other.buildIdentity === event.buildIdentity;
    const pending = this.state.pending.find(
      (item) => item.scope === scope && sameOperation(item.evidence),
    );
    if (pending) {
      // > Escalations keep the original operation identity and can independently trigger BugScan.
      if (this.immediate(evidence) && !this.immediate(pending.evidence))
        pending.evidence = evidence;
      return;
    }
    if (
      this.state.hunts.some(
        (hunt) =>
          hunt.scope === scope && hunt.groups.some((group) => group.evidence.some(sameOperation)),
      )
    )
      return;
    this.state.pending.push({ scope, evidence });
  }

  private immediate(evidence: BugScanEvidence): boolean {
    return evidence.severity === 'critical' || evidence.code === 'repository-index.stalled';
  }

  private takeEvidence(scope: string): BugScanEvidence[] {
    const evidence: BugScanEvidence[] = [];
    const selectedGroups = new Set<string>();
    this.state.pending = this.state.pending.filter((item) => {
      if (item.scope !== scope) return true;
      const key = groupKey(item.evidence);
      if (!selectedGroups.has(key) && selectedGroups.size >= 16) return true;
      selectedGroups.add(key);
      evidence.push(item.evidence);
      return false;
    });
    return evidence;
  }

  private enqueue(scope: string, automatic: boolean, evidence: BugScanEvidence[]): BugScanHunt {
    const hunt: BugScanHunt = {
      id: randomUUID(),
      scope,
      createdAt: this.now(),
      automatic,
      status: 'queued',
      groups: groupsFor(evidence),
      findings: [],
      checkpoints: {},
      elapsedMs: 0,
    };
    this.state.hunts.push(hunt);
    return hunt;
  }

  private dispatch(): void {
    if (this.closed || this.options.canStartHunt?.() === false) return;
    const allowAutomatic = this.options.canStartAutomatic?.() ?? false;
    if (allowAutomatic) this.queueAutomatic();
    // > A single runtime Team controls the delegated-agent budget across repositories.
    if (this.active.size) return;
    const hunt =
      this.state.hunts.find((item) => item.status === 'queued' && !item.automatic) ??
      (allowAutomatic
        ? this.state.hunts.find(
            (item) => item.status === 'queued' && this.hasAutomaticCapacity(item),
          )
        : undefined);
    if (!hunt) return;
    const controller = new AbortController();
    const initializedAt = this.now();
    const initialElapsedMs = hunt.elapsedMs;
    hunt.status = 'running';
    if (hunt.automatic) hunt.automaticStartedAt ??= this.now();
    this.persist();
    const done = this.run(hunt, controller, initializedAt, initialElapsedMs).finally(() => {
      this.active.delete(hunt.scope);
      this.dispatch();
    });
    this.active.set(hunt.scope, { controller, done, initializedAt, initialElapsedMs, hunt });
    // > Preserve unexpected persistence errors for the runtime to observe when it closes.
    void done.catch(() => {});
  }

  private hasAutomaticCapacity(hunt: BugScanHunt): boolean {
    if (hunt.automaticStartedAt !== undefined) return true;
    const since = this.now() - dayMs;
    return (
      this.state.hunts.filter(
        (item) => item.automaticStartedAt !== undefined && item.automaticStartedAt >= since,
      ).length < 3
    );
  }

  private queueAutomatic(): void {
    const since = this.now() - thresholdWindowMs;
    this.state.pending = this.state.pending.filter(
      ({ evidence }) => this.immediate(evidence) || evidence.receivedAt >= since,
    );
    const scopes = new Set(this.state.pending.map((item) => item.scope));
    for (const scope of scopes) {
      if (
        this.active.has(scope) ||
        this.state.hunts.some((hunt) => hunt.scope === scope && hunt.status === 'queued')
      )
        continue;
      const evidence = this.state.pending
        .filter((item) => item.scope === scope)
        .map((item) => item.evidence);
      const failureCounts = new Map<string, number>();
      for (const item of evidence) {
        if (item.receivedAt >= since)
          failureCounts.set(item.component, (failureCounts.get(item.component) ?? 0) + 1);
      }
      if (
        evidence.some((item) => this.immediate(item)) ||
        [...failureCounts.values()].some((count) => count >= 3)
      )
        this.enqueue(scope, true, this.takeEvidence(scope));
    }
    this.persist();
  }

  private async ask(
    hunt: BugScanHunt,
    requestId: string,
    signal: AbortSignal,
    input: Pick<BugScanRequest, 'groups' | 'phase' | 'role' | 'findings' | 'workerSlot'>,
    assigned = input.groups,
  ): Promise<BugScanFinding[]> {
    signal.throwIfAborted();
    const cached = hunt.checkpoints[requestId];
    if (cached) return cached;
    const assignedIds = new Set(assigned.map((group) => group.id));
    const response = await this.options.investigate(
      {
        ...structuredClone(input),
        groups: input.groups.map((group) => ({
          ...group,
          evidence: group.evidence.slice(-(assignedIds.has(group.id) ? 16 : 1)),
        })),
        requestId,
        huntId: hunt.id,
        scope: hunt.scope,
      },
      signal,
    );
    signal.throwIfAborted();
    const findings = cleanFindings(response, assigned);
    hunt.checkpoints[requestId] = findings;
    this.persist();
    return findings;
  }

  private async run(
    hunt: BugScanHunt,
    controller: AbortController,
    started: number,
    initialElapsedMs: number,
  ): Promise<void> {
    const timeLeft = Math.max(0, this.budgetMs - initialElapsedMs);
    const budget = AbortSignal.timeout(timeLeft);
    const signal = AbortSignal.any([controller.signal, budget]);
    const requestPrefix = hunt.retry ? `${hunt.id}:retry:${hunt.retry}` : hunt.id;
    try {
      signal.throwIfAborted();
      if (!timeLeft) throw new Error('The BugScan execution budget was exhausted.');
      if (!hunt.groups.length) {
        hunt.status = 'blocked';
        hunt.failure = 'No actionable diagnostic evidence is available for the selected scope.';
        return;
      }
      for (const group of hunt.groups) {
        signal.throwIfAborted();
        if (group.sourceRevision) continue;
        try {
          const candidateRevisions = new Set(
            group.evidence.flatMap((item) => (item.sourceRevision ? [item.sourceRevision] : [])),
          );
          const candidateRevision =
            candidateRevisions.size === 1 ? candidateRevisions.values().next().value : undefined;
          const revision = await this.options.resolveSource(
            group.buildIdentity,
            hunt.scope,
            signal,
            candidateRevision,
          );
          signal.throwIfAborted();
          if (revision && sourceRevision.safeParse(revision).success) {
            group.sourceRevision = revision;
            delete group.sourceBlocker;
          } else {
            group.sourceBlocker =
              'The affected build could not be associated with an exact source revision.';
          }
        } catch (error) {
          signal.throwIfAborted();
          group.sourceBlocker =
            diagnosticCause(error) ?? 'The affected source revision is unavailable.';
        }
        this.persist();
      }
      if (hunt.groups.length <= 2) {
        hunt.findings = await this.ask(hunt, `${requestPrefix}:coordinator`, signal, {
          groups: hunt.groups,
          phase: 'investigate',
          role: 'coordinator',
          findings: [],
        });
      } else {
        const findings: BugScanFinding[] = [];
        const workerSlots = [0, 1, 2] as const;
        for (let offset = 0; offset < hunt.groups.length; offset += this.workers) {
          const wave = hunt.groups.slice(offset, offset + this.workers);
          const results = await Promise.allSettled(
            wave.map((group, slot) =>
              this.ask(
                hunt,
                `${requestPrefix}:group:${group.id}`,
                signal,
                {
                  groups: [group, ...hunt.groups.filter((other) => other.id !== group.id)],
                  phase: 'investigate',
                  role: 'investigator',
                  workerSlot: workerSlots[slot],
                  findings: [],
                },
                [group],
              ),
            ),
          );
          for (const result of results) {
            if (result.status === 'rejected') throw result.reason;
            findings.push(...result.value);
          }
        }
        hunt.findings = await this.ask(hunt, `${requestPrefix}:consolidate`, signal, {
          groups: hunt.groups,
          phase: 'consolidate',
          role: 'coordinator',
          findings,
        });
      }
      hunt.status = hunt.findings.some((finding) => finding.confidence === 'demonstrated')
        ? 'completed'
        : 'blocked';
      if (hunt.status === 'blocked')
        hunt.failure = 'The investigation could not confirm a cause with available evidence.';
    } catch (error) {
      if (budget.aborted || !timeLeft) {
        hunt.status = 'budget-exhausted';
        hunt.failure = 'The BugScan execution budget was exhausted.';
      } else if (this.closed && controller.signal.aborted && hunt.status !== 'paused') {
        hunt.status = 'queued';
      } else if (!controller.signal.aborted) {
        hunt.status = 'failed';
        hunt.failure = diagnosticCause(error) ?? 'The investigation did not complete.';
        // > Persist the failure before asking the Coordinator to account for remaining work.
        this.persist();
        try {
          const report = await this.options.investigate(
            {
              huntId: hunt.id,
              requestId: `${requestPrefix}:failure`,
              scope: hunt.scope,
              groups: hunt.groups.map((group) => ({
                ...group,
                evidence: group.evidence.slice(-1),
              })),
              phase: 'failure-report',
              role: 'coordinator',
              findings: structuredClone(hunt.findings),
              failure: hunt.failure,
            },
            signal,
          );
          if (
            report &&
            typeof report === 'object' &&
            'summary' in report &&
            typeof report.summary === 'string'
          )
            hunt.failureReport = sanitize(report.summary);
        } catch {
          // > The deterministic record remains available when the reporting Task also fails.
        }
      }
    } finally {
      hunt.elapsedMs = initialElapsedMs + Math.max(0, this.now() - started);
      this.persist();
    }
  }
}

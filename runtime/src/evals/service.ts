import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  EvalStartRequestSchema,
  EvalSummarySchema,
  evaluationCaseCount,
  type EvalStartRequest,
  type EvalEvent,
  type EvalPreset,
  type EvalSetup,
  type EvalReportResponse,
  type EvalSummary,
} from './contracts.js';

export type EvalProgress = {
  event: 'suite.started' | 'case.started' | 'case.completed' | 'case.failed';
  suite: string;
  case?: string;
  completed?: number;
  total?: number;
  message?: string;
  metadata?: Partial<
    Pick<EvalSummary, 'teamSelection' | 'model' | 'fixtureRevision' | 'provenance' | 'limitations'>
  >;
};
export type EvalOutput = {
  result: unknown;
  trace: unknown;
  metadata?: Partial<
    Pick<EvalSummary, 'teamSelection' | 'model' | 'fixtureRevision' | 'provenance' | 'limitations'>
  >;
};
export type EvalTimingIdentity = {
  scenario: string;
  thinking: 'off' | 'low';
  provenanceKey: string;
};
export type EvalBudget = { timeoutMs: number; referenceRuns: string[]; expectedMs: number | null };
type TimingSample = EvalTimingIdentity & { elapsedMs: number; recordedAt: number; runId: string };
const checkpointSchema = z.object({
  result: z.unknown(),
  trace: z.unknown(),
  completed: z.number().int().nonnegative(),
  timingSamples: z.array(
    z.object({
      scenario: z.string(),
      thinking: z.enum(['off', 'low']),
      provenanceKey: z.string(),
      elapsedMs: z.number().positive().finite(),
      recordedAt: z.number().finite(),
      runId: z.string().uuid(),
    }),
  ),
});
function observedHardware(): string | undefined {
  const result = spawnSync(
    'nvidia-smi',
    ['--query-compute-apps=gpu_uuid,process_name', '--format=csv,noheader,nounits'],
    { encoding: 'utf8', timeout: 1000, env: { PATH: process.env.PATH } },
  );
  if (result.status !== 0) return undefined;
  const devices = new Set(
    result.stdout
      .split('\n')
      .filter((line) => /ollama|llama-server/i.test(line))
      .map((line) => line.split(',')[0]?.trim())
      .filter(Boolean),
  );
  if (devices.size !== 1) return undefined;
  return `gpu:${createHash('sha256')
    .update([...devices].join(','))
    .digest('hex')}`;
}
export type EvalEngine = (input: {
  preset: EvalPreset;
  setup: EvalSetup;
  workspaceRoot?: string;
  staticOnly: boolean;
  runDirectory: string;
  signal: AbortSignal;
  progress(event: EvalProgress): void;
  checkpoint?(output: EvalOutput): Promise<void>;
  repetitions?: number;
  scenario?: 'read-only' | 'no-op' | 'targeted-fix';
  timingHardware?: string;
  budget?(identity: EvalTimingIdentity): EvalBudget;
  learned?(
    identity: EvalTimingIdentity,
    sample: { elapsedMs: number; success: boolean },
  ): Promise<void>;
}) => Promise<EvalOutput>;

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : 'Agent Evals run failed';
  return value
    .replace(/(token|password|api.?key)=?[^\s]*/gi, '$1=<redacted>')
    .replace(/(?:\/home\/[^\s/]+|[A-Z]:\\Users\\[^\\\s]+)/g, '<user-home>')
    .slice(0, 500);
}

function sanitize(value: unknown, key = ''): unknown {
  if (/^(effectivePrompt|prompt|transcript|sourceText|systemPrompt)$/i.test(key)) return undefined;
  if (Array.isArray(value))
    return value.map((item) => sanitize(item)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([name, child]) => {
        const safe = sanitize(child, name);
        return safe === undefined ? [] : [[name, safe]];
      }),
    );
  }
  if (typeof value === 'string')
    return value.replace(/(?:\/home\/[^\s/]+|[A-Z]:\\Users\\[^\\\s]+)/g, '<user-home>');
  return value;
}

/** Owns user-started Agent Evals jobs and their private, restart-safe history. */
export class EvalRunService {
  private readonly root: string;
  private active: { runId: string; controller: AbortController; task: Promise<void> } | undefined;
  private readonly summaries = new Map<string, EvalSummary>();
  private readonly results = new Map<string, unknown>();
  private readonly traces = new Map<string, unknown>();
  private readonly timingSamples = new Map<string, TimingSample[]>();
  private writes: Promise<void> = Promise.resolve();
  private readonly sequences = new Map<string, number>();
  private starting = false;

  constructor(
    stateDirectory: string,
    private readonly engine: EvalEngine,
    private readonly timingHardware: () => string | undefined = observedHardware,
  ) {
    this.root = path.join(stateDirectory, 'evals', 'runs');
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.root), 0o700);
    await chmod(this.root, 0o700);
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      const directory = path.join(this.root, entry.name);
      const metadata = await stat(directory);
      if (!metadata.isDirectory()) continue;
      try {
        const summary = EvalSummarySchema.parse(
          JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8')),
        );
        if (summary.runId !== entry.name) continue;
        this.sequences.set(summary.runId, (await this.readEvents(summary.runId)).length);
        if (summary.status === 'running') {
          summary.status = 'interrupted';
          summary.error = 'Runtime stopped before this run completed.';
          summary.updatedAt = new Date().toISOString();
          await this.saveSummary(summary);
          await this.emit(summary, 'run.interrupted', { message: summary.error });
        }
        this.summaries.set(summary.runId, summary);
        await this.loadArtifacts(summary, directory);
      } catch {
        // A malformed history entry remains isolated and is never executed on startup.
      }
    }
  }

  async start(input: EvalStartRequest): Promise<string> {
    const request = EvalStartRequestSchema.parse(input);
    const { preset, setup, staticOnly = false } = request;
    if (this.active && this.requireRun(this.active.runId).status !== 'running')
      await this.active.task;
    if (this.active || this.starting) throw new Error('An Agent Evals run is already active.');
    this.starting = true;
    const now = new Date().toISOString();
    const runId = randomUUID();
    const summary: EvalSummary = {
      schema: 3,
      runId,
      preset,
      setup,
      staticOnly,
      repetitions: request.repetitions,
      ...(request.scenario ? { scenario: request.scenario } : {}),
      limitations: [],
      status: 'running',
      createdAt: now,
      updatedAt: now,
      completed: 0,
      total: evaluationCaseCount(request),
    };
    this.summaries.set(runId, summary);
    try {
      await this.saveSummary(summary);
      await this.emit(summary, 'run.started');
      const controller = new AbortController();
      const task = this.execute(summary, controller, request);
      this.active = { runId, controller, task };
      return runId;
    } finally {
      this.starting = false;
    }
  }

  async status(runId: string, after = 0) {
    const summary = this.requireRun(runId);
    const events = await this.readEvents(runId);
    return {
      summary,
      events: events.filter((event) => event.sequence >= after),
      next: events.length,
    };
  }

  list() {
    return [...this.summaries.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  report(runId: string): EvalReportResponse {
    return {
      summary: this.requireRun(runId),
      result: sanitize(this.results.get(runId)) ?? null,
      trace: sanitize(this.traces.get(runId)) ?? null,
    };
  }

  async cancel(runId: string): Promise<EvalSummary> {
    const summary = this.requireRun(runId);
    if (summary.status !== 'running' || this.active?.runId !== runId) return summary;
    this.active.controller.abort();
    await this.active.task;
    return this.requireRun(runId);
  }

  async delete(runId: string): Promise<void> {
    const summary = this.requireRun(runId);
    if (summary.status === 'running')
      throw new Error('Cancel the active Agent Evals run before deleting it.');
    await rm(this.runDirectory(runId), { recursive: true, force: false });
    this.summaries.delete(runId);
    this.results.delete(runId);
    this.traces.delete(runId);
    this.timingSamples.delete(runId);
  }

  async close(): Promise<void> {
    if (!this.active) return;
    this.active.controller.abort();
    await this.active.task;
  }

  private async execute(
    summary: EvalSummary,
    controller: AbortController,
    request: EvalStartRequest,
  ): Promise<void> {
    const started = Date.now();
    const hardware = this.timingHardware();
    try {
      const output = await this.engine({
        preset: summary.preset,
        setup: summary.setup,
        staticOnly: summary.staticOnly,
        repetitions: request.repetitions,
        scenario: request.scenario,
        timingHardware: hardware,
        budget: (identity) => this.budget(identity),
        learned: async (identity, sample) => {
          if (
            !sample.success ||
            controller.signal.aborted ||
            !Number.isFinite(sample.elapsedMs) ||
            sample.elapsedMs <= 0 ||
            this.timingHardware() !== hardware
          )
            return;
          const samples = this.timingSamples.get(summary.runId) ?? [];
          samples.push({
            ...identity,
            elapsedMs: sample.elapsedMs,
            recordedAt: Date.now(),
            runId: summary.runId,
          });
          this.timingSamples.set(summary.runId, samples);
        },
        ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
        runDirectory: this.runDirectory(summary.runId),
        signal: controller.signal,
        checkpoint: async (output) => {
          await this.writes;
          await this.saveOutput(summary, output);
        },
        progress: (event) => {
          if (event.metadata) Object.assign(summary, sanitize(event.metadata));
          summary.currentSuite = event.suite;
          if (event.case) summary.currentCase = event.case;
          if (event.completed !== undefined) summary.completed = event.completed;
          if (event.total !== undefined) summary.total = event.total;
          summary.updatedAt = new Date().toISOString();
          this.writes = this.writes.then(async () => {
            await this.saveSummary(summary);
            await this.emit(summary, event.event, event);
          });
        },
      });
      await this.writes;
      await this.saveOutput(summary, output);
      summary.status = controller.signal.aborted ? 'cancelled' : 'completed';
      summary.completed = summary.total;
      summary.updatedAt = new Date().toISOString();
      await this.saveSummary(summary);
      await this.emit(summary, summary.status === 'cancelled' ? 'run.cancelled' : 'run.completed', {
        elapsedMs: Date.now() - started,
      });
    } catch (error) {
      await this.writes.catch(() => undefined);
      summary.status = controller.signal.aborted ? 'cancelled' : 'failed';
      summary.error = safeError(error);
      summary.updatedAt = new Date().toISOString();
      await this.saveSummary(summary);
      await this.emit(summary, summary.status === 'cancelled' ? 'run.cancelled' : 'run.failed', {
        elapsedMs: Date.now() - started,
        message: summary.error,
      });
    } finally {
      this.active = undefined;
    }
  }

  private requireRun(runId: string): EvalSummary {
    const summary = this.summaries.get(runId);
    if (!summary) throw new Error('Agent Evals run was not found.');
    return summary;
  }
  private async saveOutput(summary: EvalSummary, output: EvalOutput): Promise<void> {
    Object.assign(summary, sanitize(output.metadata ?? {}));
    const result = sanitize(output.result);
    const trace = sanitize(output.trace);
    await this.saveArtifact(summary.runId, 'checkpoint.json', {
      result,
      trace,
      completed: summary.completed,
      timingSamples: this.timingSamples.get(summary.runId) ?? [],
    });
    this.results.set(summary.runId, result);
    this.traces.set(summary.runId, trace);
  }
  private budget(identity: EvalTimingIdentity): EvalBudget {
    const samples = identity.provenanceKey.startsWith('unverified:')
      ? []
      : [...this.timingSamples.values()]
          .flat()
          .filter(
            (sample) =>
              sample.scenario === identity.scenario &&
              sample.thinking === identity.thinking &&
              sample.provenanceKey === identity.provenanceKey,
          )
          .sort((a, b) => b.recordedAt - a.recordedAt)
          .slice(0, 5);
    const expectedMs = samples.length
      ? Math.max(...samples.map((sample) => sample.elapsedMs))
      : null;
    return {
      timeoutMs: expectedMs === null ? 120000 : Math.ceil(expectedMs * 3),
      expectedMs,
      referenceRuns: samples.map((sample) => sample.runId),
    };
  }
  private runDirectory(runId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error('Invalid Agent Evals run ID.');
    return path.join(this.root, runId);
  }
  private async saveSummary(summary: EvalSummary): Promise<void> {
    await this.saveArtifact(summary.runId, 'run.json', summary);
  }
  private async saveArtifact(runId: string, name: string, value: unknown): Promise<void> {
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, path.join(directory, name));
  }
  private async emit(
    summary: EvalSummary,
    event: EvalEvent['event'],
    fields: Partial<EvalProgress> & { elapsedMs?: number } = {},
  ): Promise<void> {
    const sequence = this.sequences.get(summary.runId) ?? 0;
    const item: EvalEvent = {
      sequence,
      runId: summary.runId,
      event,
      ...(fields.suite ? { suite: fields.suite } : {}),
      ...(fields.case ? { case: fields.case } : {}),
      status: summary.status,
      completed: summary.completed,
      total: summary.total,
      elapsedMs: fields.elapsedMs ?? 0,
      ...(fields.message ? { message: fields.message.slice(0, 300) } : {}),
      createdAt: new Date().toISOString(),
    };
    const directory = this.runDirectory(summary.runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendFile(path.join(directory, 'events.jsonl'), `${JSON.stringify(item)}\n`, {
      mode: 0o600,
    });
    this.sequences.set(summary.runId, sequence + 1);
  }
  private async readEvents(runId: string): Promise<EvalEvent[]> {
    try {
      const text = await readFile(path.join(this.runDirectory(runId), 'events.jsonl'), 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EvalEvent);
    } catch {
      return [];
    }
  }
  private async loadArtifacts(summary: EvalSummary, directory: string): Promise<void> {
    const runId = summary.runId;
    try {
      const checkpoint = checkpointSchema.parse(
        JSON.parse(await readFile(path.join(directory, 'checkpoint.json'), 'utf8')),
      );
      this.results.set(runId, checkpoint.result);
      this.traces.set(runId, checkpoint.trace);
      if (summary.status === 'interrupted') {
        summary.completed = Math.min(summary.completed, checkpoint.completed);
        await this.saveSummary(summary);
      }
      this.timingSamples.set(
        runId,
        checkpoint.timingSamples.filter((sample) => sample.runId === runId),
      );
    } catch {
      /* No complete checkpoint was saved. Unsupported artifacts are left unchanged. */
    }
  }
}

import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const SECRET_KEYS =
  /(?:secret|token|password|api.?key|authorization|credential|prompt|transcript|cookie)/i;
const PRIVATE_ENV_KEYS = /(?:secret|token|password|api.?key|authorization|credential)$/i;
const SECRET_ASSIGNMENT =
  /(\b(?:[\w-]*(?:token|password|secret|api[_.-]?key|credential)|authorization|cookie)\b["']?\s*[:=]\s*)(?:["'][^"']*["']|(?:Bearer|Basic)\s+[^\s,;]+|[^\s,;]+)/gi;

export function redactDiagnosticText(
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  let result = text;
  for (const [key, value] of Object.entries(environment)) {
    if (value && value.length >= 8 && PRIVATE_ENV_KEYS.test(key))
      result = result.replaceAll(value, '<redacted>');
  }
  return result
    .replace(SECRET_ASSIGNMENT, '$1<redacted>')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi, '$1 <redacted>')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<redacted>@')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '<redacted>');
}

export function redact(value: unknown, seen = new Set<object>()): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (typeof value === 'bigint') return value.toString();
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '<circular>';
  seen.add(value);
  const clean = (child: unknown) => redact(child, seen);
  try {
    if (value instanceof Error) {
      return {
        name: clean(value.name),
        message: clean(value.message),
        ...(value.cause === undefined ? {} : { cause: clean(value.cause) }),
        ...(value instanceof AggregateError ? { errors: clean(value.errors) } : {}),
      };
    }
    if (Array.isArray(value)) return value.map(clean);
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        redactDiagnosticText(key),
        SECRET_KEYS.test(key) ? '<redacted>' : clean(child),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}

export type DiagnosticSeverity = 'info' | 'warn' | 'error' | 'critical';
export type DiagnosticOutcome =
  'success' | 'failure' | 'cancelled' | 'blocked' | 'incomplete' | 'degraded';

export interface DiagnosticEvent {
  code: string;
  component: string;
  severity: DiagnosticSeverity;
  outcome?: DiagnosticOutcome;
  operationId?: string;
  correlationId?: string;
  message?: string;
  cause?: unknown;
  context?: object;
}
export class Telemetry {
  private traceEvents: Array<Record<string, unknown>> = [];
  private pendingLog: Promise<void> = Promise.resolve();
  constructor(
    private readonly logsPath: string,
    private readonly tracePath: string,
    private buildIdentity?: string,
  ) {}

  setBuildIdentity(buildIdentity: string): void {
    this.buildIdentity = buildIdentity;
  }

  log(level: DiagnosticSeverity, event: string, fields: object = {}): Promise<void> {
    const component = event.split('.')[0] ?? 'runtime';
    return this.writeRow({ component, code: event, severity: level }, fields);
  }

  record(event: DiagnosticEvent): Promise<void> {
    return this.writeRow(event);
  }

  private writeRow(diagnostic: DiagnosticEvent, fields: object = {}): Promise<void> {
    const row = {
      ...(redact(fields) as Record<string, unknown>),
      ...(redact(diagnostic) as Record<string, unknown>),
      timestamp: new Date().toISOString(),
      eventId: randomUUID(),
      level: diagnostic.severity,
      event: diagnostic.code,
      buildIdentity: this.buildIdentity,
    };
    const write = this.pendingLog.then(async () => {
      await mkdir(path.dirname(this.logsPath), { recursive: true, mode: 0o700 });
      await appendFile(this.logsPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    });
    this.pendingLog = write.catch(() => {});
    return write;
  }
  begin(
    name: string,
    correlationId = randomUUID(),
    lane: string | number = 0,
  ): { correlationId: string; end(): void } {
    const start = process.hrtime.bigint();
    this.traceEvents.push({
      name,
      cat: 'ltcook',
      ph: 'B',
      ts: Number(start / 1000n),
      pid: process.pid,
      tid: lane,
      args: { correlationId },
    });
    let ended = false;
    return {
      correlationId,
      end: () => {
        if (ended) return;
        ended = true;
        this.traceEvents.push({
          name,
          cat: 'ltcook',
          ph: 'E',
          ts: Number(process.hrtime.bigint() / 1000n),
          pid: process.pid,
          tid: lane,
          args: { correlationId },
        });
      },
    };
  }
  /** Preserve native duration measurements as complete spans, including parallel tools. */
  duration(name: string, durationMs: number, lane: string | number = 0): void {
    const end = Number(process.hrtime.bigint() / 1000n);
    this.traceEvents.push({
      name,
      cat: 'ltcook',
      ph: 'X',
      ts: end - durationMs * 1000,
      dur: durationMs * 1000,
      pid: process.pid,
      tid: lane,
    });
  }
  /** Attach bounded caller-sanitized diagnostic metadata to the existing Perfetto stream. */
  instant(name: string, fields: object = {}, lane: string | number = 0): void {
    this.traceEvents.push({
      name,
      cat: 'ltcook',
      ph: 'i',
      s: 't',
      ts: Number(process.hrtime.bigint() / 1000n),
      pid: process.pid,
      tid: lane,
      args: redact(fields),
    });
  }
  async exportTrace(): Promise<void> {
    await mkdir(path.dirname(this.tracePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.tracePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ traceEvents: this.traceEvents }), { mode: 0o600 });
    await rename(temporary, this.tracePath);
  }
}

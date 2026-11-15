import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const SECRET_KEYS = /(?:secret|token|password|api.?key|authorization|prompt|transcript)/i;
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_KEYS.test(key) ? '<redacted>' : redact(child),
      ]),
    );
  return value;
}
export class Telemetry {
  private traceEvents: Array<Record<string, unknown>> = [];
  constructor(
    private readonly logsPath: string,
    private readonly tracePath: string,
  ) {}
  async log(level: string, event: string, fields: object = {}): Promise<void> {
    await mkdir(path.dirname(this.logsPath), { recursive: true, mode: 0o700 });
    const row = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...(redact(fields) as Record<string, unknown>),
    };
    await appendFile(this.logsPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
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
  async exportTrace(): Promise<void> {
    await mkdir(path.dirname(this.tracePath), { recursive: true, mode: 0o700 });
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(this.tracePath, JSON.stringify({ traceEvents: this.traceEvents }), { mode: 0o600 }),
    );
  }
}

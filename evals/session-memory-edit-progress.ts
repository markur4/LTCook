import { hash } from '../runtime/src/evals/setup.js';

/** Stop after three calls in a row have repeated previously seen requests and results. */
export class MemoryEditProgress {
  private readonly observed = new Set<string>();
  private repeated = 0;

  record(tool: string, args: unknown, result: unknown) {
    const key = hash(
      JSON.stringify([tool, args, result], (_key, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
            )
          : value,
      ),
    );
    if (this.observed.has(key)) this.repeated++;
    else {
      this.observed.add(key);
      this.repeated = 0;
    }
    return this.repeated >= 3;
  }
}

/** Union intervals within each category; separate categories can overlap. */
export function attributeEvaluationTrace(events: unknown[]) {
  const categories = ['model', 'tool', 'scheduler', 'wait', 'delegation'] as const;
  const intervals = new Map<string, Array<[number, number]>>(categories.map((name) => [name, []]));
  const starts = new Map<string, { category: string; start: number }>();
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const event = raw as Record<string, unknown>;
    if (typeof event.name !== 'string' || typeof event.ts !== 'number') continue;
    const category = categories.find(
      (name) => event.name === name || (event.name as string).startsWith(`${name}.`),
    );
    if (!category) continue;
    const args =
      event.args && typeof event.args === 'object' ? (event.args as Record<string, unknown>) : {};
    const key = JSON.stringify([event.pid, args.correlationId, event.name, event.tid]);
    if (event.ph === 'B') starts.set(key, { category, start: event.ts });
    if (event.ph === 'E') {
      const start = starts.get(key);
      if (start && event.ts >= start.start) intervals.get(category)!.push([start.start, event.ts]);
      starts.delete(key);
    }
    if (event.ph === 'X' && typeof event.dur === 'number' && event.dur >= 0)
      intervals.get(category)!.push([event.ts, event.ts + event.dur]);
  }
  return Object.fromEntries(
    [...intervals].map(([category, values]) => {
      values.sort((a, b) => a[0] - b[0]);
      let elapsed = 0;
      let active: [number, number] | undefined;
      for (const interval of values) {
        if (!active) active = [...interval];
        else if (interval[0] > active[1]) {
          elapsed += active[1] - active[0];
          active = [...interval];
        } else active[1] = Math.max(active[1], interval[1]);
      }
      return [category, (elapsed + (active ? active[1] - active[0] : 0)) / 1000];
    }),
  );
}

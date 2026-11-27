/** Reserve one actual provider request before Pi is allowed to send it. */
export function reserveBugHunterModelRequest(
  records: {
    load(): Record<string, number> | undefined;
    save(value: Record<string, number>): void;
  },
  huntId: string,
  limit: number,
): boolean {
  if (!Number.isSafeInteger(limit) || limit <= 0 || !huntId) return false;
  const usage = records.load() ?? {};
  const used = Object.hasOwn(usage, huntId) ? usage[huntId] : 0;
  if (used === undefined || !Number.isSafeInteger(used) || used < 0 || used >= limit) return false;
  records.save({ ...usage, [huntId]: used + 1 });
  return true;
}

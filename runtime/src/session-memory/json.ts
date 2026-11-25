import type { JSONType } from 'zod';

export type MemoryJson = JSONType;

/** Parse the final model response as JSON, with undefined reserved for invalid output. */
export function parseMemoryJson(text: string): MemoryJson | undefined {
  try {
    return JSON.parse(text) as MemoryJson;
  } catch {
    return undefined;
  }
}

export function memorySummaryText(content: MemoryJson): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/** The prompt designates an empty object as a portion with no useful facts. */
export function isEmptyMemorySummary(content: MemoryJson): boolean {
  return (
    content !== null &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    Object.keys(content).length === 0
  );
}

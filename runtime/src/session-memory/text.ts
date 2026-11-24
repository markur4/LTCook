export type MemoryMessage = {
  seq: number;
  author: 'user' | 'agent' | 'tool' | 'runtime' | 'unknown';
  text: string;
};

export function estimateMemoryTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text) / 4);
}

const commonQueryWords = new Set([
  'and',
  'the',
  'for',
  'with',
  'from',
  'that',
  'this',
  'into',
  'your',
  'only',
  'then',
  'when',
]);

function queryTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const terms = normalized.match(/[\p{L}\p{N}_./-]{3,}/gu) ?? [normalized];
  const specific = terms.filter((term) => !commonQueryWords.has(term));
  return [...new Set(specific.length ? specific : terms)];
}

export function memoryPreview(text: string, budget: number, query = ''): string {
  if (estimateMemoryTokens(text) <= budget) return text;
  if (budget < 1) return '';
  const content = text.toLowerCase();
  const match = queryTerms(query)
    .sort((a, b) => b.length - a.length)
    .map((term) => content.indexOf(term))
    .find((offset) => offset >= 0);
  let start = Math.max(0, (match ?? 0) - budget);
  if (/[\uDC00-\uDFFF]/u.test(text.charAt(start))) start--;
  let end = Math.min(text.length, start + budget * 4);
  while (estimateMemoryTokens(text.slice(start, end)) > budget) {
    const excessBytes = Buffer.byteLength(text.slice(start, end)) - budget * 4;
    end -= Math.ceil(excessBytes / 4);
  }
  if (/[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
  return text.slice(start, end);
}

export function budgetMemoryText<T extends { text: string }>(
  ranked: readonly T[],
  total: number,
  query: string,
  cost: (item: T) => number,
) {
  const selected: T[] = [];
  let remaining = total;
  let incomplete = false;
  for (const item of ranked) {
    let capacity = Math.min(350, remaining - cost({ ...item, text: '' }));
    if (capacity <= 0) {
      incomplete = true;
      break;
    }
    const atCapacity = () => {
      const text = memoryPreview(item.text, capacity, query);
      return text === item.text ? item : { ...item, text, truncated: true as const };
    };
    let preview = atCapacity();
    let tokens = cost(preview);
    while (tokens > remaining && capacity > 0) {
      capacity -= tokens - remaining;
      preview = atCapacity();
      tokens = cost(preview);
    }
    if (!preview.text) {
      incomplete = true;
      break;
    }
    selected.push(preview);
    remaining -= tokens;
    incomplete ||= preview.text !== item.text;
  }
  return { selected, incomplete };
}

export function memoryRelevance(text: string, query: string): number {
  const content = text.toLowerCase();
  return queryTerms(query).filter((term) => content.includes(term)).length;
}

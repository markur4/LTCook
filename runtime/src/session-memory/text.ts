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

function* memoryIdentifierTokens(text: string) {
  for (const { 0: word, index } of text.matchAll(/[\p{L}\p{N}_./-]{3,}/gu)) {
    yield { term: word.replace(/\.+$/, ''), index };
  }
}

function memoryFilename(term: string): string | undefined {
  const slash = term.lastIndexOf('/');
  if (slash < 0) return undefined;
  const filename = term.slice(slash + 1);
  return filename.includes('.') ? filename : undefined;
}

export function memoryIdentifierMatches(text: string, identifiers: readonly string[]): Set<string> {
  const remaining = new Set(identifiers);
  const matches = new Set<string>();
  if (!remaining.size) return matches;
  for (const { term } of memoryIdentifierTokens(text)) {
    if (remaining.delete(term)) matches.add(term);
    const filename = memoryFilename(term);
    if (filename && remaining.delete(filename)) matches.add(filename);
    if (!remaining.size) break;
  }
  return matches;
}

export function memoryPreview(
  text: string,
  budget: number,
  query = '',
  identifiers: readonly string[] = [],
): string {
  if (estimateMemoryTokens(text) <= budget) return text;
  if (budget < 1) return '';
  let start: number;
  let exact: { term: string; index: number } | undefined;
  if (identifiers.length) {
    for (const token of memoryIdentifierTokens(text)) {
      const filename = memoryFilename(token.term);
      if (!identifiers.includes(token.term) && (!filename || !identifiers.includes(filename)))
        continue;
      exact = token;
      break;
    }
  }
  if (exact) {
    const lookBehind = Math.max(0, budget - estimateMemoryTokens(exact.term));
    start = Math.max(0, exact.index - lookBehind);
  } else {
    const content = text.toLowerCase();
    const match = queryTerms(query)
      .sort((a, b) => b.length - a.length)
      .map((term) => content.indexOf(term))
      .find((offset) => offset >= 0);
    start = Math.max(0, (match ?? 0) - budget);
  }
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
  identifiers: readonly string[] = [],
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
      const text = memoryPreview(item.text, capacity, query, identifiers);
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

export function missingMemoryIdentifiers(query: string, context: string): string[] {
  const identifiers = [...new Set(Array.from(memoryIdentifierTokens(query), ({ term }) => term))]
    .filter((term) => /[_./]|[a-z][A-Z]|[A-Z][0-9]/.test(term));
  const matches = memoryIdentifierMatches(context, identifiers);
  return identifiers.filter((term) => !matches.has(term));
}

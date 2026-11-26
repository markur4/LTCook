import type { MemoryFact } from './session-memory-fixtures.js';
import { memoryIdentifierMatches } from '../paseo-plugin/server/memory-text.js';

type CheckStatus = NonNullable<MemoryFact['checkStatus']>;

const namedCheck = '[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+';
const checkStatusPattern = '(pass(?:ed|es)?|success|fail(?:ed|s)?|skip(?:ped|s)?)';
const outcomeFormatting = '[ \\t`"*_~)\\]}]*';

function checkStatus(status: string): CheckStatus | undefined {
  if (/^(?:pass(?:ed|es)?|success)$/i.test(status)) return 'pass';
  if (/^fail(?:ed|s)?$/i.test(status)) return 'fail';
  if (/^skip(?:ped|s)?$/i.test(status)) return 'skip';
}

function namedOutcomePatterns(name: string) {
  const between = `${outcomeFormatting}(?:[:=|–—-]${outcomeFormatting})?`;
  const forwardBetween = `${outcomeFormatting}(?:[:=|–—-]${outcomeFormatting}(?:\\r?\\n${outcomeFormatting})?)?`;
  return [
    new RegExp(`(?<![\\w.-])(${name})${forwardBetween}${checkStatusPattern}\\b`, 'giu'),
    new RegExp(
      `(?<![\\w.-])${checkStatusPattern}\\b${between}(${name})(?![\\w-]|\\.[\\w-])`,
      'giu',
    ),
  ];
}

function reversedOutcomes(value: string, pattern: RegExp) {
  const [forward] = namedOutcomePatterns(namedCheck);
  const boundStatuses = new Set(
    [...value.matchAll(forward!)]
      .filter(([, name]) => name === name?.toUpperCase())
      .map((match) => match.index + match[0].length - match[2]!.length),
  );
  return [...value.matchAll(pattern)].filter((match) => !boundStatuses.has(match.index));
}

function namedStringOutcome(value: string, identifier: string, expected: CheckStatus) {
  const exact = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [forward, reverse] = namedOutcomePatterns(exact);
  return (
    [...value.matchAll(forward!)].some(
      ([, name, status]) => name === identifier && checkStatus(status!) === expected,
    ) ||
    reversedOutcomes(value, reverse!).some(
      ([, status, name]) => name === identifier && checkStatus(status!) === expected,
    )
  );
}

function hasNamedOutcome(text: string, identifier: string, expected: CheckStatus) {
  function visit(value: unknown): boolean {
    if (typeof value === 'string') {
      return namedStringOutcome(value, identifier, expected);
    }
    if (Array.isArray(value)) return value.some(visit);
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    const named = ['test', 'name', 'check', 'identifier', 'id'].some(
      (key) => record[key] === identifier,
    );
    if (
      named &&
      ['status', 'result', 'outcome', 'observed_status'].some(
        (key) => typeof record[key] === 'string' && checkStatus(record[key].trim()) === expected,
      )
    )
      return true;
    return Object.values(record).some(visit);
  }
  try {
    return visit(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')));
  } catch {
    return visit(text);
  }
}

export function matchesMemoryFact(fact: MemoryFact, text: string) {
  return (
    (!fact.identifiers ||
      memoryIdentifierMatches(text, fact.identifiers).size === fact.identifiers.length) &&
    (fact.check
      ? hasNamedOutcome(text, fact.check, fact.checkStatus ?? 'pass')
      : fact.expected.test(text))
  );
}

export function contradictsMemoryFact(fact: MemoryFact, text: string) {
  return fact.check
    ? (['pass', 'fail', 'skip'] as const).some(
        (status) =>
          status !== (fact.checkStatus ?? 'pass') && hasNamedOutcome(text, fact.check!, status),
      )
    : !!fact.contradicts?.test(text) &&
        (!fact.identifiers ||
          memoryIdentifierMatches(text, fact.identifiers).size === fact.identifiers.length);
}

/** Read only explicit named outcomes so attempts with the same identifier can remain distinct. */
export function namedMemoryOutcomes(text: string) {
  const outcomes = new Map<string, { name: string; status: CheckStatus }>();
  function add(name: string, value: string) {
    if (!/^[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+$/.test(name)) return;
    const status = checkStatus(value.trim());
    if (status) outcomes.set(JSON.stringify([name, status]), { name, status });
  }
  function visit(value: unknown): void {
    if (typeof value === 'string') {
      const [forward, reverse] = namedOutcomePatterns(namedCheck);
      for (const [index, matches] of [
        value.matchAll(forward!),
        reversedOutcomes(value, reverse!),
      ].entries()) {
        for (const [, first, second] of matches) {
          const outcomeName = index === 0 ? first! : second!;
          const status = index === 0 ? second! : first!;
          add(outcomeName, status);
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const name = ['test', 'name', 'check', 'identifier', 'id']
        .map((field) => record[field])
        .find((item): item is string => typeof item === 'string');
      const status = ['status', 'result', 'outcome', 'observed_status']
        .map((field) => record[field])
        .find((item): item is string => typeof item === 'string');
      if (name && status) add(name, status);
      Object.values(record).forEach(visit);
    }
  }
  try {
    visit(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')));
  } catch {
    visit(text);
  }
  return [...outcomes.values()];
}

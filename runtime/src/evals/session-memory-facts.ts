import type { MemoryFact } from './session-memory-fixtures.js';
import { memoryIdentifierMatches } from '../session-memory/text.js';

type CheckStatus = 'pass' | 'fail' | 'skip';

function checkStatus(status: string): CheckStatus | undefined {
  if (/^(?:pass(?:ed)?|success)$/i.test(status)) return 'pass';
  if (/^fail(?:ed)?$/i.test(status)) return 'fail';
  if (/^skip(?:ped)?$/i.test(status)) return 'skip';
}

function hasNamedOutcome(text: string, identifier: string, expected: CheckStatus) {
  const exact = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = '(?<![\\w.-])' + exact + '(?![\\w-]|\\.[\\w-])';
  const pair = new RegExp(name + '[`"\\])]*\\s*(?:[:=–-]\\s*)?([A-Za-z]+)\\b', 'gu');
  function visit(value: unknown): boolean {
    if (typeof value === 'string') {
      return [...value.matchAll(pair)].some(([, status]) => checkStatus(status!) === expected);
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
    (fact.check ? hasNamedOutcome(text, fact.check, 'pass') : fact.expected.test(text))
  );
}

export function contradictsMemoryFact(fact: MemoryFact, text: string) {
  return fact.check
    ? hasNamedOutcome(text, fact.check, 'fail')
    : !!fact.contradicts?.test(text) &&
        (!fact.identifiers ||
          memoryIdentifierMatches(text, fact.identifiers).size === fact.identifiers.length);
}

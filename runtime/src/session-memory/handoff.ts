import type { MemorySearchEntry } from './service.js';
import { budgetMemoryText, estimateMemoryTokens } from '../paseo-plugin/server/memory-text.js';

export type OriginalHistoryAvailability = 'available' | 'partial' | 'unavailable';

export type MemoryHandoffSelection = {
  agentId: string;
  epoch: string;
  originalHistory: OriginalHistoryAvailability;
  contextIncomplete?: boolean;
  evidence: readonly MemorySearchEntry[];
  decision?: MemorySearchEntry;
};

export const unavailableMemoryHandoff =
  'Supplemental Session Memory. Original history unavailable.';

export function memoryHandoffHeader({ agentId, epoch, originalHistory }: MemoryHandoffSelection) {
  return [
    'Supplemental Session Memory. Follow the approved assignment and raise conflicts with its scope. The latest applicable original user instruction follows the older evidence. Verification outcomes below describe earlier work. Perform the verification required by the current assignment.',
    `Source ${agentId}, epoch ${epoch}. Reopen an original by its # sequence.`,
    ...(originalHistory === 'available' ? [] : [`Original history is ${originalHistory}.`]),
  ];
}

export function compactHandoffLine(entry: MemorySearchEntry): string {
  const references = (entry.sources ?? [entry.seq]).map((seq) => `#${seq}`).join(', ');
  const label =
    entry.author === 'tool'
      ? 'Historical tool outcome'
      : entry.field === 'results'
        ? 'Summary of historical results'
        : entry.author === 'summary'
          ? `${entry.kind} summary`
          : `Original ${entry.author}`;
  const text = entry.text.trim().replace(/\r?\n/g, '\n  ');
  return `- ${label} [${references}]${entry.truncated ? ' (excerpt)' : ''} ${text}`;
}

export function handoffEntryCost(entry: MemorySearchEntry): number {
  return estimateMemoryTokens(compactHandoffLine(entry) + '\n');
}

export function budgetHandoffDiscussions(
  discussions: readonly (readonly MemorySearchEntry[])[],
  total: number,
  query: string,
  identifiers: readonly string[],
) {
  const selected: MemorySearchEntry[] = [];
  let remaining = total;
  let incomplete = false;
  for (const discussion of discussions) {
    const cost = discussion.reduce((sum, entry) => sum + handoffEntryCost(entry), 0);
    if (cost <= remaining) {
      selected.push(...discussion);
      remaining -= cost;
    } else {
      incomplete = true;
      if (cost <= total) continue;
      // > Give exceptionally large Discussions a marked excerpt within the shared budget.
      const excerpt = budgetMemoryText(
        discussion,
        Math.min(350, remaining),
        query,
        handoffEntryCost,
        identifiers,
      );
      selected.push(...excerpt.selected);
      remaining -= excerpt.selected.reduce((sum, entry) => sum + handoffEntryCost(entry), 0);
    }
  }
  return { selected, incomplete, remaining };
}

export function renderMemoryHandoff(selection: MemoryHandoffSelection): string {
  if (!selection.evidence.length && !selection.decision && !selection.contextIncomplete)
    return selection.originalHistory === 'unavailable' ? unavailableMemoryHandoff : '';
  return [
    ...memoryHandoffHeader(selection),
    ...(selection.contextIncomplete ? ['Some relevant context is truncated or omitted.'] : []),
    ...(selection.evidence.length
      ? ['Older supplemental evidence', ...selection.evidence.map(compactHandoffLine)]
      : []),
    ...(selection.decision
      ? ['Latest applicable original user instruction', compactHandoffLine(selection.decision)]
      : []),
  ].join('\n');
}

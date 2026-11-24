import type { MemorySearchEntry } from './service.js';

export type OriginalHistoryAvailability = 'available' | 'partial' | 'unavailable';

export type MemoryHandoffSelection = {
  agentId: string;
  epoch: string;
  originalHistory: OriginalHistoryAvailability;
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

export function renderMemoryHandoff(selection: MemoryHandoffSelection): string {
  if (!selection.evidence.length && !selection.decision)
    return selection.originalHistory === 'unavailable' ? unavailableMemoryHandoff : '';
  return [
    ...memoryHandoffHeader(selection),
    ...(selection.evidence.length
      ? ['Older supplemental evidence', ...selection.evidence.map(compactHandoffLine)]
      : []),
    ...(selection.decision
      ? ['Latest applicable original user instruction', compactHandoffLine(selection.decision)]
      : []),
  ].join('\n');
}

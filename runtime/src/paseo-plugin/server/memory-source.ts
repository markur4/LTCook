import type { PaseoApi } from '@getpaseo/client';

export type MemoryMessage = {
  seq: number;
  author: 'user' | 'agent' | 'tool' | 'runtime' | 'unknown';
  text: string;
};

export type PaseoMemoryMessage = MemoryMessage & {
  turnId?: string;
  messageId?: string;
  timestamp?: string;
  runtimeAssignment?: true;
  tool?: {
    kind: string;
    name: string;
    status: string;
    exitCode?: number;
    filePath?: string;
  };
};

type TimelineHandle = ReturnType<PaseoApi['agents']['ref']>['timeline'];
type Timeline = Awaited<ReturnType<TimelineHandle['refetch']>>;

function hasCurrentHistory(page: Timeline) {
  return (
    page.agent &&
    !page.agent.archivedAt &&
    !page.error &&
    !page.reset &&
    !page.staleCursor &&
    !page.gap
  );
}

export async function readPaseoMemoryPassage(
  timeline: TimelineHandle,
  tail: Timeline,
  turnId: string,
  signal: AbortSignal,
) {
  if (signal.aborted || !hasCurrentHistory(tail)) return;
  let page = tail;
  let sources = readMemoryMessages(tail.entries);
  let index = sources.findLastIndex(
    (source) => source.turnId === turnId && (source.author === 'agent' || source.author === 'tool'),
  );
  const position = sources[index]?.seq;
  if (position === undefined) return;

  const passage = { epoch: tail.epoch, start: position, position };
  index--;
  while (true) {
    // > Use the same source entries as Session Memory, including its turn boundaries.
    for (; index >= 0; index--) {
      const source = sources[index]!;
      if (source.turnId !== turnId) return passage;
      passage.start = Math.min(passage.start, source.seq);
    }
    if (!page.hasOlder) return passage;
    const cursor = page.startCursor;
    if (!cursor) return;
    page = await timeline.refetch({
      direction: 'before',
      projection: 'canonical',
      cursor,
      limit: 48,
    });
    if (
      signal.aborted ||
      !hasCurrentHistory(page) ||
      page.epoch !== tail.epoch ||
      !page.startCursor ||
      page.startCursor.seq >= cursor.seq
    )
      return;
    sources = readMemoryMessages(page.entries);
    index = sources.length - 1;
  }
}

export function readMemoryMessages(
  entries: Timeline['entries'],
  identifyPromptAuthor: (id?: string) => PaseoMemoryMessage['author'] = () => 'unknown',
): PaseoMemoryMessage[] {
  return entries
    .flatMap(({ seqEnd, turnId, timestamp, item }): PaseoMemoryMessage[] => {
      const origin = { seq: seqEnd, turnId, timestamp };
      switch (item.type) {
        case 'user_message': {
          const author = identifyPromptAuthor(item.clientMessageId);
          const runtimeAssignment =
            author === 'runtime' &&
            /^Assignment ID: .+\. Task ID: .+\. Attempt: \d+\.\n/.test(item.text);
          return [
            {
              ...origin,
              messageId: item.messageId ?? item.clientMessageId,
              author,
              ...(runtimeAssignment ? { runtimeAssignment: true as const } : {}),
              text: item.text,
            },
          ];
        }
        case 'assistant_message':
          return [{ ...origin, messageId: item.messageId, author: 'agent', text: item.text }];
        case 'tool_call': {
          if (item.status === 'running') return [];
          // > Paseo displays delivered peer and system prompts as tool cards.
          if (item.agentMessage)
            return [
              {
                ...origin,
                messageId: item.callId,
                author: 'runtime',
                text: item.agentMessage.text,
              },
            ];
          if (
            item.name === 'heartbeat' &&
            item.callId.startsWith('paseo-system:') &&
            item.detail.type === 'plain_text'
          )
            return [
              {
                ...origin,
                messageId: item.callId,
                author: 'runtime',
                text: item.detail.text ?? '',
              },
            ];
          const result = toolOutcome(item);
          return result
            ? [
                {
                  ...origin,
                  messageId: item.callId,
                  author: 'tool',
                  text: result,
                  tool: {
                    kind: item.detail.type,
                    name: item.name,
                    status: item.status,
                    exitCode:
                      item.detail.type === 'shell'
                        ? (item.detail.exitCode ?? undefined)
                        : undefined,
                    filePath:
                      item.detail.type === 'edit' ||
                      item.detail.type === 'write' ||
                      item.detail.type === 'read'
                        ? item.detail.filePath
                        : undefined,
                  },
                },
              ]
            : [];
        }
        default:
          return [];
      }
    })
    .filter(({ text }) => text.trim().length > 0);
}

/** Preserve typed tool results and verification lines while omitting commands and arbitrary logs. */
function toolOutcome(
  item: Extract<Timeline['entries'][number]['item'], { type: 'tool_call' }>,
): string | undefined {
  if (item.status === 'running') return undefined;
  const { detail, status } = item;
  switch (detail.type) {
    case 'shell':
      return [
        typeof detail.exitCode === 'number'
          ? `Shell command ${status} with exit code ${detail.exitCode}.`
          : `Shell command ${status}.`,
        ...verificationLines(detail.output),
      ].join('\n');
    case 'edit':
    case 'write':
    case 'read':
      return `File ${detail.type} ${status} for ${JSON.stringify(detail.filePath)}.`;
    case 'search':
      return detail.toolName !== 'web_search' && typeof detail.numMatches === 'number'
        ? [
            `Workspace search ${status} with ${detail.numMatches} matches.`,
            ...(detail.filePaths ?? []),
          ].join('\n')
        : undefined;
    default:
      return undefined;
  }
}

function verificationLines(output?: string): string[] {
  if (!output) return [];
  return output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .filter((line) => {
      const result =
        /^\s*(?:\((?:pass|fail|skip)\)|[✓✗]|\d+\s+(?:passed|failed|skipped)|[A-Z][A-Z0-9_.-]*\s+(?:PASS|FAIL)\b|(?:prefill|generation|benchmark)\b.*\d)/i;
      return (
        result.test(line) &&
        !/\b(?:secret|password|credential|authorization|api[_ -]?key)\b/i.test(line)
      );
    });
}

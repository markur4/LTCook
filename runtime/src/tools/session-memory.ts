import { Type } from 'typebox';
import { SESSION_MEMORY_TOOL_NAME } from './workspace-tools.js';
import { defineTool } from './types.js';
import type { ConversationRecords } from '../session-memory/conversation.js';

const agentId = Type.String({ minLength: 1, maxLength: 200 });
const epoch = Type.String({ minLength: 1, maxLength: 200 });
const seq = Type.Integer({ minimum: 0 });
const reference = { agentId, epoch, seq };

export const sessionMemoryDescription =
  'Search original conversation evidence from your chat and authorized teammates. Reopen a cited original with its agent ID, epoch, and # sequence. An exact lookup reports whether the source was found and the latest known sequence where available. resultsTruncated means the reply is a bounded selection. originalHistory reports access to the history. Tool results describe earlier work. Verify the current work according to the approved assignment.';

export const sessionMemoryInput = Type.Object(
  {
    query: Type.Optional(Type.String({ maxLength: 500 })),
    agentId: Type.Optional(agentId),
    source: Type.Optional(Type.Object(reference, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

const result = Type.Object({
  status: Type.Object({
    resultsTruncated: Type.Boolean(),
    originalHistory: Type.Union([
      Type.Literal('available'),
      Type.Literal('partial'),
      Type.Literal('unavailable'),
    ]),
  }),
  lookup: Type.Optional(
    Type.Union([Type.Literal('found'), Type.Literal('not-found'), Type.Literal('unavailable')]),
  ),
  latestSequence: Type.Optional(Type.Integer({ minimum: -1 })),
  matches: Type.Array(
    Type.Object({
      agentId,
      epoch,
      entries: Type.Array(
        Type.Object({
          kind: Type.String(),
          author: Type.String(),
          text: Type.String(),
          truncated: Type.Optional(Type.Literal(true)),
          seq,
          tool: Type.Optional(
            Type.Object({
              kind: Type.String(),
              name: Type.String(),
              status: Type.String(),
              exitCode: Type.Optional(Type.Number()),
              filePath: Type.Optional(Type.String()),
            }),
          ),
        }),
      ),
    }),
  ),
  source: Type.Optional(
    Type.Object({
      ...reference,
      author: Type.String(),
      text: Type.String(),
      attachments: Type.Optional(
        Type.Array(Type.Object({ id: Type.String(), name: Type.String(), text: Type.String() })),
      ),
    }),
  ),
});

export function createSessionMemoryTool(memory: ConversationRecords) {
  return defineTool({
    name: SESSION_MEMORY_TOOL_NAME,
    description: sessionMemoryDescription,
    inputSchema: sessionMemoryInput,
    outputSchema: result,
    async execute(input, context) {
      if (!input.source)
        return memory.search(
          context.agentId,
          context.workspaceRoot,
          input.query,
          input.agentId,
          context.signal,
        );
      const found = await memory.sourceMessage(
        context.agentId,
        context.workspaceRoot,
        input.source,
        context.signal,
      );
      return {
        status: {
          resultsTruncated: false,
          originalHistory:
            found.lookup === 'unavailable' ? ('unavailable' as const) : ('available' as const),
        },
        matches: [],
        ...found,
      };
    },
  });
}

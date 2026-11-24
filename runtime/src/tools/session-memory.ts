import { Type } from 'typebox';
import { SESSION_MEMORY_TOOL_NAME } from '../paseo-plugin/shared/workspace-tools.js';
import { defineTool } from './types.js';
import type { SessionMemory } from '../session-memory/service.js';

const agentId = Type.String({ minLength: 1, maxLength: 200 });
const epoch = Type.String({ minLength: 1, maxLength: 200 });
const seq = Type.Integer({ minimum: 0 });
const reference = { agentId, epoch, seq };

export const sessionMemoryDescription =
  'Search original conversation messages and UAMP or AAB summaries from your Session Memory and authorized teammates. Use specific terms. Summary source sequences refer to the original evidence. Read a full source with its agent ID, epoch, and sequence number. Original user instructions remain authoritative.';

export const sessionMemoryInput = Type.Object(
  {
    query: Type.Optional(Type.String({ maxLength: 500 })),
    agentId: Type.Optional(agentId),
    source: Type.Optional(Type.Object(reference, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

const result = Type.Object({
  incomplete: Type.Boolean(),
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
          sources: Type.Optional(Type.Array(seq)),
          userSources: Type.Optional(Type.Array(seq)),
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

export function createSessionMemoryTool(memory: SessionMemory) {
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
      const source = await memory.sourceMessage(
        context.agentId,
        context.workspaceRoot,
        input.source,
      );
      return { incomplete: source === undefined, matches: [], ...(source ? { source } : {}) };
    },
  });
}

import { Type } from 'typebox';
import type { SessionWorktrees, WorktreeScope } from '../integrations/session-worktrees.js';
import {
  WORKTREE_TOOL_DESCRIPTION,
  WORKTREE_TOOL_NAME,
} from '../paseo-plugin/shared/workspace-tools.js';
import { defineTool, type ToolContext } from './types.js';

export const worktreeToolInput = Type.Object(
  {
    operation: Type.Union([Type.Literal('use'), Type.Literal('release')]),
    path: Type.String({ minLength: 1, maxLength: 8192 }),
    passId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

export function createSessionWorktreeTool(
  worktrees: SessionWorktrees,
  scopeFor: (context: ToolContext, passId?: string) => WorktreeScope,
) {
  return defineTool({
    name: WORKTREE_TOOL_NAME,
    description: WORKTREE_TOOL_DESCRIPTION,
    inputSchema: worktreeToolInput,
    outputSchema: Type.Object({ ok: Type.Literal(true) }),
    async execute({ operation, path, passId }, context) {
      const scope = scopeFor(context, passId);
      if (operation === 'use') await worktrees.register(scope, path, context.signal);
      else worktrees.clear(scope, path);
      return { ok: true as const };
    },
  });
}

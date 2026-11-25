import { defineSubscription } from '@getpaseo/plugin';
import { z } from 'zod';

const worktree = z.object({ path: z.string().min(1), branch: z.string().optional() });

export const SessionWorktreesSchema = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  original: z.string().min(1),
  following: worktree.nullable(),
  available: z.array(worktree),
});

export const sessionWorktreesSubscription = defineSubscription({
  name: 'ltcook.session.worktrees',
  input: z.object({ agentId: z.string().min(1) }),
  event: SessionWorktreesSchema,
});

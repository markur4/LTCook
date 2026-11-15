import { z } from 'zod';
export const EvalRequestSchema = z.object({
  action: z.enum(['start', 'list', 'status', 'report', 'cancel', 'delete']),
  preset: z.enum(['quick', 'audit', 'behavior', 'bottlenecks', 'full']).optional(),
  setup: z.enum(['current', 'synthetic']).optional(),
  staticOnly: z.boolean().optional(),
  workspaceRoot: z.string().optional(),
  runId: z.string().uuid().optional(),
  after: z.number().int().nonnegative().optional(),
});
export const EvalResponseSchema = z.unknown();

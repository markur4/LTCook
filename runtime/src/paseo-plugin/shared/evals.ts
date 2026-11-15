import { z } from 'zod';
export const EvalRequestSchema = z.object({
  action: z.enum(['start', 'list', 'status', 'report', 'cancel', 'delete']),
  preset: z.enum(['quick', 'audit', 'behavior', 'bottlenecks', 'full']).optional(),
  runId: z.string().uuid().optional(),
  after: z.number().int().nonnegative().optional(),
});
export const EvalResponseSchema = z.unknown();

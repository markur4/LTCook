import { z } from 'zod';

export const EvalSetupSchema = z.enum(['current', 'synthetic']);
export type EvalSetup = z.infer<typeof EvalSetupSchema>;

export const EvalPresetSchema = z.enum(['quick', 'audit', 'behavior', 'bottlenecks', 'full']);
export type EvalPreset = z.infer<typeof EvalPresetSchema>;

export const EvalStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
export type EvalStatus = z.infer<typeof EvalStatusSchema>;

export const EvalStartRequestSchema = z
  .object({
    preset: EvalPresetSchema,
    setup: EvalSetupSchema.default('current'),
    workspaceRoot: z.string().min(1).optional(),
    staticOnly: z.boolean().optional(),
  })
  .refine((input) => !input.staticOnly || input.preset === 'audit', {
    message: 'staticOnly requires the audit preset',
  });
export type EvalStartRequest = z.infer<typeof EvalStartRequestSchema>;
export const EvalRunIdSchema = z.object({ runId: z.string().uuid() });
export const EvalStatusRequestSchema = EvalRunIdSchema.extend({
  after: z.number().int().nonnegative().optional(),
});
export const EvalDeleteRequestSchema = EvalRunIdSchema;

export const EvalEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  runId: z.string().uuid(),
  event: z.enum([
    'run.started',
    'suite.started',
    'case.started',
    'case.completed',
    'case.failed',
    'run.completed',
    'run.failed',
    'run.cancelled',
    'run.interrupted',
  ]),
  suite: z.string().optional(),
  case: z.string().optional(),
  status: EvalStatusSchema,
  completed: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().nonnegative(),
  message: z.string().max(300).optional(),
  createdAt: z.string().datetime(),
});
export type EvalEvent = z.infer<typeof EvalEventSchema>;

export const EvalSummarySchema = z.object({
  schema: z.literal(2),
  runId: z.string().uuid(),
  preset: EvalPresetSchema,
  setup: EvalSetupSchema,
  staticOnly: z.boolean(),
  teamSelection: z.string().optional(),
  model: z.string().optional(),
  fixtureRevision: z.string().optional(),
  provenance: z.unknown().optional(),
  limitations: z.array(z.string()).default([]),
  status: EvalStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  currentSuite: z.string().optional(),
  currentCase: z.string().optional(),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  error: z.string().max(500).optional(),
});
export type EvalSummary = z.infer<typeof EvalSummarySchema>;

export const EvalStatusResponseSchema = z.object({
  summary: EvalSummarySchema,
  events: z.array(EvalEventSchema),
  next: z.number().int().nonnegative(),
});
export const EvalListResponseSchema = z.object({ runs: z.array(EvalSummarySchema) });
export const EvalReportResponseSchema = z.object({
  summary: EvalSummarySchema,
  result: z.unknown().nullable(),
  trace: z.unknown().nullable(),
});
export const EvalStartResponseSchema = z.object({ runId: z.string().uuid() });
export const EvalDeleteResponseSchema = z.object({ deleted: z.literal(true) });

export type EvalStatusResponse = z.infer<typeof EvalStatusResponseSchema>;
export type EvalReportResponse = z.infer<typeof EvalReportResponseSchema>;

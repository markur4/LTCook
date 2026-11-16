import { z } from 'zod';

export const EvalSetupSchema = z.enum(['current', 'synthetic']);
export type EvalSetup = z.infer<typeof EvalSetupSchema>;

export const EvalPresetSchema = z.enum(['quick', 'audit', 'behavior', 'bottlenecks', 'full']);
export type EvalPreset = z.infer<typeof EvalPresetSchema>;
export const EvalScenarioSchema = z.enum(['read-only', 'no-op', 'targeted-fix']);
export type EvalScenario = z.infer<typeof EvalScenarioSchema>;

// > Only settings consumed by Current Setup cross the authenticated API boundary.
export const EvalEnvironmentOverridesSchema = z
  .object({
    LTCOOK_TEAM: z.string().optional(),
    LTCOOK_GUIDANCE_DIR: z.string().optional(),
    LTCOOK_SEARXNG_URL: z.string().optional(),
    LTCOOK_CRAWL4AI_URL: z.string().optional(),
    LTCOOK_SSRF_ALLOW_RANGES: z.string().optional(),
  })
  .strict();
export type EvalEnvironmentOverrides = z.infer<typeof EvalEnvironmentOverridesSchema>;

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
    sessionId: z.string().min(1).optional(),
    staticOnly: z.boolean().optional(),
    repetitions: z.number().int().positive().default(1),
    scenario: EvalScenarioSchema.optional(),
    environmentOverrides: EvalEnvironmentOverridesSchema.optional(),
  })
  .refine((input) => !input.staticOnly || input.preset === 'audit', {
    message: 'staticOnly requires the audit preset',
  })
  .refine((input) => input.preset !== 'audit' || input.repetitions === 1, {
    message: 'Instruction Audit does not repeat behavioral cases',
  })
  .refine((input) => !input.scenario || !['audit', 'quick'].includes(input.preset), {
    message: 'A selected case requires Behavior Evaluation or Bottleneck Attribution',
  })
  .refine((input) => !input.environmentOverrides || input.setup === 'current', {
    message: 'Environment overrides require Current Setup',
  });
export type EvalStartRequest = z.input<typeof EvalStartRequestSchema>;

/** Count checks once even when Behavior Evaluation and Bottleneck Attribution share execution. */
export function evaluationCaseCount(input: EvalStartRequest): number {
  if (input.staticOnly) return 1;
  if (input.preset === 'audit') return 2;
  if (input.preset === 'quick') return 1 + (input.repetitions ?? 1);
  const cases = (input.scenario ? 1 : 3) * (input.repetitions ?? 1);
  return input.preset === 'full' ? 2 + cases : cases;
}
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
  schema: z.literal(3),
  runId: z.string().uuid(),
  preset: EvalPresetSchema,
  setup: EvalSetupSchema,
  staticOnly: z.boolean(),
  repetitions: z.number().int().positive(),
  scenario: EvalScenarioSchema.optional(),
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

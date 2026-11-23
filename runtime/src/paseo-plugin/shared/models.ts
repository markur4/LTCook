import { z } from 'zod';

export const MODEL_ALIAS_METADATA_KEY = 'ltcook.model-alias';
export const MODEL_REASONING_METADATA_KEY = 'ltcook.reasoning';
export const RESOLVED_MODEL_METADATA_KEY = 'ltcook.resolved-model';

export const ReasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export const ModelResolutionSourceSchema = z.enum(['session', 'team', 'alias', 'default']);

export const ResolvedModelSchema = z.object({
  alias: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoning: ReasoningEffortSchema.optional(),
  preset: ReasoningEffortSchema.optional(),
  reasoningSource: ModelResolutionSourceSchema,
});

export const ModelCatalogRequestSchema = z.object({
  teamSelection: z.string().min(1),
});

export const ModelCatalogResponseSchema = z
  .object({
    teamAlias: z.string().min(1),
    aliases: z.array(
      ResolvedModelSchema.extend({
        reasoningOptions: z.array(ReasoningEffortSchema).optional(),
        configurationError: z.string().optional(),
      }),
    ),
  })
  .superRefine(({ teamAlias, aliases }, context) => {
    if (!aliases.some((item) => item.alias === teamAlias)) {
      context.addIssue({
        code: 'custom',
        message: 'The selected Team alias must be included in the model catalog.',
        path: ['teamAlias'],
      });
    }
    if (new Set(aliases.map((item) => item.alias)).size !== aliases.length) {
      context.addIssue({
        code: 'custom',
        message: 'Model aliases must be unique.',
        path: ['aliases'],
      });
    }
  });

export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type ModelResolutionSource = z.infer<typeof ModelResolutionSourceSchema>;
export type ResolvedModel = z.infer<typeof ResolvedModelSchema>;
export type ModelCatalogResponse = z.infer<typeof ModelCatalogResponseSchema>;

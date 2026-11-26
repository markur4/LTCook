import { z } from 'zod';

export const MODEL_ALIAS_METADATA_KEY = 'ltcook.model-alias';
export const MODEL_REASONING_METADATA_KEY = 'ltcook.reasoning';
export const RESOLVED_MODEL_METADATA_KEY = 'ltcook.resolved-model';

export const MODEL_ALIASES = [
  'smol',
  'tiny',
  'local-CPU',
  'local-tiny',
  'local-evals',
  'smart',
  'plan',
  'expensive',
  'review-art',
] as const;
export const ModelAliasSchema = z.enum(MODEL_ALIASES);
export type ModelAlias = z.infer<typeof ModelAliasSchema>;

export const ReasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

export const ModelResolutionSourceSchema = z.enum(['session', 'team', 'alias', 'default']);
export type ModelResolutionSource = z.infer<typeof ModelResolutionSourceSchema>;

/** Wire and presentation values also accept provider-native model names. */
export const ResolvedModelDtoSchema = z.object({
  alias: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoning: ReasoningEffortSchema.optional(),
  preset: ReasoningEffortSchema.optional(),
  reasoningSource: ModelResolutionSourceSchema,
});
export type ResolvedModelDto = z.infer<typeof ResolvedModelDtoSchema>;

export const ModelCatalogRequestSchema = z.object({
  teamSelection: z.string().min(1),
});
export type ModelCatalogRequest = z.infer<typeof ModelCatalogRequestSchema>;

export const ModelCatalogResponseSchema = z
  .object({
    teamAlias: z.string().min(1),
    aliases: z.array(
      ResolvedModelDtoSchema.extend({
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
export type ModelCatalogResponse = z.infer<typeof ModelCatalogResponseSchema>;

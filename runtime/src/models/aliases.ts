import { z } from 'zod';

export const MODEL_ALIASES = [
  'smol',
  'tiny',
  'tiny-local',
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

const providerId = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const modelId =
  /^[a-zA-Z0-9][a-zA-Z0-9._+-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._+-]*)*(?::[a-zA-Z0-9][a-zA-Z0-9._+-]*)?$/;

export const ResolvedModelSchema = z.object({
  alias: ModelAliasSchema,
  provider: z.string().regex(providerId),
  model: z.string().regex(modelId),
  reasoning: ReasoningEffortSchema.optional(),
  preset: ReasoningEffortSchema.optional(),
  reasoningSource: z.enum(['session', 'team', 'alias', 'default']),
});
export type ResolvedModel = z.infer<typeof ResolvedModelSchema>;

const aliases: Readonly<Record<ModelAlias, { setting: string; preset?: ReasoningEffort }>> = {
  smol: { setting: 'LTCOOK_MODEL_SMOL' },
  tiny: { setting: 'LTCOOK_MODEL_SMOL', preset: 'low' },
  'tiny-local': { setting: 'LTCOOK_MODEL_TINY_LOCAL', preset: 'none' },
  smart: { setting: 'LTCOOK_MODEL_SMART' },
  plan: { setting: 'LTCOOK_MODEL_SMART', preset: 'xhigh' },
  expensive: { setting: 'LTCOOK_MODEL_EXPENSIVE' },
  'review-art': { setting: 'LTCOOK_MODEL_EXPENSIVE', preset: 'medium' },
};

const hostedReasoning = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const lunaReasoning = ['none', ...hostedReasoning] as const;
const ollamaReasoning = ['none', 'low', 'high'] as const;

/** Reasoning levels that can retain their meaning across the supported adapters. */
export function reasoningOptions({
  alias,
  provider,
  model,
}: Pick<ResolvedModel, 'alias' | 'provider' | 'model'>): readonly ReasoningEffort[] {
  if (alias === 'tiny-local' || provider === 'ollama') return ollamaReasoning;
  if (provider === 'openai' || provider === 'openai-codex') {
    if (model === 'gpt-6-luna') return lunaReasoning;
    if (['gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6-astra'].includes(model)) return hostedReasoning;
  }
  return ReasoningEffortSchema.options;
}

function readReasoning(value: string | undefined, source: 'Session' | 'Team member') {
  if (value === undefined) return undefined;
  const result = ReasoningEffortSchema.safeParse(value === 'off' ? 'none' : value);
  if (!result.success)
    throw new Error(
      `${source} reasoning must be one of ${ReasoningEffortSchema.options.join(', ')}.`,
    );
  return result.data;
}

function unsupportedReasoning(
  { alias, provider, model }: Pick<ResolvedModel, 'alias' | 'provider' | 'model'>,
  options: readonly ReasoningEffort[],
) {
  return new Error(`@${alias} with ${provider}/${model} supports ${options.join(', ')} reasoning.`);
}

/** Resolve one alias using the configured physical model and ordered reasoning settings. */
export function resolveModel(
  requestedAlias: unknown,
  environment: Record<string, string | undefined>,
  settings: { sessionReasoning?: string; teamReasoning?: string } = {},
): ResolvedModel {
  const parsedAlias = ModelAliasSchema.safeParse(
    typeof requestedAlias === 'string' ? requestedAlias.replace(/^@/, '') : requestedAlias,
  );
  if (!parsedAlias.success)
    throw new Error(
      `Choose a model alias: ${MODEL_ALIASES.map((alias) => `@${alias}`).join(', ')}.`,
    );
  const alias = parsedAlias.data;
  const { setting, preset } = aliases[alias];
  const configured = environment[setting]?.trim();
  if (!configured) throw new Error(`Set ${setting} in AppRC to use @${alias}.`);

  const separator = configured.indexOf('/');
  const provider = alias === 'tiny-local' ? 'ollama' : configured.slice(0, separator);
  const model = alias === 'tiny-local' ? configured : configured.slice(separator + 1);
  if (alias === 'tiny-local') {
    if (!modelId.test(model)) throw new Error(`${setting} must contain an Ollama model ID.`);
  } else {
    if (separator < 1 || !providerId.test(provider) || !modelId.test(model))
      throw new Error(`${setting} must use the provider/model format.`);
    const suffix = model.includes(':') ? model.split(':')[1] : undefined;
    if (
      provider !== 'ollama' &&
      (suffix === 'off' || ReasoningEffortSchema.safeParse(suffix).success)
    )
      throw new Error(
        `${setting} must contain only provider/model. Set reasoning in the Session or Team member.`,
      );
  }

  const overrides = [
    [settings.sessionReasoning, 'session'],
    [settings.teamReasoning || undefined, 'team'],
  ] as const;
  const override = overrides.find(([value]) => value !== undefined);
  const reasoning = override
    ? readReasoning(override[0], override[1] === 'session' ? 'Session' : 'Team member')
    : preset;
  const reasoningSource = override?.[1] ?? (preset === undefined ? 'default' : 'alias');

  const valid = reasoningOptions({ alias, provider, model });
  if (reasoning !== undefined && !valid.includes(reasoning))
    throw unsupportedReasoning({ alias, provider, model }, valid);
  return {
    alias,
    provider,
    model,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(preset !== undefined ? { preset } : {}),
    reasoningSource,
  };
}

/** Supply effective model settings for a Team Leader's alias selector. */
export function catalogModelAliases(
  member: { modelAlias: ModelAlias; thinking?: ReasoningEffort },
  environment: Record<string, string | undefined>,
) {
  return {
    teamAlias: member.modelAlias,
    aliases: MODEL_ALIASES.map((alias) => {
      const selection = resolveModel(alias, environment);
      const reasoningChoices = reasoningOptions(selection);
      if (member.thinking && !reasoningChoices.includes(member.thinking)) {
        return {
          ...selection,
          reasoningOptions: [...reasoningChoices],
          configurationError: unsupportedReasoning(selection, reasoningChoices).message,
        };
      }
      return {
        ...resolveModel(alias, environment, { teamReasoning: member.thinking }),
        reasoningOptions: [...reasoningChoices],
      };
    }),
  };
}

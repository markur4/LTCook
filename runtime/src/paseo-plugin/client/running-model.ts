import { ReasoningEffortSchema, type ResolvedModelDto } from '@ltcook/model-contracts';

/** Keep the saved alias when a user changes the model or effort through Paseo's native controls. */
export function effectiveRunningModel(
  saved: ResolvedModelDto,
  native: { model: string | null; thinking: string | null },
): ResolvedModelDto {
  const separator = native.model?.indexOf('/') ?? -1;
  const physical =
    native.model && separator > 0
      ? { provider: native.model.slice(0, separator), model: native.model.slice(separator + 1) }
      : {};
  const reasoning = ReasoningEffortSchema.safeParse(
    native.thinking === 'off' ? 'none' : native.thinking,
  ).data;
  return {
    ...saved,
    ...physical,
    reasoning: reasoning ?? saved.reasoning,
    reasoningSource:
      reasoning !== undefined && saved.reasoning !== undefined && reasoning !== saved.reasoning
        ? 'session'
        : saved.reasoningSource,
  };
}

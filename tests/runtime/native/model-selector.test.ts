import { describe, expect, test } from 'bun:test';
import {
  ModelCatalogRequestSchema,
  ModelCatalogResponseSchema,
  ResolvedModelDtoSchema,
} from '@ltcook/model-contracts';
import { ResolvedModelSchema } from '../../../runtime/src/models/aliases.js';
import { effectiveRunningModel } from '../../../runtime/src/paseo-plugin/client/running-model.js';

describe('Paseo model selection contract', () => {
  test('accepts a resolved model with session reasoning and rejects incomplete settings', () => {
    const resolved = {
      alias: 'local-tiny',
      provider: 'ollama',
      model: 'hf.co/XHToken/Spark-X2.6-4B-GGUF:Q8_0',
      reasoning: 'none',
      preset: 'none',
      reasoningSource: 'session',
    };

    expect(ResolvedModelDtoSchema.parse(resolved)).toEqual(resolved);
    expect(ResolvedModelDtoSchema.safeParse({ ...resolved, provider: undefined }).success).toBe(
      false,
    );
    expect(
      ResolvedModelDtoSchema.safeParse({ ...resolved, reasoningSource: 'provider' }).success,
    ).toBe(false);
  });

  test.each([
    ['alias', { alias: 'native-custom' }],
    ['provider name', { provider: 'Native Adapter' }],
    ['model name', { model: 'Native Model (preview)' }],
  ] as const)(
    'accepts a native %s for display while validating runtime settings',
    (_field, native) => {
      const configured = {
        alias: 'smart',
        provider: 'openai-codex',
        model: 'gpt-6.2-sol',
        reasoningSource: 'default',
      };
      const displayed = { ...configured, ...native };

      expect(ResolvedModelSchema.parse(configured)).toEqual(configured);
      expect(ResolvedModelDtoSchema.parse(displayed)).toEqual(displayed);
      expect(ResolvedModelSchema.safeParse(displayed).success).toBe(false);
    },
  );

  test('validates the selected Team and exposes each alias resolved for its Leader', () => {
    const response = {
      teamAlias: 'smart',
      aliases: [
        {
          alias: 'smart',
          provider: 'openai-codex',
          model: 'gpt-6.2-sol',
          reasoning: 'xhigh',
          preset: 'xhigh',
          reasoningSource: 'alias',
        },
        {
          alias: 'local-tiny',
          provider: 'ollama',
          model: 'hf.co/XHToken/Spark-X2.6-4B-GGUF:Q8_0',
          reasoning: 'none',
          preset: 'none',
          reasoningSource: 'alias',
          reasoningOptions: ['none', 'low', 'high'],
          configurationError: 'The Team effort is unavailable for this alias.',
        },
      ],
    };

    expect(ModelCatalogRequestSchema.safeParse({ teamSelection: '' }).success).toBe(false);
    expect(ModelCatalogRequestSchema.parse({ teamSelection: 'default' })).toEqual({
      teamSelection: 'default',
    });
    expect(ModelCatalogResponseSchema.parse(response)).toEqual(response);
    expect(
      ModelCatalogResponseSchema.safeParse({
        ...response,
        aliases: response.aliases.slice(1),
      }).success,
    ).toBe(false);
    expect(
      ModelCatalogResponseSchema.safeParse({
        ...response,
        aliases: [...response.aliases, ...response.aliases],
      }).success,
    ).toBe(false);
    expect(
      ModelCatalogResponseSchema.safeParse({
        ...response,
        aliases: response.aliases.map((item) =>
          item.alias === 'local-tiny' ? { ...item, reasoningOptions: ['unsupported'] } : item,
        ),
      }).success,
    ).toBe(false);
  });
});

test('running Paseo settings display a native override while retaining the alias', () => {
  const selected = ResolvedModelDtoSchema.parse({
    alias: 'plan',
    provider: 'openai-codex',
    model: 'gpt-6.2-sol',
    preset: 'xhigh',
    reasoning: 'high',
    reasoningSource: 'team',
  });
  expect(
    effectiveRunningModel(selected, {
      model: 'ollama/hf.co/XHToken/Spark-X2.6-4B-GGUF:Q8_0',
      thinking: 'off',
    }),
  ).toMatchObject({
    alias: 'plan',
    provider: 'ollama',
    reasoning: 'none',
    reasoningSource: 'session',
  });
});

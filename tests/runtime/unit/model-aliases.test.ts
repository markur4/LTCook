import { expect, test } from 'bun:test';
import {
  catalogModelAliases,
  reasoningOptions,
  resolveModel,
  resolveSummarizerModel,
  ResolvedModelSchema,
} from '../../../runtime/src/models/aliases.js';
import { modelCommand } from '../../../runtime/src/models/adapters.js';

const environment = {
  LTCOOK_MODEL_SMOL: 'openai-codex/gpt-6-luna',
  LTCOOK_MODEL_LOCAL_CPU: 'lfm3:1.7b-qad-q4_0',
  LTCOOK_MODEL_LOCAL_TINY: 'SparkLLM/Spark-X2.6-4B:q8_0',
  LTCOOK_MODEL_LOCAL: 'qwen3.8:27b-q4_K_M',
  LTCOOK_MODEL_SMART: 'openai-codex/gpt-6.2-sol',
  LTCOOK_MODEL_EXPENSIVE: 'openai-codex/gpt-6-astra',
  LTCOOK_OLLAMA_ENDPOINT: 'http://127.0.0.1:21434/',
};

test.each([
  ['smol', 'openai-codex', 'gpt-6-luna', undefined],
  ['tiny', 'openai-codex', 'gpt-6-luna', 'low'],
  ['local-tiny', 'ollama', environment.LTCOOK_MODEL_LOCAL_TINY, 'none'],
  ['local', 'ollama', environment.LTCOOK_MODEL_LOCAL, 'medium'],
  ['smart', 'openai-codex', 'gpt-6.2-sol', undefined],
  ['plan', 'openai-codex', 'gpt-6.2-sol', 'xhigh'],
  ['expensive', 'openai-codex', 'gpt-6-astra', undefined],
  ['review-art', 'openai-codex', 'gpt-6-astra', 'medium'],
])('resolves the advertised @%s alias', (alias, provider, model, preset) => {
  const resolved = resolveModel(`@${alias}`, environment);
  expect(resolved).toEqual({
    alias,
    provider,
    model,
    ...(preset === undefined ? {} : { preset, reasoning: preset }),
    reasoningSource: preset === undefined ? 'default' : 'alias',
  });
});

test('only the two Team local aliases can be selected', () => {
  const catalog = catalogModelAliases({ modelAlias: 'local' }, environment);
  expect(
    catalog.aliases
      .filter(({ provider }) => provider === 'ollama')
      .map(({ alias, reasoning, reasoningOptions }) => ({ alias, reasoning, reasoningOptions })),
  ).toEqual([
    { alias: 'local-tiny', reasoning: 'none', reasoningOptions: ['none', 'low', 'high'] },
    { alias: 'local', reasoning: 'medium', reasoningOptions: ['none', 'low', 'medium', 'high'] },
  ]);
  for (const alias of ['@tiny-local', '@local-cpu', '@local-evals']) {
    expect(() => resolveModel(alias, environment)).toThrow('Choose a model alias');
  }
  expect(resolveSummarizerModel(environment)).toBe(environment.LTCOOK_MODEL_LOCAL_CPU);
  expect(() => resolveSummarizerModel({})).toThrow('LTCOOK_MODEL_LOCAL_CPU');
});

test('session reasoning wins over a Team setting, which wins over the preset', () => {
  const reviewer = resolveModel('plan', environment, { teamReasoning: 'high' });
  expect(reviewer).toMatchObject({ reasoning: 'high', preset: 'xhigh', reasoningSource: 'team' });
  expect(
    resolveModel('plan', environment, { teamReasoning: 'high', sessionReasoning: 'medium' }),
  ).toMatchObject({ reasoning: 'medium', preset: 'xhigh', reasoningSource: 'session' });
  expect(resolveModel('plan', environment, { teamReasoning: '' })).toMatchObject({
    reasoning: 'xhigh',
    reasoningSource: 'alias',
  });
  expect(resolveModel('smol', environment, { sessionReasoning: 'off' })).toMatchObject({
    reasoning: 'none',
    reasoningSource: 'session',
  });
  expect(resolveModel('smol', environment, { teamReasoning: '' })).not.toHaveProperty('reasoning');
});

test('catalog evaluates the Team override before the alias preset', () => {
  const localSmart = { ...environment, LTCOOK_MODEL_SMART: 'ollama/custom' };
  const valid = catalogModelAliases({ modelAlias: 'plan', thinking: 'high' }, localSmart);
  expect(valid.aliases.find(({ alias }) => alias === 'plan')).toMatchObject({
    model: 'custom',
    preset: 'xhigh',
    reasoning: 'high',
    reasoningSource: 'team',
  });

  const invalid = catalogModelAliases({ modelAlias: 'plan' }, localSmart);
  expect(invalid.aliases.find(({ alias }) => alias === 'plan')).toMatchObject({
    configurationError: expect.stringContaining('supports none, low, high'),
    reasoningOptions: ['none', 'low', 'high'],
  });
  expect(invalid.aliases.find(({ alias }) => alias === 'tiny')?.reasoning).toBe('low');
});

test('saved settings retain the resolved provider, model, and reasoning when settings change', () => {
  const selected = resolveModel('plan', environment, { teamReasoning: 'high' });
  const restored = ResolvedModelSchema.parse(JSON.parse(JSON.stringify(selected)));
  expect(restored).toEqual(selected);
  const updated = resolveModel('plan', {
    ...environment,
    LTCOOK_MODEL_SMART: 'openai/gpt-6.1-sol',
  });
  expect(modelCommand('pi', restored, environment).args).toEqual([
    '--provider',
    'openai-codex',
    '--model',
    'gpt-6.2-sol',
    '--thinking',
    'high',
  ]);
  expect(updated).toMatchObject({ provider: 'openai', model: 'gpt-6.1-sol', reasoning: 'xhigh' });
});

test('validates the selected AppRC setting and the effective reasoning level', () => {
  expect(() => resolveModel('@missing', environment)).toThrow('Choose a model alias');
  expect(() => resolveModel('plan', {})).toThrow('LTCOOK_MODEL_SMART');
  expect(() => resolveModel('plan', { LTCOOK_MODEL_SMART: 'bare-id' })).toThrow('provider/model');
  expect(() => resolveModel('plan', { LTCOOK_MODEL_SMART: 'openai/gpt-6.1-sol:high' })).toThrow(
    'Set reasoning in the Session or Team member',
  );
  expect(() => resolveModel('local-tiny', { LTCOOK_MODEL_LOCAL_TINY: ' ' })).toThrow(
    'LTCOOK_MODEL_LOCAL_TINY',
  );
  expect(() => resolveModel('local-tiny', environment, { sessionReasoning: 'medium' })).toThrow(
    'supports none, low, high reasoning',
  );
  expect(() => resolveModel('review-art', environment, { sessionReasoning: 'none' })).toThrow(
    'supports low, medium, high, xhigh, max reasoning',
  );
  expect(() => resolveModel('smol', environment, { sessionReasoning: 'maximal' })).toThrow(
    'Session reasoning must be one of',
  );
  expect(reasoningOptions(resolveModel('smol', environment))).toContain('max');
});

test('hosted launcher adapters translate explicit effort and omit unset effort', () => {
  const defaultModel = resolveModel('smart', environment);
  expect(modelCommand('pi', defaultModel, environment)).toEqual({
    command: 'pi',
    args: ['--provider', 'openai-codex', '--model', 'gpt-6.2-sol'],
  });
  expect(modelCommand('codex', defaultModel, environment)).toEqual({
    command: 'codex',
    args: ['-m', 'gpt-6.2-sol', '-c', 'model_provider="openai"'],
  });
  expect(modelCommand('codex', resolveModel('tiny', environment), environment).args).toEqual([
    '-m',
    'gpt-6-luna',
    '-c',
    'model_provider="openai"',
    '-c',
    'model_reasoning_effort="low"',
  ]);
  const custom = resolveModel('smol', { LTCOOK_MODEL_SMOL: 'openrouter/lab/model:free' });
  expect(modelCommand('pi', custom, environment).args).toContain('lab/model:free');
  expect(() => modelCommand('codex', custom, environment)).toThrow(
    'Codex cannot use the configured provider',
  );
});

test.each([
  ['none', 'off'],
  ['low', 'low'],
  ['high', 'high'],
])('preserves Spark reasoning %s across launchers', (effort, piEffort) => {
  const selected = resolveModel('local-tiny', environment, { sessionReasoning: effort });
  expect(modelCommand('pi', selected, environment).args).toEqual([
    '--provider',
    'ollama',
    '--model',
    environment.LTCOOK_MODEL_LOCAL_TINY,
    '--thinking',
    piEffort,
  ]);
  expect(modelCommand('codex', selected, environment)).toEqual({
    command: 'codex',
    args: [
      '-m',
      environment.LTCOOK_MODEL_LOCAL_TINY,
      '-c',
      'model_provider="ollama"',
      '-c',
      `model_reasoning_effort="${effort}"`,
    ],
    env: { CODEX_OSS_BASE_URL: 'http://127.0.0.1:21434/v1' },
  });
  expect(() => modelCommand('codex', selected, {})).toThrow('LTCOOK_OLLAMA_ENDPOINT');
  expect(() =>
    modelCommand('codex', selected, { LTCOOK_OLLAMA_ENDPOINT: 'https://ollama.example' }),
  ).toThrow('HTTP loopback');
});

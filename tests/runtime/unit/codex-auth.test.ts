import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  codexBackedTerminalProvider,
  codexEnvironment,
  useCodexOpenAiAuth,
} from '../../../runtime/src/integrations/codex-auth.js';

test('rejects unofficial endpoints and per-request OpenAI credential overrides before contacting Codex', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-auth-test-'));
  try {
    const runtime = useCodexOpenAiAuth(
      await ModelRuntime.create({
        authPath: path.join(directory, 'auth.json'),
        modelsPath: null,
        modelsStorePath: path.join(directory, 'models.json'),
        refreshOnCreate: false,
      }),
    );
    const model = runtime.getModel('openai-codex', 'gpt-6-luna')!;
    const provider = runtime.getProvider(model.provider)!;
    const untrusted = { ...model, baseUrl: 'https://example.test/backend-api' };
    expect(() => runtime.getAuth(untrusted)).toThrow('official provider endpoint');
    expect(() => codexBackedTerminalProvider(provider, untrusted)).toThrow(
      'official provider endpoint',
    );
    expect(() => runtime.getAuth(model, { apiKey: 'fixture-key' })).toThrow(
      'centralized Codex sign-in',
    );
    expect(await runtime.getAuth('fixture-without-credentials')).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps inherited Codex configuration and leaves out the per-application OpenAI key', () => {
  const environment = {
    PATH: '/fixture/bin',
    CODEX_HOME: '/fixture/codex',
    OPENAI_API_KEY: 'fixture-key',
  };
  expect(codexEnvironment(environment)).toEqual({
    PATH: environment.PATH,
    CODEX_HOME: environment.CODEX_HOME,
  });
  expect(environment.OPENAI_API_KEY).toBe('fixture-key');
});

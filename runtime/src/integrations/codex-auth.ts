import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';

const openAiEndpoints = {
  openai: 'https://api.openai.com/v1',
  'openai-codex': 'https://chatgpt.com/backend-api',
};
type OpenAiProvider = keyof typeof openAiEndpoints;
const authStatus = z.object({
  authMethod: z.enum(['chatgpt', 'chatgptAuthTokens', 'apikey']),
  authToken: z.string().min(1),
});
const reply = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

export function isOpenAiProvider(provider: string): provider is OpenAiProvider {
  return Object.hasOwn(openAiEndpoints, provider);
}

export function codexEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const { OPENAI_API_KEY: _appRcKey, ...shared } = environment;
  return shared;
}

export function assertOfficialEndpoint(provider: OpenAiProvider, url: string): void {
  if (url.replace(/\/$/, '') !== openAiEndpoints[provider]) {
    throw new Error('Codex OpenAI authorization requires the official provider endpoint.');
  }
}

/** Read request authorization on a private stdio pipe and let Codex own refresh. */
export async function codexAuthorization(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15_000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const child = spawn('codex', ['app-server', '--stdio'], {
    env: codexEnvironment(),
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    signal: bounded,
  });
  const lines = createInterface({ input: child.stdout });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.on('error', () => lines.close());
  child.stdin.on('error', () => lines.close());
  const send = (message: Record<string, unknown>) =>
    child.stdin.write(JSON.stringify(message) + '\n');
  try {
    send({
      id: 0,
      method: 'initialize',
      params: { clientInfo: { name: 'ltcook', version: '0.1.0' } },
    });
    for await (const line of lines) {
      const { success, data } = reply.safeParse(JSON.parse(line));
      if (!success) continue;
      if (data.id === 0) {
        if (data.error) break;
        send({ method: 'initialized' });
        send({
          id: 1,
          method: 'getAuthStatus',
          params: { includeToken: true, refreshToken: true },
        });
      } else if (data.id === 1) {
        const value = authStatus.safeParse(data.result);
        if (value.success) return value.data;
        break;
      }
    }
  } catch {
    signal?.throwIfAborted();
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
    await closed;
  }
  signal?.throwIfAborted();
  throw new Error('Codex OpenAI authorization is unavailable. Check codex login status.');
}

export async function codexModelAuth(provider: OpenAiProvider, signal?: AbortSignal) {
  const { authMethod, authToken } = await codexAuthorization(signal);
  if ((authMethod === 'apikey') !== (provider === 'openai')) {
    const compatible = authMethod === 'apikey' ? 'openai' : 'openai-codex';
    throw new Error(`The current Codex sign-in uses the ${compatible} provider in LTCook.`);
  }
  return { auth: { apiKey: authToken }, source: 'Codex sign-in' };
}

/** Use the Codex account for official OpenAI endpoints and keep Pi's other providers intact. */
export function useCodexOpenAiAuth(
  runtime: ModelRuntime,
  authorize = codexModelAuth,
): ModelRuntime {
  const login = runtime.login.bind(runtime);
  runtime.login = (provider, ...args) => {
    if (isOpenAiProvider(provider))
      throw new Error('Use ltcook auth login for the shared Codex sign-in.');
    return login(provider, ...args);
  };
  const logout = runtime.logout.bind(runtime);
  runtime.logout = (provider, options) => {
    if (isOpenAiProvider(provider))
      throw new Error('Use ltcook auth logout for the shared Codex sign-in.');
    return logout(provider, options);
  };
  const checkAuth = runtime.checkAuth.bind(runtime);
  runtime.checkAuth = async (provider, options) => {
    if (!isOpenAiProvider(provider)) return checkAuth(provider, options);
    await authorize(provider, options?.signal);
    return { source: 'Codex sign-in', type: provider === 'openai-codex' ? 'oauth' : 'api_key' };
  };
  const getAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = (model, options) => {
    const provider = typeof model === 'string' ? model : model.provider;
    if (!isOpenAiProvider(provider)) {
      return typeof model === 'string' ? getAuth(model, options) : getAuth(model, options);
    }
    if (typeof model !== 'string') assertOfficialEndpoint(provider, model.baseUrl);
    if (options?.apiKey)
      throw new Error('Use the centralized Codex sign-in for OpenAI models in LTCook.');
    return authorize(provider, options?.signal);
  };
  return runtime;
}

/** Native Pi's terminal entry accepts an in-memory provider through its extension API. */
export function codexBackedTerminalProvider(
  native: NonNullable<ReturnType<ModelRuntime['getProvider']>>,
  model: NonNullable<ReturnType<ModelRuntime['getModel']>>,
): NonNullable<ReturnType<ModelRuntime['getProvider']>> {
  const provider = model.provider;
  if (!isOpenAiProvider(provider)) throw new Error('An OpenAI provider is required.');
  assertOfficialEndpoint(provider, model.baseUrl);
  // > A separate terminal provider ID avoids binding obsolete Pi credentials to this route.
  const id = `ltcook-${provider}`;
  return {
    id,
    name: `${native.name} (Codex sign-in)`,
    baseUrl: model.baseUrl,
    auth: {
      apiKey: {
        name: 'Codex sign-in',
        async check({ signal }) {
          await codexModelAuth(provider, signal);
          return { type: 'api_key', source: 'Codex sign-in' };
        },
        resolve: ({ signal }) => codexModelAuth(provider, signal),
      },
    },
    getModels: () => [{ ...model, provider: id }],
    stream: (...args) => native.stream(...args),
    streamSimple: (...args) => native.streamSimple(...args),
  };
}

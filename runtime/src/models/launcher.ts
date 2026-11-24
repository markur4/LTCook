import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ExtensionFactory, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { modelCommand, piThinking } from './adapters.js';
import { resolveModel, type ResolvedModel } from './aliases.js';
import { agentEnvironment } from '../integrations/native-policy.js';
import {
  codexBackedTerminalProvider,
  codexEnvironment,
  isOpenAiProvider,
} from '../integrations/codex-auth.js';

function validateNativeArgs(harness: 'pi' | 'codex', args: string[]): void {
  const options =
    harness === 'pi'
      ? new Set(['--model', '--provider', '--thinking', '--models'])
      : new Set([
          '-m',
          '--model',
          '-c',
          '--config',
          '-p',
          '--profile',
          '--oss',
          '--local-provider',
        ]);
  const piSessionOptions = new Set([
    '--resume',
    '-r',
    '--continue',
    '-c',
    '--session',
    '--fork',
    '--session-id',
  ]);
  for (const arg of args) {
    if (arg === '--') break;
    const option = arg.split('=', 1)[0]!;
    if (harness === 'pi' && piSessionOptions.has(option))
      throw new Error(
        'Use native Pi to reopen a terminal conversation. Register its saved model in the native Pi models.json first if it is custom. See Choose a model alias in the LTCook user guide.',
      );
    if (options.has(option) || (harness === 'codex' && /^(?:resume|fork)$/.test(arg)))
      throw new Error(
        'Launch a new conversation with this alias. Use the native harness to resume, and set the model and reasoning through LTCook.',
      );
  }
}

async function registeredPiModel(
  selection: ResolvedModel,
  authDir: string,
  runtime: typeof ModelRuntime,
): Promise<{ providerId: string; extensionFactories: ExtensionFactory[] }> {
  const authPath = path.join(authDir, 'auth.json');
  const nativePath = path.join(authDir, 'models.json');
  const modelsPath = process.env.LTCOOK_PI_MODELS_PATH || nativePath;
  const nativeCatalog = (modelsPath: string) =>
    runtime.create({ authPath, modelsPath, refreshOnCreate: false });
  const prepared = await nativeCatalog(modelsPath);
  const preparedModel = prepared.getModel(selection.provider, selection.model);
  const catalog =
    preparedModel || modelsPath === nativePath ? prepared : await nativeCatalog(nativePath);
  const model = catalog.getModel(selection.provider, selection.model);
  if (!model)
    throw new Error(
      `Pi cannot resolve ${selection.provider}/${selection.model}. Register that exact model in Pi models.json.`,
    );

  const thinking = piThinking(selection.reasoning);
  if (thinking !== undefined) {
    const mapped = model.thinkingLevelMap?.[thinking];
    if (
      (!model.reasoning && thinking !== 'off') ||
      (model.reasoning &&
        (mapped === null || ((thinking === 'xhigh' || thinking === 'max') && mapped === undefined)))
    )
      throw new Error(
        `Pi cannot run ${selection.provider}/${selection.model} with ${selection.reasoning} reasoning.`,
      );
  }

  // > Pi normalizes models.json into complete native models and their provider auth.
  const provider = catalog.getProvider(selection.provider);
  if (isOpenAiProvider(selection.provider) && provider) {
    const backed = codexBackedTerminalProvider(provider, model);
    return { providerId: backed.id, extensionFactories: [(pi) => pi.registerProvider(backed)] };
  }
  return {
    providerId: selection.provider,
    extensionFactories:
      preparedModel && modelsPath !== nativePath && provider
        ? [(pi) => pi.registerProvider(provider)]
        : [],
  };
}

export async function launchModel(argv: string[]): Promise<void> {
  const [harness, alias, reasoning, separator, ...nativeArgs] = argv;
  if ((harness !== 'pi' && harness !== 'codex') || !alias || separator !== '--')
    throw new Error(
      'Usage: ltcook launch model <pi|codex> @alias [--reasoning <effort>] [-- <native args>]',
    );
  validateNativeArgs(harness, nativeArgs);
  const selection = resolveModel(alias, process.env, { sessionReasoning: reasoning || undefined });
  const safeEnv = agentEnvironment(
    Object.fromEntries(
      Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined),
    ),
  );
  if (harness === 'pi') {
    if (
      isOpenAiProvider(selection.provider) &&
      nativeArgs.some((arg) => arg.split('=', 1)[0] === '--api-key')
    ) {
      throw new Error('LTCook uses the centralized Codex sign-in for OpenAI models.');
    }
    const authDir = process.env.LTCOOK_PI_AUTH_DIR;
    if (!authDir || !path.isAbsolute(authDir))
      throw new Error('AppRC did not resolve the shared Pi authentication directory.');
    Object.assign(process.env, safeEnv, { PI_CODING_AGENT_DIR: authDir });
    const { main, ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const { providerId, extensionFactories } = await registeredPiModel(
      selection,
      authDir,
      ModelRuntime,
    );
    const command = modelCommand(harness, { ...selection, provider: providerId }, process.env);
    await main([...command.args, ...nativeArgs], { extensionFactories });
    return;
  }
  const command = modelCommand(harness, selection, process.env);
  const child = spawn(command.command, [...command.args, ...nativeArgs], {
    env: { ...codexEnvironment(safeEnv), ...command.env },
    stdio: 'inherit',
    windowsHide: true,
  });
  const signals: NodeJS.Signals[] =
    process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = signals.map((signal) => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return { signal, handler };
  });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    process.exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : 1);
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
}

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionFactory, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { modelCommand } from './adapters.js';
import { resolveModel, type ResolvedModel } from './aliases.js';
import { agentEnvironment } from '../integrations/native-policy.js';

function validateNativeArgs(harness: 'pi' | 'codex', args: string[]): void {
  const options =
    harness === 'pi'
      ? new Set([
          '--model',
          '--provider',
          '--thinking',
          '--models',
          '--resume',
          '-r',
          '--continue',
          '-c',
          '--session',
          '--fork',
          '--session-id',
        ])
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
  for (const arg of args) {
    if (arg === '--') break;
    if (
      options.has(arg.split('=', 1)[0]!) ||
      (harness === 'codex' && /^(?:resume|fork)$/.test(arg))
    )
      throw new Error(
        'Launch a new conversation with this alias. Use the native harness to resume, and set the model and reasoning through LTCook.',
      );
  }
}

async function registeredPiModel(selection: ResolvedModel): Promise<ExtensionFactory[]> {
  const filename = process.env.LTCOOK_PI_MODELS_PATH;
  if (!filename) return [];
  // > This file is written by the workspace preparation adapter for this invocation.
  const document = JSON.parse(await readFile(filename, 'utf8')) as {
    providers?: Record<string, ProviderConfig>;
  };
  const provider = document.providers?.[selection.provider];
  const model = provider?.models?.find(({ id }) => id === selection.model);
  if (!provider || !model) return [];
  return [(pi) => pi.registerProvider(selection.provider, { ...provider, models: [model] })];
}

export async function launchModel(argv: string[]): Promise<void> {
  const [harness, alias, reasoning, separator, ...nativeArgs] = argv;
  if ((harness !== 'pi' && harness !== 'codex') || !alias || separator !== '--')
    throw new Error(
      'Usage: ltcook launch model <pi|codex> @alias [--reasoning <effort>] [-- <native args>]',
    );
  validateNativeArgs(harness, nativeArgs);
  const selection = resolveModel(alias, process.env, { sessionReasoning: reasoning || undefined });
  const command = modelCommand(harness, selection, process.env);
  const safeEnv = agentEnvironment(
    Object.fromEntries(
      Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined),
    ),
  );
  if (harness === 'pi') {
    const authDir = process.env.LTCOOK_PI_AUTH_DIR;
    if (!authDir || !path.isAbsolute(authDir))
      throw new Error('AppRC did not resolve the shared Pi authentication directory.');
    const extensionFactories = await registeredPiModel(selection);
    Object.assign(process.env, safeEnv, { PI_CODING_AGENT_DIR: authDir });
    const { main } = await import('@earendil-works/pi-coding-agent');
    await main([...command.args, ...nativeArgs], { extensionFactories });
    return;
  }
  const child = spawn(command.command, [...command.args, ...nativeArgs], {
    env: { ...safeEnv, ...command.env },
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

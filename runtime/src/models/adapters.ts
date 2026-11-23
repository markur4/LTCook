import type { ReasoningEffort, ResolvedModel } from './aliases.js';

export function piThinking(
  effort: ReasoningEffort | undefined,
): Exclude<ReasoningEffort, 'none'> | 'off' | undefined {
  return effort === 'none' ? 'off' : effort;
}

function ollamaResponsesBaseUrl(setting: string | undefined): string {
  const endpoint = setting && URL.parse(setting);
  if (
    !endpoint ||
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  )
    throw new Error('Set LTCOOK_OLLAMA_ENDPOINT in AppRC to an HTTP or HTTPS server URL.');
  return new URL('/v1', endpoint).href;
}

/** Translate a resolved model into native launcher arguments without invoking the harness. */
export function modelCommand(
  harness: 'pi' | 'codex',
  selection: ResolvedModel,
  environment: Record<string, string | undefined>,
): { command: string; args: string[]; env?: Record<string, string> } {
  const { provider, model, reasoning } = selection;
  if (harness === 'pi') {
    const thinking = piThinking(reasoning);
    return {
      command: 'pi',
      args: [
        '--provider',
        provider,
        '--model',
        model,
        ...(thinking === undefined ? [] : ['--thinking', thinking]),
      ],
    };
  }

  const local = provider === 'ollama';
  if (!local && provider !== 'openai' && provider !== 'openai-codex')
    throw new Error(
      `Codex cannot use the configured provider for @${selection.alias}: ${provider}.`,
    );

  // > Select the built-in provider directly. Codex --oss can pull a missing model automatically.
  return {
    command: 'codex',
    args: [
      '-m',
      model,
      '-c',
      `model_provider="${local ? 'ollama' : 'openai'}"`,
      ...(reasoning === undefined ? [] : ['-c', `model_reasoning_effort="${reasoning}"`]),
    ],
    ...(local
      ? { env: { CODEX_OSS_BASE_URL: ollamaResponsesBaseUrl(environment.LTCOOK_OLLAMA_ENDPOINT) } }
      : {}),
  };
}

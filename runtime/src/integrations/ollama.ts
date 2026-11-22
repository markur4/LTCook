import { z } from 'zod';

export interface OllamaSettings {
  endpoint: string;
  model: string;
  keepAlive: number;
}

const result = z.object({
  model: z.string().min(1),
  message: z.object({ content: z.string().min(1) }),
  done: z.boolean(),
  done_reason: z.string().optional(),
  eval_count: z.number().optional(),
});
const MAX_OUTPUT_TOKENS = 512;
const CHAT_TIMEOUT_MS = 120_000;

/** Use one loopback Ollama instance and abort HTTP work with the tool request. */
export async function ollamaChat(
  settings: OllamaSettings,
  messages: { role: 'system' | 'user'; content: string }[],
  signal: AbortSignal,
) {
  let endpoint: URL;
  try {
    const configured = settings.endpoint.trim();
    endpoint = new URL(configured);
    if (
      !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\/?$/i.test(configured) ||
      endpoint.port === '0'
    ) {
      throw new Error();
    }
  } catch {
    throw new Error('Configure the AppRC Ollama endpoint as an HTTP loopback URL with a port.');
  }
  const modelName = settings.model.trim();
  if (!modelName || !Number.isSafeInteger(settings.keepAlive) || settings.keepAlive < -1)
    throw new Error(
      'Configure a summarizer model and a keep-alive value of -1 or nonnegative seconds.',
    );
  const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(new URL('/api/chat', endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.any([signal, timeout]) as NonNullable<
        Parameters<typeof fetch>[1]
      >['signal'],
      body: JSON.stringify({
        model: modelName,
        messages,
        stream: false,
        keep_alive: settings.keepAlive,
        options: {
          num_ctx: 32768,
          num_predict: MAX_OUTPUT_TOKENS,
          temperature: 0.1,
          top_k: 50,
          repeat_penalty: 1.05,
        },
      }),
    });
  } catch {
    signal.throwIfAborted();
    if (timeout.aborted) throw new Error('Ollama summarization timed out.');
    throw new Error('The configured local Ollama service is unavailable.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404)
      throw new Error(
        `Ollama summarizer model "${modelName}" is unavailable. Run LTCook setup or repair.`,
      );
    throw new Error(`Ollama summarization failed (HTTP ${response.status}).`);
  }
  const payload = result.safeParse(await response.json().catch(() => undefined));
  signal.throwIfAborted();
  if (timeout.aborted) throw new Error('Ollama summarization timed out.');
  if (!payload.success) throw new Error('Ollama returned an invalid summarization response.');
  const { model, message, done, done_reason, eval_count } = payload.data;
  const incomplete =
    !done ||
    done_reason === 'length' ||
    (done_reason === undefined && (eval_count ?? 0) >= MAX_OUTPUT_TOKENS);
  return { model, summary: message.content, incomplete };
}

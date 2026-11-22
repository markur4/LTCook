import { z } from 'zod';

export interface OllamaSettings {
  endpoint: string;
  model: string;
  keepAlive: number;
  generation?: string;
}

const result = z.object({
  model: z.string().min(1),
  message: z.object({ content: z.string() }),
  done: z.boolean(),
  done_reason: z.string().optional(),
  eval_count: z.number().int().nonnegative().optional().catch(undefined),
  prompt_eval_count: z.number().int().nonnegative().optional().catch(undefined),
});
export const SUMMARY_GENERATION_OPTIONS = {
  num_ctx: 32768,
  num_predict: 512,
  temperature: 0.1,
  top_k: 50,
  repeat_penalty: 1.05,
} as const;
const generationSchema = z.strictObject({
  think: z.boolean().optional(),
  stream: z.literal(false).optional(),
  options: z.strictObject({
    num_ctx: z.number().int().positive(),
    num_predict: z.number().int().positive(),
    temperature: z.number().nonnegative(),
    top_k: z.number().int().nonnegative().optional(),
    repeat_penalty: z.number().positive().optional(),
  }),
});
export type SummaryGeneration = z.infer<typeof generationSchema>;

export function summaryGeneration(settings: OllamaSettings): SummaryGeneration {
  if (!settings.generation?.trim()) return { options: SUMMARY_GENERATION_OPTIONS };
  try {
    return generationSchema.parse(JSON.parse(settings.generation));
  } catch {
    throw new Error(
      'Configure summarizer generation as JSON with options for context, output, and temperature.',
    );
  }
}
const CHAT_TIMEOUT_MS = 120_000;

export type OllamaUsage = { inputTokens?: number; outputTokens?: number };

export function ollamaEndpoint(value: string): URL {
  try {
    const configured = value.trim();
    const endpoint = new URL(configured);
    if (
      !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\/?$/i.test(configured) ||
      endpoint.port === '0'
    ) {
      throw new Error();
    }
    return endpoint;
  } catch {
    throw new Error('Configure the AppRC Ollama endpoint as an HTTP loopback URL with a port.');
  }
}

/** Use one loopback Ollama instance and abort HTTP work with the tool request. */
export async function ollamaChat(
  settings: OllamaSettings,
  messages: { role: 'system' | 'user'; content: string }[],
  signal: AbortSignal,
  onUsage?: (usage: OllamaUsage) => void,
) {
  const endpoint = ollamaEndpoint(settings.endpoint);
  const generation = summaryGeneration(settings);
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
        ...generation,
        stream: false,
        keep_alive: settings.keepAlive,
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
  const { model, message, done, done_reason, eval_count, prompt_eval_count } = payload.data;
  onUsage?.({
    ...(prompt_eval_count === undefined ? {} : { inputTokens: prompt_eval_count }),
    ...(eval_count === undefined ? {} : { outputTokens: eval_count }),
  });
  const incomplete =
    !done ||
    !message.content.trim() ||
    done_reason === 'length' ||
    (done_reason === undefined && (eval_count ?? 0) >= generation.options.num_predict);
  return { model, summary: message.content, incomplete };
}

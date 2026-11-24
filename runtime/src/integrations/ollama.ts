import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

export interface OllamaSettings {
  endpoint: string;
  model: string;
  keepAlive: number;
  generation?: string;
  cpuOnly?: boolean;
}

export const LFM3_SUMMARIZER_MODEL = 'lfm3:1.7b-q8_0';

const result = z.object({
  model: z.string().min(1),
  message: z.object({ content: z.string(), thinking: z.string().optional() }),
  done: z.boolean(),
  done_reason: z.string().optional(),
  eval_count: z.number().int().nonnegative().optional().catch(undefined),
  prompt_eval_count: z.number().int().nonnegative().optional().catch(undefined),
  prompt_eval_cached_count: z.number().int().nonnegative().optional(),
  prompt_eval_duration: z.number().nonnegative().optional(),
  eval_duration: z.number().nonnegative().optional(),
  total_duration: z.number().nonnegative().optional(),
  load_duration: z.number().nonnegative().optional(),
  logprobs: z.array(z.object({ token: z.string() })).optional(),
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
  truncate: z.literal(false).optional(),
  shift: z.literal(false).optional(),
  stream: z.literal(false).optional(),
  options: z.strictObject({
    num_ctx: z.number().int().positive(),
    num_predict: z.number().int().positive(),
    temperature: z.number().nonnegative(),
    top_k: z.number().int().nonnegative().optional(),
    seed: z.number().int().nonnegative().optional(),
    repeat_penalty: z.number().positive().optional(),
  }),
});
export type SummaryGeneration = z.infer<typeof generationSchema>;

export function retriesSummaryWithoutReasoning(settings: OllamaSettings): boolean {
  return !settings.generation?.trim() && settings.model.trim() === LFM3_SUMMARIZER_MODEL;
}

export function summaryGeneration(settings: OllamaSettings): SummaryGeneration {
  if (!settings.generation?.trim()) {
    if (retriesSummaryWithoutReasoning(settings))
      return { think: true, options: { num_ctx: 32768, num_predict: 4096, temperature: 0.1 } };
    return { think: false, options: SUMMARY_GENERATION_OPTIONS };
  }
  try {
    return generationSchema.parse(JSON.parse(settings.generation));
  } catch {
    throw new Error(
      'Configure summarizer generation as JSON with options for context, output, and temperature.',
    );
  }
}
const CHAT_TIMEOUT_MS = 120_000;

type TokenUsage = { inputTokens?: number; outputTokens?: number };
export type OllamaUsage = TokenUsage & { initialReasoningAttempt?: TokenUsage };

export type OllamaChatMetrics = {
  prefillMs?: number;
  generationMs?: number;
  serverTotalMs?: number;
  loadMs?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  thinkingPresent: boolean;
};

function chatMetrics(payload: z.infer<typeof result>): OllamaChatMetrics {
  const { message, logprobs, eval_count } = payload;
  const { content, thinking } = message;
  const ms = (duration?: number) => (duration === undefined ? undefined : duration / 1e6);
  const tokens = logprobs?.map(({ token }) => token);
  let reasoningTokens: number | undefined;
  if (
    tokens &&
    eval_count !== undefined &&
    eval_count >= tokens.length &&
    eval_count - tokens.length <= 1
  ) {
    const generated = tokens.join('');
    if (!thinking && generated === content) reasoningTokens = 0;
    else if (thinking) {
      const start = generated.indexOf(thinking);
      if (start >= 0) {
        let position = 0;
        reasoningTokens = tokens.filter((token) => {
          const previous = position;
          position += token.length;
          return position > start && previous < start + thinking.length;
        }).length;
      }
    }
  }
  return {
    prefillMs: ms(payload.prompt_eval_duration),
    generationMs: ms(payload.eval_duration),
    serverTotalMs: ms(payload.total_duration),
    loadMs: ms(payload.load_duration),
    cachedInputTokens: payload.prompt_eval_cached_count,
    reasoningTokens,
    thinkingPresent: Boolean(thinking),
  };
}

function tokenUsage(inputTokens?: number, outputTokens?: number): TokenUsage {
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function sumTokens(first?: number, second?: number): number | undefined {
  if (first !== undefined && second !== undefined) return first + second;
}

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
    throw new Error(
      'Configure LTCOOK_OLLAMA_ENDPOINT in AppRC as an HTTP loopback URL with a port.',
    );
  }
}

const loadedModels = z.object({ models: z.array(z.object({ name: z.string() })) });

/** Wait for Ollama to release the previous runner before requesting automatic placement. */
export async function releaseOllamaModel(settings: OllamaSettings, signal: AbortSignal) {
  const endpoint = ollamaEndpoint(settings.endpoint);
  const model = settings.model.trim();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const requestSignal = bounded as NonNullable<Parameters<typeof fetch>[1]>['signal'];
  const response = await fetch(new URL('/api/generate', endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    redirect: 'error',
    signal: requestSignal,
    body: JSON.stringify({ model, keep_alive: 0, stream: false }),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Ollama model unload failed (HTTP ${response.status}).`);

  const tag = model.split('/').at(-1)?.includes(':') ? model : `${model}:latest`;
  for (;;) {
    const processes = await fetch(new URL('/api/ps', endpoint), {
      redirect: 'error',
      signal: requestSignal,
    });
    if (!processes.ok) {
      await processes.body?.cancel();
      throw new Error(`Ollama model status failed (HTTP ${processes.status}).`);
    }
    const { models } = loadedModels.parse(await processes.json());
    if (!models.some(({ name }) => name === model || name === tag)) return;
    await delay(100, undefined, { signal: bounded });
  }
}

/** Use one loopback Ollama instance and abort HTTP work with the tool request. */
export async function ollamaChat(
  settings: OllamaSettings,
  messages: { role: 'system' | 'user'; content: string }[],
  signal: AbortSignal,
  onUsage?: (usage: OllamaUsage) => void,
  format?: Record<string, unknown>,
  onMetrics?: (metrics: OllamaChatMetrics) => void,
  tokenDiagnostics = Boolean(onMetrics),
) {
  const endpoint = ollamaEndpoint(settings.endpoint);
  const generation = summaryGeneration(settings);
  const modelName = settings.model.trim();
  if (!modelName || !Number.isSafeInteger(settings.keepAlive) || settings.keepAlive < -1)
    throw new Error(
      'Configure a summarizer model and a keep-alive value of -1 or nonnegative seconds.',
    );
  const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  const bounded = AbortSignal.any([signal, timeout]) as NonNullable<
    Parameters<typeof fetch>[1]
  >['signal'];
  const request = async (think: boolean | undefined) => {
    let response: Response;
    try {
      response = await fetch(new URL('/api/chat', endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        redirect: 'error',
        signal: bounded,
        body: JSON.stringify({
          model: modelName,
          messages,
          ...generation,
          ...(settings.cpuOnly ? { options: { ...generation.options, num_gpu: 0 } } : {}),
          ...(format ? { format } : {}),
          ...(tokenDiagnostics ? { logprobs: true } : {}),
          think,
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
          `Ollama summarizer model "${modelName}" is unavailable. Run ollama pull ${modelName} on the configured Ollama instance.`,
        );
      throw new Error(`Ollama summarization failed (HTTP ${response.status}).`);
    }
    const payload = result.safeParse(await response.json().catch(() => undefined));
    signal.throwIfAborted();
    if (timeout.aborted) throw new Error('Ollama summarization timed out.');
    if (!payload.success) throw new Error('Ollama returned an invalid summarization response.');
    if (onMetrics) onMetrics(chatMetrics(payload.data));
    const { model, message, done, done_reason, eval_count, prompt_eval_count } = payload.data;
    const incomplete =
      !done ||
      !message.content.trim() ||
      done_reason === 'length' ||
      (done_reason === undefined && (eval_count ?? 0) >= generation.options.num_predict);
    return {
      model,
      summary: message.content,
      incomplete,
      usage: tokenUsage(prompt_eval_count, eval_count),
    };
  };

  const first = await request(generation.think);
  if (first.incomplete && first.model === modelName && retriesSummaryWithoutReasoning(settings)) {
    const { usage, ...answer } = await request(false);
    onUsage?.({
      ...tokenUsage(
        sumTokens(first.usage.inputTokens, usage.inputTokens),
        sumTokens(first.usage.outputTokens, usage.outputTokens),
      ),
      initialReasoningAttempt: first.usage,
    });
    return answer;
  }
  const { usage, ...answer } = first;
  onUsage?.(usage);
  return answer;
}

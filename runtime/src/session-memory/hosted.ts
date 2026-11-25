import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { useCodexOpenAiAuth } from '../integrations/codex-auth.js';
import type { ResolvedModel } from '../models/aliases.js';
import { MemorySummaryError, type HostedMemoryUsage } from './service.js';
import type { MemorySummaryResult, summarizeMemory } from './summarization.js';

const standardTier = 'default';
const hostedResponse = z.object({
  type: z.enum(['response.completed', 'response.done', 'response.incomplete']),
  response: z.object({ model: z.string().optional(), service_tier: z.string().optional() }),
});
const hostedRequest = z.object({
  model: z.string(),
  instructions: z.string(),
  input: z.tuple([
    z.object({
      role: z.literal('user'),
      content: z.tuple([
        z.object({
          type: z.literal('input_text'),
          text: z.string(),
        }),
      ]),
    }),
  ]),
  reasoning: z.object({ effort: z.literal('none') }),
  service_tier: z.literal(standardTier),
  store: z.literal(false),
  tools: z.tuple([]).optional(),
  previous_response_id: z.never().optional(),
});

/** Check the provider payload before it leaves the process. */
export function validHostedMemoryRequest(
  payload: unknown,
  model: string,
  system: string,
  user: string,
) {
  const parsed = hostedRequest.safeParse(payload);
  return (
    parsed.success &&
    parsed.data.model === model &&
    parsed.data.instructions === system &&
    parsed.data.input[0].content[0].text === user
  );
}

export function createHostedMemorySummarizer(selection: ResolvedModel) {
  let runtime: Promise<ModelRuntime> | undefined;
  const totals: HostedMemoryUsage = {
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  return {
    usage: () => ({ ...totals }),
    async summarize(
      type: MemorySummaryResult['type'],
      prompt: Parameters<typeof summarizeMemory>[1],
      signal: AbortSignal,
    ): Promise<MemorySummaryResult> {
      if (selection.provider !== 'openai-codex' || selection.reasoning !== 'none')
        throw new MemorySummaryError(
          'Hosted Session Memory requires an openai-codex model with reasoning off.',
        );
      const started = performance.now();
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      const pi = await (runtime ??= ModelRuntime.create({
        modelsPath: null,
        refreshOnCreate: false,
      })
        .then(useCodexOpenAiAuth)
        .catch((error: unknown) => {
          runtime = undefined;
          throw error;
        }));
      const model = pi.getModel('openai-codex', selection.model);
      if (
        !model ||
        model.api !== 'openai-codex-responses' ||
        model.baseUrl.replace(/\/$/, '') !== 'https://chatgpt.com/backend-api'
      )
        throw new MemorySummaryError(
          'The selected hosted Session Memory model is unavailable in Pi.',
        );
      const [system, user] = prompt;
      let submitted = false;
      let invalidRequest = false;
      let responseStatus: number | undefined;
      let responseModel: string | undefined;
      let responseTier: string | undefined;
      const options = {
        signal: bounded,
        serviceTier: standardTier,
        reasoningEffort: 'none',
        transport: 'sse',
        maxRetries: 0,
        cacheRetention: 'none',
        toolChoice: 'none',
        onPayload(payload: unknown) {
          if (!validHostedMemoryRequest(payload, model.id, system.content, user.content)) {
            invalidRequest = true;
            throw new Error('Hosted Session Memory request policy mismatch.');
          }
          submitted = true;
          totals.requests++;
        },
        onProviderStreamEvent(event: unknown) {
          const parsed = hostedResponse.safeParse(event);
          if (parsed.success) {
            responseModel = parsed.data.response.model;
            responseTier = parsed.data.response.service_tier;
          }
        },
        onResponse(response: { status: number }) {
          responseStatus = response.status;
        },
      } as const;
      try {
        bounded.throwIfAborted();
        const answer = await pi.complete(
          model,
          {
            systemPrompt: system.content,
            messages: [{ role: 'user', content: user.content, timestamp: Date.now() }],
          },
          options,
        );
        const elapsedMs = Math.round(performance.now() - started);
        const usage = answer.usage;
        if (submitted) {
          totals.inputTokens += usage.input + usage.cacheRead + usage.cacheWrite;
          totals.cachedInputTokens += usage.cacheRead;
          totals.outputTokens += usage.output;
          totals.reasoningTokens += usage.reasoning ?? 0;
        }
        signal.throwIfAborted();
        if (bounded.aborted) throw new MemorySummaryError('Hosted Session Memory timed out.');
        if (invalidRequest)
          throw new MemorySummaryError(
            'Pi could not enforce the isolated prompt, Standard speed, and reasoning off for hosted Session Memory.',
          );
        if (
          responseStatus === 429 ||
          /(?:rate.limit|usage.limit|quota|usage.not.included)/i.test(answer.errorMessage ?? '')
        )
          throw new MemorySummaryError(
            'Hosted Session Memory reached a subscription quota or rate limit.',
          );
        if (!submitted || responseStatus === 401 || responseStatus === 403)
          throw new MemorySummaryError(
            'Hosted Session Memory requires a valid Codex subscription sign-in.',
          );
        if (answer.stopReason === 'error' || answer.stopReason === 'aborted')
          throw new MemorySummaryError('Hosted Session Memory inference failed.');
        const text = answer.content
          .flatMap((item) => (item.type === 'text' ? [item.text] : []))
          .join('');
        const actual = responseModel ?? answer.responseModel ?? answer.model;
        const thinkingPresent = answer.content.some((item) => item.type === 'thinking');
        if (
          actual !== model.id ||
          thinkingPresent ||
          (usage.reasoning ?? 0) !== 0 ||
          (responseTier !== undefined && responseTier !== standardTier)
        )
          throw new MemorySummaryError(
            'Hosted Session Memory received an unexpected model, speed, or reasoning output.',
          );
        const result = {
          type,
          text,
          elapsedMs,
          hosted: {
            model: actual,
            serviceTier: standardTier,
            providerModelVerified: Boolean(responseModel ?? answer.responseModel),
            ...(responseTier ? { providerTier: responseTier } : {}),
          } as const,
          usage: {
            inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
            outputTokens: usage.output,
          },
          metrics: {
            cachedInputTokens: usage.cacheRead,
            reasoningTokens: usage.reasoning,
            thinkingPresent,
          },
        };
        return answer.stopReason === 'stop' && text.trim()
          ? { ...result, complete: true, content: text }
          : { ...result, complete: false };
      } finally {
        if (submitted) totals.lastLatencyMs = Math.round(performance.now() - started);
      }
    },
  };
}

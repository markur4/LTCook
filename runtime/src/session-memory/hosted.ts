import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { useCodexOpenAiAuth } from '../integrations/codex-auth.js';
import type { ResolvedModel } from '../models/aliases.js';
import type { ConversationProvider } from './inference.js';

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
  reasoning: z.object({ effort: z.literal('low') }),
  service_tier: z.literal(standardTier),
  store: z.literal(false),
  tools: z.tuple([]).optional(),
  previous_response_id: z.never().optional(),
});

/** Check the provider payload before it leaves the process. */
export function validHostedConversationRequest(
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

export function hostedConversationProvider(selection: ResolvedModel): ConversationProvider {
  let runtime: Promise<ModelRuntime> | undefined;
  return async (_product, { instructions, input }, signal) => {
    if (selection.provider !== 'openai-codex' || selection.reasoning !== 'low')
      throw new Error('Hosted conversation inference requires a Codex model with low reasoning.');
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
      throw new Error('The selected Hosted conversation model is unavailable in Pi.');
    let submitted = false;
    let invalidRequest = false;
    let responseStatus: number | undefined;
    let responseModel: string | undefined;
    let responseTier: string | undefined;
    const options = {
      signal: bounded,
      serviceTier: standardTier,
      reasoningEffort: selection.reasoning,
      transport: 'sse',
      maxRetries: 0,
      cacheRetention: 'none',
      toolChoice: 'none',
      onPayload(payload: unknown) {
        if (!validHostedConversationRequest(payload, model.id, instructions, input)) {
          invalidRequest = true;
          throw new Error('Hosted conversation request policy mismatch.');
        }
        submitted = true;
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
    bounded.throwIfAborted();
    const answer = await pi.complete(
      model,
      {
        systemPrompt: instructions,
        messages: [{ role: 'user', content: input, timestamp: Date.now() }],
      },
      options,
    );
    const usage = answer.usage;
    signal.throwIfAborted();
    if (bounded.aborted) throw new Error('Hosted conversation inference timed out.');
    if (invalidRequest)
      throw new Error(
        'Pi could not enforce the isolated prompt, Standard speed, and low reasoning for Hosted inference.',
      );
    if (
      responseStatus === 429 ||
      /(?:rate.limit|usage.limit|quota|usage.not.included)/i.test(answer.errorMessage ?? '')
    )
      throw new Error('Hosted conversation inference reached a subscription quota or rate limit.');
    if (!submitted || responseStatus === 401 || responseStatus === 403)
      throw new Error('Hosted conversation inference requires a valid Codex subscription sign-in.');
    if (answer.stopReason === 'error' || answer.stopReason === 'aborted')
      throw new Error('Hosted conversation inference failed.');
    const text = answer.content
      .flatMap((item) => (item.type === 'text' ? [item.text] : []))
      .join('');
    const actual = responseModel ?? answer.responseModel ?? answer.model;
    if (actual !== model.id || (responseTier !== undefined && responseTier !== standardTier))
      throw new Error('Hosted conversation inference received an unexpected model or speed.');
    return {
      text,
      complete: answer.stopReason === 'stop' && !!text.trim(),
      usage: {
        inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
        outputTokens: usage.output,
      },
    };
  };
}

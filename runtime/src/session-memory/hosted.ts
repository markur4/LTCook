import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { codexModelAuth, useCodexOpenAiAuth } from '../integrations/codex-auth.js';
import type { ResolvedModel } from '../models/aliases.js';
import {
  inferenceRevision,
  providerInferenceFailure,
  ServiceInferenceError,
} from '../services/inference-recovery.js';
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

const hostedCorrection = {
  authentication:
    'Hosted conversation inference requires a valid Codex subscription sign-in. Run ltcook auth login openai-codex with a ChatGPT subscription.',
  model:
    'Set LTCOOK_MODEL_SMOL in AppRC to a supported openai-codex model for @tiny and restart LTCook.',
};

function requestPolicyError(revision?: string) {
  return new ServiceInferenceError(
    'configuration',
    'Pi could not enforce the Hosted request policy. Update LTCook and restart it.',
    revision,
  );
}

type HostedDependencies = {
  createRuntime?: typeof ModelRuntime.create;
  authorize?: typeof codexModelAuth;
};

export function hostedConversationProvider(
  selection: ResolvedModel | (() => ResolvedModel),
  dependencies: HostedDependencies = {},
): ConversationProvider {
  let runtime: Promise<ModelRuntime> | undefined;
  const authRevisions = new WeakMap<AbortSignal, string>();
  const createRuntime = dependencies.createRuntime ?? ModelRuntime.create.bind(ModelRuntime);
  const authorize = dependencies.authorize ?? codexModelAuth;
  const prepare = async () => {
    let configured: ResolvedModel;
    try {
      configured = typeof selection === 'function' ? selection() : selection;
    } catch {
      throw new ServiceInferenceError('configuration', hostedCorrection.model);
    }
    if (configured.provider !== 'openai-codex' || configured.reasoning !== 'low')
      throw new ServiceInferenceError(
        'configuration',
        `Hosted conversation inference requires a Codex model with low reasoning. ${hostedCorrection.model}`,
      );
    const pi = await (runtime ??= createRuntime({ modelsPath: null, refreshOnCreate: false })
      .then((value) =>
        useCodexOpenAiAuth(value, async (provider, signal) => {
          const credentials = await authorize(provider, signal);
          if (signal) authRevisions.set(signal, inferenceRevision(credentials.auth));
          return credentials;
        }),
      )
      .catch(() => {
        runtime = undefined;
        throw new ServiceInferenceError('configuration', hostedCorrection.model);
      }));
    const model = pi.getModel('openai-codex', configured.model);
    if (
      !model ||
      model.api !== 'openai-codex-responses' ||
      model.baseUrl.replace(/\/$/, '') !== 'https://chatgpt.com/backend-api' ||
      !model.reasoning ||
      model.thinkingLevelMap?.low === null
    )
      throw new ServiceInferenceError('configuration', hostedCorrection.model);
    return { pi, model, reasoning: configured.reasoning };
  };
  const provider: ConversationProvider = async ({ instructions, input }, signal) => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const { pi, model, reasoning } = await prepare();
    const revision = () => {
      const auth = authRevisions.get(bounded);
      return auth && inferenceRevision(model.id, auth);
    };
    let submitted = false;
    let invalidRequest = false;
    let responseStatus: number | undefined;
    let responseModel: string | undefined;
    let responseTier: string | undefined;
    const options = {
      signal: bounded,
      serviceTier: standardTier,
      reasoningEffort: reasoning,
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
    const answer = await pi
      .complete(
        model,
        {
          systemPrompt: instructions,
          messages: [{ role: 'user', content: input, timestamp: Date.now() }],
        },
        options,
      )
      .catch((error: unknown) => {
        signal.throwIfAborted();
        if (bounded.aborted)
          throw new ServiceInferenceError('transient', 'Hosted conversation inference timed out.');
        if (invalidRequest) throw requestPolicyError(revision());
        throw providerInferenceFailure(
          hostedCorrection,
          responseStatus,
          error instanceof Error ? error.message : undefined,
          revision(),
        );
      });
    const usage = answer.usage;
    signal.throwIfAborted();
    if (bounded.aborted)
      throw new ServiceInferenceError('transient', 'Hosted conversation inference timed out.');
    if (invalidRequest) throw requestPolicyError(revision());
    if (
      !submitted ||
      (responseStatus !== undefined && responseStatus >= 400) ||
      answer.stopReason === 'error' ||
      answer.stopReason === 'aborted'
    )
      throw providerInferenceFailure(
        hostedCorrection,
        responseStatus,
        answer.errorMessage,
        revision(),
      );
    const text = answer.content
      .flatMap((item) => (item.type === 'text' ? [item.text] : []))
      .join('');
    const actual = responseModel ?? answer.responseModel ?? answer.model;
    if (actual !== model.id || (responseTier !== undefined && responseTier !== standardTier))
      throw new ServiceInferenceError(
        'configuration',
        'Hosted inference returned an unexpected model or speed. Verify LTCOOK_MODEL_SMOL in AppRC or update LTCook.',
        revision(),
      );
    return {
      text,
      complete: answer.stopReason === 'stop' && !!text.trim(),
      usage: {
        inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
        outputTokens: usage.output,
      },
    };
  };
  provider.validate = async (signal) => {
    const { pi, model } = await prepare();
    try {
      const credentials = await pi.getAuth(model, { signal });
      if (!credentials) throw new Error();
      return inferenceRevision(model.id, inferenceRevision(credentials.auth));
    } catch {
      signal.throwIfAborted();
      throw new ServiceInferenceError('authentication', hostedCorrection.authentication);
    }
  };
  return provider;
}

import { randomUUID } from 'node:crypto';
import {
  ollamaChat,
  ollamaEndpoint,
  summaryGeneration,
  type OllamaSettings,
} from '../integrations/ollama.js';
import { inferenceRevision, ServiceInferenceError } from '../services/inference-recovery.js';

export type ConversationPrompt = { instructions: string; input: string };
export type ConversationInferenceMode = 'hosted' | 'local';

export type InferenceResponse = {
  text: string;
  complete: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export type ConversationProvider = {
  (prompt: ConversationPrompt, signal: AbortSignal): Promise<InferenceResponse>;
  validate?(signal: AbortSignal): Promise<string>;
};

type Request = {
  prompt: ConversationPrompt;
  signal: AbortSignal;
  resolve(value: string): void;
  reject(error: unknown): void;
};

const localModelCorrection =
  'Pull the configured model into the local Ollama instance or fix LTCOOK_CONVERSATION_LOCAL_MODEL in AppRC and restart LTCook.';

export function localConversationProvider(
  settings: OllamaSettings | (() => OllamaSettings),
): ConversationProvider {
  const configured = () => {
    let chosen: OllamaSettings;
    try {
      chosen = typeof settings === 'function' ? settings() : settings;
    } catch (error) {
      if (error instanceof ServiceInferenceError) throw error;
      throw new ServiceInferenceError(
        'configuration',
        'Set LTCOOK_CONVERSATION_LOCAL_MODEL to an Ollama model ID or Ollama alias in AppRC and restart LTCook.',
      );
    }
    let endpoint: URL;
    try {
      endpoint = ollamaEndpoint(chosen.endpoint);
    } catch {
      throw new ServiceInferenceError(
        'configuration',
        'Set LTCOOK_OLLAMA_ENDPOINT to an HTTP loopback URL with a port in AppRC and restart LTCook.',
      );
    }
    try {
      summaryGeneration(chosen);
    } catch {
      throw new ServiceInferenceError(
        'configuration',
        'Fix LTCOOK_SUMMARIZER_GENERATION in AppRC and restart LTCook.',
      );
    }
    if (!chosen.model.trim())
      throw new ServiceInferenceError('configuration', localModelCorrection);
    if (!Number.isSafeInteger(chosen.keepAlive) || chosen.keepAlive < -1)
      throw new ServiceInferenceError(
        'configuration',
        'Set LTCOOK_SUMMARIZER_KEEP_ALIVE to -1 or nonnegative seconds in AppRC and restart LTCook.',
      );
    return { chosen, endpoint };
  };

  const provider: ConversationProvider = async (prompt, signal) => {
    const { chosen } = configured();
    let usage: InferenceResponse['usage'];
    try {
      const reply = await ollamaChat(
        chosen,
        [
          { role: 'system', content: prompt.instructions },
          { role: 'user', content: prompt.input },
        ],
        signal,
        (tokens) => {
          usage = tokens;
        },
        'json',
      );
      return { text: reply.summary, complete: !reply.incomplete, usage };
    } catch (error) {
      signal.throwIfAborted();
      if (
        error instanceof Error &&
        /^Ollama summarizer model .* is unavailable\./s.test(error.message)
      )
        throw new ServiceInferenceError('configuration', localModelCorrection);
      throw new ServiceInferenceError(
        'transient',
        'Local Ollama did not complete the request. Check that the configured Ollama instance is running.',
      );
    }
  };
  provider.validate = async (signal) => {
    const { chosen, endpoint } = configured();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    const unavailable = () =>
      new ServiceInferenceError(
        'transient',
        'Local Ollama is unavailable. Start the configured Ollama instance.',
      );
    let response: Response;
    try {
      response = await fetch(new URL('/api/show', endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        redirect: 'error',
        signal: bounded as NonNullable<Parameters<typeof fetch>[1]>['signal'],
        body: JSON.stringify({ model: chosen.model.trim() }),
      });
      await response.body?.cancel();
    } catch {
      signal.throwIfAborted();
      throw unavailable();
    }
    if (response.status === 404)
      throw new ServiceInferenceError('configuration', localModelCorrection);
    if (!response.ok) throw unavailable();
    return inferenceRevision(chosen);
  };
  return provider;
}

export class ConversationInference {
  private readonly queue: Request[] = [];
  private readonly foreground = new Set<string>();
  private readonly lifetime = new AbortController();
  private active?: { mode: ConversationInferenceMode; releaseLocal: AbortController };
  private draining?: Promise<void>;
  constructor(
    private readonly providers: Partial<Record<ConversationInferenceMode, ConversationProvider>>,
    private readonly mode: ConversationInferenceMode,
    private readonly record?: (event: {
      mode: ConversationInferenceMode;
      elapsedMs: number;
      complete: boolean;
      usage?: InferenceResponse['usage'];
    }) => void,
    private readonly configurationError?: ServiceInferenceError,
  ) {}

  selection() {
    return this.mode;
  }

  private provider() {
    if (this.configurationError) throw this.configurationError;
    const provider = this.providers[this.mode];
    if (!provider)
      throw new ServiceInferenceError(
        'configuration',
        'Configure the selected LTCOOK_CONVERSATION_INFERENCE provider in AppRC and restart LTCook.',
      );
    return provider;
  }

  /** Check the selected route without submitting a conversation prompt. */
  async validate(signal: AbortSignal): Promise<string | undefined> {
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    combined.throwIfAborted();
    return this.provider().validate?.(combined);
  }

  foregroundStarted(id: string) {
    this.foreground.add(id);
    if (this.active?.mode === 'local') this.active.releaseLocal.abort();
  }

  foregroundEnded(id: string) {
    this.foreground.delete(id);
    this.start();
  }

  holdForeground() {
    const id = randomUUID();
    this.foregroundStarted(id);
    return () => this.foregroundEnded(id);
  }

  complete(prompt: ConversationPrompt, signal: AbortSignal): Promise<string> {
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    return new Promise((resolve, reject) => {
      combined.throwIfAborted();
      if (this.configurationError) throw this.configurationError;
      const request = {
        prompt,
        signal: combined,
        resolve: (value: string) => {
          combined.removeEventListener('abort', abort);
          resolve(value);
        },
        reject: (error: unknown) => {
          combined.removeEventListener('abort', abort);
          reject(error);
        },
      };
      const abort = () => {
        const index = this.queue.indexOf(request);
        if (index !== -1) this.queue.splice(index, 1);
        request.reject(combined.reason);
      };
      combined.addEventListener('abort', abort, { once: true });
      this.queue.push(request);
      this.start();
    });
  }

  private start() {
    if (this.draining || this.lifetime.signal.aborted || !this.queue.length) return;
    if (this.mode === 'local' && this.foreground.size > 0) return;
    this.draining = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.draining = undefined;
        this.start();
      });
  }

  private async drain() {
    while (this.queue.length && !this.lifetime.signal.aborted) {
      const mode = this.mode;
      if (mode === 'local' && this.foreground.size > 0) return;
      const request = this.queue.shift();
      if (!request) return;
      const releaseLocal = new AbortController();
      this.active = { mode, releaseLocal };
      const signal = AbortSignal.any([request.signal, releaseLocal.signal]);
      const start = performance.now();
      let result: InferenceResponse | undefined;
      try {
        result = await this.provider()(request.prompt, signal);
        signal.throwIfAborted();
        if (!result.complete || !result.text.trim())
          throw new ServiceInferenceError(
            'transient',
            'Inference returned an incomplete response.',
          );
        request.resolve(result.text);
      } catch (error) {
        if (releaseLocal.signal.aborted && !request.signal.aborted) {
          this.queue.unshift(request);
        } else {
          request.reject(error);
        }
      } finally {
        this.active = undefined;
        this.record?.({
          mode,
          elapsedMs: Math.round(performance.now() - start),
          complete: Boolean(result?.complete && !signal.aborted),
          usage: result?.usage,
        });
      }
    }
  }

  async close() {
    this.lifetime.abort();
    await this.draining;
  }
}

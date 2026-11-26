import { randomUUID } from 'node:crypto';
import { ollamaChat, type OllamaSettings } from '../integrations/ollama.js';

export type ConversationProduct = 'clarify' | 'tracker';
export type ConversationPrompt = { instructions: string; input: string };
export type ConversationInferenceMode = 'hosted' | 'local';

export type InferenceResponse = {
  text: string;
  complete: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export type ConversationProvider = (
  product: ConversationProduct,
  prompt: ConversationPrompt,
  signal: AbortSignal,
) => Promise<InferenceResponse>;

type Request = {
  product: ConversationProduct;
  prompt: ConversationPrompt;
  signal: AbortSignal;
  resolve(value: string): void;
  reject(error: unknown): void;
};

export function localConversationProvider(settings: OllamaSettings): ConversationProvider {
  return async (product, prompt, signal) => {
    let usage: InferenceResponse['usage'];
    const reply = await ollamaChat(
      settings,
      [
        { role: 'system', content: prompt.instructions },
        { role: 'user', content: prompt.input },
      ],
      signal,
      (tokens) => {
        usage = tokens;
      },
      product === 'tracker' ? 'json' : undefined,
    );
    return { text: reply.summary, complete: !reply.incomplete, usage };
  };
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
      product: ConversationProduct;
      mode: ConversationInferenceMode;
      elapsedMs: number;
      complete: boolean;
      usage?: InferenceResponse['usage'];
    }) => void,
  ) {}

  selection() {
    return this.mode;
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

  complete(
    product: ConversationProduct,
    prompt: ConversationPrompt,
    signal: AbortSignal,
  ): Promise<string> {
    const combined = AbortSignal.any([signal, this.lifetime.signal]);
    return new Promise((resolve, reject) => {
      combined.throwIfAborted();
      const request = {
        product,
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
      const priority = this.queue.findIndex(({ product }) => product === 'clarify');
      const [request] = this.queue.splice(Math.max(0, priority), 1);
      if (!request) return;
      const releaseLocal = new AbortController();
      this.active = { mode, releaseLocal };
      const signal = AbortSignal.any([request.signal, releaseLocal.signal]);
      const start = performance.now();
      let result: InferenceResponse | undefined;
      try {
        const provider = this.providers[mode];
        if (!provider) throw new Error(`The configured ${mode} inference provider is unavailable.`);
        result = await provider(request.product, request.prompt, signal);
        signal.throwIfAborted();
        if (!result.complete || !result.text.trim())
          throw new Error('Inference returned an incomplete response.');
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
          product: request.product,
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

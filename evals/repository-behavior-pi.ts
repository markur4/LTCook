import { defineTool } from '@earendil-works/pi-coding-agent';
import { sanitizeEvaluationText } from '../runtime/src/evals/diagnostics.js';
import { EVAL_MODEL } from '../runtime/src/evals/setup.js';
import { createLocalPiEvaluationSession } from '../runtime/src/evals/summarization-decision.js';
import {
  inspectEvaluationModel,
  listEvaluationModels,
  modelTag,
} from '../runtime/src/evals/summarization-grader.js';
import type { ToolDefinition } from '../runtime/src/tools/types.js';

const endpoint = process.env.LTCOOK_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434';

/** Identify the installed Ollama model before running either arm. */
export async function repositoryPiModel(model: string | undefined, signal: AbortSignal) {
  const installed = (await listEvaluationModels(endpoint, signal)).find(
    ({ name }) => modelTag(name) === modelTag(model ?? EVAL_MODEL),
  );
  if (!installed) throw new Error('The selected repository evaluation model is not installed.');
  return inspectEvaluationModel(endpoint, installed, signal);
}

/** Run a fresh local Pi session with read access to the owned fixture only. */
export async function evaluateRepositoryWithPi({
  model = EVAL_MODEL,
  workspace,
  directory,
  agentId,
  prompt,
  tools,
  signal,
}: {
  model?: string;
  workspace: string;
  directory: string;
  agentId: string;
  prompt: string;
  tools: readonly ToolDefinition[];
  signal: AbortSignal;
}) {
  const started = performance.now();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(150_000)]);
  const customTools = tools.map((tool) =>
    defineTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_id, input, toolSignal) {
        const result = await tool.invoke(input, {
          agentId,
          workspaceRoot: workspace,
          workspaceFileAccess: false,
          repositorySearchAccess: true,
          signal: toolSignal ? AbortSignal.any([bounded, toolSignal]) : bounded,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    }),
  );
  const { session } = await createLocalPiEvaluationSession({
    endpoint,
    model,
    directory,
    instructions: 'Answer the repository question using evidence from the available tools.',
    tools: customTools.map(({ name }) => name),
    customTools,
  });
  const cancel = () => void session.abort();
  bounded.addEventListener('abort', cancel, { once: true });
  try {
    bounded.throwIfAborted();
    await session.prompt(prompt);
    bounded.throwIfAborted();
    const turns = session.messages.filter((message) => message.role === 'assistant');
    const answer = turns.at(-1);
    const observedModel = answer?.responseModel ?? null;
    if (
      turns.some(
        ({ responseModel }) => responseModel && modelTag(responseModel) !== modelTag(model),
      )
    ) {
      throw new Error('Pi reported a different model from the selected evaluation model.');
    }
    if (answer?.stopReason !== 'stop') {
      throw new Error(answer?.errorMessage ?? 'Pi did not return a complete answer.');
    }
    const text = answer.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('')
      .trim()
      .replace(/^```(?:json)?\s+|\s+```$/gi, '');
    const usage = turns.reduce(
      (total, { usage }) => ({
        inputTokens: total.inputTokens + usage.input + usage.cacheRead + usage.cacheWrite,
        outputTokens: total.outputTokens + usage.output,
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = undefined;
    }
    return {
      answer: parsed,
      elapsedMs: performance.now() - started,
      started,
      exitCode: 0,
      observedModel,
      usage,
    };
  } catch (error) {
    signal.throwIfAborted();
    return {
      answer: undefined,
      elapsedMs: performance.now() - started,
      started,
      exitCode: 1,
      observedModel: null,
      error: sanitizeEvaluationText(
        error instanceof Error ? error.message : 'Pi evaluation failed.',
      ),
    };
  } finally {
    bounded.removeEventListener('abort', cancel);
    session.dispose();
  }
}

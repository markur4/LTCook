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
import type { RepositoryHit, RepositoryRetrieval } from '../runtime/src/repository/results.js';

const endpoint = process.env.LTCOOK_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:11434';
const toolCallLimit = 16;
type SearchResult = {
  status: RepositoryRetrieval['value']['status'];
  results?: readonly RepositoryHit[];
};
type SearchAttempt = {
  finished?: number;
  requestKey?: string;
  searches: readonly { result: SearchResult }[];
};
type StopReason = 'repeated-search' | 'retrieval-unavailable' | 'tool-budget';

function evidenceKeys(results: readonly SearchResult[]): string[] {
  return results.flatMap(({ results: hits }) =>
    (hits ?? []).map(({ path, startLine, endLine, excerpt, excerptTruncated }) =>
      JSON.stringify([path, startLine, endLine, excerpt, excerptTruncated]),
    ),
  );
}

/** Stop on exhausted searches in the fixed fixture using only observed tool results. */
export function repositorySearchStop(attempts: readonly SearchAttempt[]): StopReason | undefined {
  const [latest, previous, ...earlier] = attempts
    .flatMap((attempt) =>
      attempt.finished === undefined ? [] : [{ ...attempt, finished: attempt.finished }],
    )
    .toSorted((left, right) => right.finished - left.finished);
  if (!latest || !previous) return;
  const latestResults = latest.searches.map(({ result }) => result);
  if (!latestResults.length) return;
  if (
    latestResults.every(({ status }) => status === 'unavailable') &&
    previous.searches.length &&
    previous.searches.every(({ result }) => result.status === 'unavailable')
  )
    return 'retrieval-unavailable';
  if (!latest.requestKey || latestResults.some(({ status }) => status !== 'ready')) return;
  const priorReady = [previous, ...earlier].filter(
    ({ requestKey, searches }) =>
      requestKey === latest.requestKey &&
      searches.length > 0 &&
      searches.every(({ result }) => result.status === 'ready'),
  );
  const priorEvidence = new Set(
    priorReady.flatMap(({ searches }) => evidenceKeys(searches.map(({ result }) => result))),
  );
  if (priorReady.length && evidenceKeys(latestResults).every((entry) => priorEvidence.has(entry)))
    return 'repeated-search';
}

const finishingPrompts = {
  'repeated-search': 'Use the evidence already returned to produce the requested JSON.',
  'tool-budget': 'Use the evidence already returned to produce the requested JSON.',
  'retrieval-unavailable':
    'The last searches were unavailable. If earlier evidence cannot answer the question, return the requested JSON with outcome "insufficient-evidence" and no facts.',
} satisfies Record<StopReason, string>;

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
  attempts,
  signal,
}: {
  model?: string;
  workspace: string;
  directory: string;
  agentId: string;
  prompt: string;
  tools: readonly ToolDefinition[];
  attempts: readonly SearchAttempt[];
  signal: AbortSignal;
}) {
  const started = performance.now();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(150_000)]);
  let toolCalls = 0;
  const customTools = tools.map((tool) =>
    defineTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_id, input, toolSignal) {
        if (toolCalls >= toolCallLimit)
          throw new Error('Repository evaluation tool budget reached.');
        toolCalls++;
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
  let stopReason: StopReason | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== 'tool_execution_end' || stopReason) return;
    stopReason =
      repositorySearchStop(attempts) ?? (toolCalls >= toolCallLimit ? 'tool-budget' : undefined);
    if (!stopReason) return;
    session.setActiveToolsByName([]);
    void session.steer(finishingPrompts[stopReason]).catch(cancel);
  });
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
      toolBudgetReached: toolCalls >= toolCallLimit,
      toolStopReason: stopReason,
    };
  } catch (error) {
    signal.throwIfAborted();
    return {
      answer: undefined,
      elapsedMs: performance.now() - started,
      started,
      exitCode: 1,
      observedModel: null,
      toolBudgetReached: toolCalls >= toolCallLimit,
      toolStopReason: stopReason,
      error: sanitizeEvaluationText(
        error instanceof Error ? error.message : 'Pi evaluation failed.',
      ),
    };
  } finally {
    bounded.removeEventListener('abort', cancel);
    unsubscribe();
    session.dispose();
  }
}

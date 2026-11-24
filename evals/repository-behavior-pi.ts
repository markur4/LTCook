import { defineTool } from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';
import { sanitizeEvaluationText } from '../runtime/src/evals/diagnostics.js';
import { EVAL_MODEL } from '../runtime/src/evals/setup.js';
import { createLocalPiEvaluationSession } from '../runtime/src/evals/summarization-decision.js';
import {
  inspectEvaluationModel,
  listEvaluationModels,
  modelTag,
} from '../runtime/src/evals/summarization-grader.js';
import type { ToolDefinition } from '../runtime/src/tools/types.js';
import { repositoryEvidenceText } from '../runtime/src/tools/repository-evidence-text.js';
import type { RepositoryHit, RepositoryRetrieval } from '../runtime/src/repository/results.js';
import { RepositoryBehaviorAnswer } from './repository-behavior-grade.js';

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
  extraEvidence?: readonly RepositoryHit[];
  traceStatus?: SearchResult['status'];
};
type StopReason = 'repeated-search' | 'retrieval-unavailable' | 'tool-budget';

function evidenceKeys({ searches, extraEvidence = [] }: SearchAttempt): string[] {
  const hits = [...searches.flatMap(({ result }) => result.results ?? []), ...extraEvidence];
  return hits.map(({ path, startLine, endLine, excerpt, excerptTruncated }) =>
    JSON.stringify([path, startLine, endLine, excerpt, excerptTruncated]),
  );
}

function unavailable({ searches, traceStatus }: SearchAttempt): boolean {
  return (
    traceStatus === 'unavailable' ||
    (searches.length > 0 && searches.every(({ result }) => result.status === 'unavailable'))
  );
}

function ready({ searches, extraEvidence, traceStatus }: SearchAttempt): boolean {
  return searches.length
    ? searches.every(({ result }) => result.status === 'ready')
    : traceStatus === 'ready' || Boolean(extraEvidence?.length);
}

/** Decide at the end of a tool batch using only observed requests and results. */
export function repositorySearchStop(
  attempts: readonly SearchAttempt[],
  completedToolAttempts: number,
  toolsInTurn: number,
): StopReason | undefined {
  if (completedToolAttempts >= toolCallLimit) return 'tool-budget';
  const completed = attempts
    .flatMap((attempt) =>
      attempt.finished === undefined ? [] : [{ ...attempt, finished: attempt.finished }],
    )
    .toSorted((left, right) => right.finished - left.finished);
  const [latest, previous, ...earlier] = completed;
  if (!latest || !previous) return;
  if (
    completed.length >= toolsInTurn &&
    completed.slice(0, Math.max(toolsInTurn, 2)).every(unavailable)
  )
    return 'retrieval-unavailable';
  if (toolsInTurn !== 1) return;
  if (!latest.requestKey || !ready(latest)) return;
  const priorReady = [previous, ...earlier].filter(
    (attempt) => attempt.requestKey === latest.requestKey && ready(attempt),
  );
  const priorEvidence = new Set(priorReady.flatMap(evidenceKeys));
  if (priorReady.length && evidenceKeys(latest).every((entry) => priorEvidence.has(entry)))
    return 'repeated-search';
}

const finalAnswerInstruction =
  'Return only the requested JSON from the evidence already shown. Cite the exact supporting source range separately for each fact.';
const outageInstruction =
  'When the searches were unavailable and earlier evidence cannot answer the question, use outcome "insufficient-evidence" and an empty facts array.';

function decodeAnswer(text: string): unknown {
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s+|\s+```$/gi, '')) as unknown;
  } catch {
    return undefined;
  }
}

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
  let providerCalls = 0;
  const customTools = tools.map((tool) =>
    defineTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_id, input, toolSignal) {
        if (providerCalls >= toolCallLimit)
          throw new Error('Repository evaluation tool budget reached.');
        providerCalls++;
        const result = await tool.invoke(input, {
          agentId,
          workspaceRoot: workspace,
          workspaceFileAccess: false,
          repositorySearchAccess: true,
          signal: toolSignal ? AbortSignal.any([bounded, toolSignal]) : bounded,
        });
        return {
          content: [{ type: 'text', text: repositoryEvidenceText(tool.name, result) }],
          details: result,
        };
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
  let completedToolAttempts = 0;
  let toolErrors = 0;
  let recordedAttempts = 0;
  let toolAfterStop = false;
  let finalAnswerRetry: 'tool-after-stop' | 'invalid-answer-format' | undefined;
  const unsubscribe = session.agent.subscribe(async (event) => {
    if (event.type === 'tool_execution_end') {
      completedToolAttempts++;
      if (event.isError) toolErrors++;
    }
    if (event.type !== 'turn_end' || !event.toolResults.length) return;
    if (stopReason || finalAnswerRetry) {
      toolAfterStop = true;
      cancel();
      return;
    }
    const toolsInTurn = event.toolResults.length;
    const observedTurn = attempts.length - recordedAttempts === toolsInTurn;
    recordedAttempts = attempts.length;
    stopReason = repositorySearchStop(
      observedTurn ? attempts : [],
      completedToolAttempts,
      toolsInTurn,
    );
    if (!stopReason) return;
    session.setActiveToolsByName([]);
    const finish =
      stopReason === 'retrieval-unavailable'
        ? `${finalAnswerInstruction} ${outageInstruction}`
        : finalAnswerInstruction;
    await session.steer(finish).catch(cancel);
  });
  bounded.addEventListener('abort', cancel, { once: true });
  try {
    bounded.throwIfAborted();
    await session.prompt(prompt).catch((error: unknown) => {
      if (!toolAfterStop) throw error;
    });
    bounded.throwIfAborted();
    const readAnswer = () => {
      const message = session.messages.findLast((item) => item.role === 'assistant');
      const text = message?.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('');
      return { message, parsed: decodeAnswer(text ?? '') };
    };
    let { message: answer, parsed } = readAnswer();
    if (
      toolAfterStop ||
      (answer?.stopReason === 'stop' && !Value.Check(RepositoryBehaviorAnswer, parsed))
    ) {
      finalAnswerRetry = toolAfterStop ? 'tool-after-stop' : 'invalid-answer-format';
      session.setActiveToolsByName([]);
      await session.prompt(`${finalAnswerInstruction} ${outageInstruction}`);
      bounded.throwIfAborted();
      ({ message: answer, parsed } = readAnswer());
    }
    const turns = session.messages.filter((message) => message.role === 'assistant');
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
    const usage = turns.reduce(
      (total, { usage }) => ({
        inputTokens: total.inputTokens + usage.input + usage.cacheRead + usage.cacheWrite,
        outputTokens: total.outputTokens + usage.output,
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
    return {
      answer: parsed,
      elapsedMs: performance.now() - started,
      started,
      exitCode: 0,
      observedModel,
      usage,
      completedToolAttempts,
      toolErrors,
      toolBudgetReached: completedToolAttempts >= toolCallLimit,
      toolStopReason: stopReason,
      finalAnswerRetry,
    };
  } catch (error) {
    signal.throwIfAborted();
    return {
      answer: undefined,
      elapsedMs: performance.now() - started,
      started,
      exitCode: 1,
      observedModel: null,
      completedToolAttempts,
      toolErrors,
      toolBudgetReached: completedToolAttempts >= toolCallLimit,
      toolStopReason: stopReason,
      finalAnswerRetry,
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

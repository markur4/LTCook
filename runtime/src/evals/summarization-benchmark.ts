import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReadToolDefinition, defineTool } from '@earendil-works/pi-coding-agent';
import type { OllamaSettings, OllamaUsage } from '../integrations/ollama.js';
import { createSummarizeTool } from '../tools/summarize.js';
import { sanitizeEvaluationText } from './diagnostics.js';
import { EVAL_MODEL, hash } from './setup.js';
import { createLocalPiEvaluationSession } from './summarization-decision.js';
import { CODING_SESSION_CASE } from './summarization-fixtures.js';
import { modelTag } from './summarization-grader.js';

const sourceFile = 'session-notes.txt';
const focus = CODING_SESSION_CASE.focus!;
const toolCallLimit = 4;
const instructions =
  'Review the supplied coding session as a read-only handoff. Use its evidence to distinguish the original failure, the correction, and the final state. ' +
  'After collecting the evidence, stop calling tools and return only the requested JSON object.';
const task =
  'Report the failed check ID (failedCheck), its test file (failedPath), original error ID (error), and original exit code as a number (originalExitCode). ' +
  'Give the manifest file (manifestPath) and its retired entry (retiredEntry), the related passing check ID (relatedCheck), ' +
  "and the repaired check's exit code as a number (rerunExitCode). " +
  'Give the platform whose smoke workflow was skipped (skippedPlatform), whether Mina approved publishing (publishApproved, boolean), and the open issue ID (openIssue).';
const methods = {
  baseline: `Read ${sourceFile} in one read call, then answer from its contents.`,
  summarizer: `First call ltcook_summarize once with path ${sourceFile} and this exact focus: ${focus}\nUse read only for supporting passages you need to verify, then answer.`,
};
const finish = 'The tool budget is used. Answer now from the evidence already collected. ' + task;
const expected = {
  failedCheck: 'RB-214',
  failedPath: 'tests/package/reconcile.test.ts',
  error: 'E_MANIFEST',
  originalExitCode: 23,
  manifestPath: 'distribution/manifest.json',
  retiredEntry: 'bin/reconcile',
  relatedCheck: 'RB-241',
  rerunExitCode: 0,
  skippedPlatform: 'Windows',
  publishApproved: false,
  openIssue: 'PKG-72',
};

type SummaryCall = {
  toolCallId: string;
  pathAndFocusMatched: boolean;
  completed: boolean;
  elapsedMs: number;
  usage?: OllamaUsage;
};

export async function runSummarizationBenchmark(settings: OllamaSettings, signal: AbortSignal) {
  const root = await mkdtemp(path.join(tmpdir(), 'ltcook-summary-benchmark-'));
  try {
    const conditions = [];
    for (const condition of ['baseline', 'summarizer'] as const) {
      signal.throwIfAborted();
      const started = performance.now();
      const directory = path.join(root, condition);
      const fixturePath = path.join(directory, sourceFile);
      let reservedCalls = 0;
      const reserveCall = () => {
        if (reservedCalls >= toolCallLimit) throw new Error('The tool budget is used. Answer now.');
        reservedCalls++;
      };
      const fixtureOnly = (absolutePath: string) => {
        if (absolutePath !== fixturePath) throw new Error('Read the fixed benchmark source file.');
        return absolutePath;
      };
      const read = createReadToolDefinition(directory, {
        operations: {
          access: async (file) => access(fixtureOnly(file)),
          readFile: async (file) => readFile(fixtureOnly(file)),
        },
      });
      const readTool = defineTool({
        ...read,
        async execute(...args) {
          reserveCall();
          return read.execute(...args);
        },
      });
      const summaryCalls: SummaryCall[] = [];
      let measurement: SummaryCall | undefined;
      const tool = createSummarizeTool(settings, (usage) => {
        if (measurement) measurement.usage = usage;
      });
      const summaryTool = defineTool({
        name: tool.name,
        label: 'Summarize workspace file',
        description: tool.description,
        parameters: tool.inputSchema,
        executionMode: 'sequential',
        async execute(toolCallId, args, toolSignal) {
          reserveCall();
          const begin = performance.now();
          const call: SummaryCall = {
            toolCallId,
            pathAndFocusMatched:
              args.path !== undefined &&
              path.resolve(directory, args.path) === fixturePath &&
              args.focus === focus,
            completed: false,
            elapsedMs: 0,
          };
          summaryCalls.push(call);
          measurement = call;
          try {
            if (!call.pathAndFocusMatched) throw new Error('Use the specified path and focus.');
            const result = await tool.invoke(args, {
              agentId: 'summarization-benchmark',
              workspaceRoot: directory,
              workspaceFileAccess: true,
              signal: toolSignal ? AbortSignal.any([signal, toolSignal]) : signal,
            });
            call.completed =
              result.incomplete === false &&
              modelTag(String(result.model)) === modelTag(settings.model);
            return {
              content: [{ type: 'text', text: JSON.stringify(result) }],
              details: undefined,
            };
          } finally {
            call.elapsedMs = performance.now() - begin;
            measurement = undefined;
          }
        },
      });
      const { session } = await createLocalPiEvaluationSession({
        endpoint: settings.endpoint,
        model: EVAL_MODEL,
        directory,
        instructions,
        tools: condition === 'baseline' ? ['read'] : ['read', summaryTool.name],
        customTools: condition === 'baseline' ? [readTool] : [readTool, summaryTool],
      });
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      const cancel = () => void session.abort();
      bounded.addEventListener('abort', cancel, { once: true });
      let executedCalls = 0;
      let turn = 0;
      let budgetTurn: number | undefined;
      let failure: string | undefined;
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'turn_start') turn++;
        if (event.type !== 'tool_execution_end') return;
        executedCalls++;
        if (executedCalls >= toolCallLimit && budgetTurn === undefined) {
          budgetTurn = turn;
          session.setActiveToolsByName([]);
          void session.steer(finish).catch(() => {
            failure = 'Pi could not request a final answer after the tool budget.';
            void session.abort();
          });
        } else if (budgetTurn !== undefined && turn > budgetTurn) {
          failure = 'Pi continued calling tools after the tool budget.';
          void session.abort();
        } else if (
          budgetTurn === undefined &&
          event.toolName === summaryTool.name &&
          summaryCalls.some((call) => call.completed)
        )
          session.setActiveToolsByName(['read']);
      });
      try {
        await writeFile(fixturePath, CODING_SESSION_CASE.source);
        bounded.throwIfAborted();
        await session.prompt(
          `${task}\n\n${methods[condition]}\nYou have up to ${toolCallLimit} tool calls.`,
        );
        bounded.throwIfAborted();
      } catch (error) {
        signal.throwIfAborted();
        failure ??= sanitizeEvaluationText(
          error instanceof Error ? error.message : 'Pi did not complete.',
        );
      } finally {
        bounded.removeEventListener('abort', cancel);
        unsubscribe();
        session.dispose();
      }
      const elapsedMs = performance.now() - started;
      const turns = session.messages.filter((message) => message.role === 'assistant');
      const answer = turns.at(-1);
      if (!answer || answer.stopReason !== 'stop')
        failure ??= 'Pi did not return a complete answer.';
      if (
        turns.some(
          ({ responseModel }) => responseModel && modelTag(responseModel) !== modelTag(EVAL_MODEL),
        )
      )
        failure ??= 'Ollama returned a different downstream model.';
      const response =
        answer?.content
          .flatMap((item) => (item.type === 'text' ? [item.text] : []))
          .join('')
          .trim() ?? '';
      let parsed: Record<string, unknown> | undefined;
      try {
        const value: unknown = JSON.parse(
          response.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1'),
        );
        if (value && typeof value === 'object' && !Array.isArray(value))
          parsed = value as Record<string, unknown>;
        else failure ??= 'Pi returned a JSON value other than an object.';
      } catch {
        failure ??= 'Pi did not return a JSON object.';
      }
      const facts = Object.entries(expected).map(([field, wanted]) => ({
        field,
        expected: wanted,
        actual: typeof parsed?.[field] === typeof wanted ? parsed?.[field] : undefined,
        correct: parsed?.[field] === wanted,
      }));
      const calls = session.messages.filter((message) => message.role === 'toolResult');
      const firstCall = calls[0];
      const requiredToolUsed =
        condition === 'baseline'
          ? calls.some((call) => call.toolName === 'read' && !call.isError)
          : firstCall?.toolName === summaryTool.name &&
            !firstCall.isError &&
            summaryCalls.some((call) => call.toolCallId === firstCall.toolCallId && call.completed);
      if (!requiredToolUsed) failure ??= 'Pi did not complete the required tool call.';
      const provider = turns.reduce(
        (usage, { usage: turn }) => ({
          turnsWithUsage: usage.turnsWithUsage + Number(turn.totalTokens > 0),
          uncachedInput: usage.uncachedInput + turn.input,
          cacheRead: usage.cacheRead + turn.cacheRead,
          cacheWrite: usage.cacheWrite + turn.cacheWrite,
          output: usage.output + turn.output,
        }),
        { turnsWithUsage: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      );
      conditions.push({
        condition,
        elapsedMs,
        failure,
        requiredToolUsed,
        toolCallLimitReached: executedCalls >= toolCallLimit,
        correctness: {
          correct: facts.filter(({ correct }) => correct).length,
          total: facts.length,
          facts,
        },
        toolCalls: calls.map(({ toolName, isError }) => ({ name: toolName, ok: !isError })),
        summaryCalls,
        providerUsage:
          provider.turnsWithUsage > 0
            ? {
                ...provider,
                totalInput: provider.uncachedInput + provider.cacheRead + provider.cacheWrite,
                turns: turns.length,
              }
            : undefined,
      });
    }
    return {
      downstreamModel: EVAL_MODEL,
      summarizerModel: settings.model,
      toolCallLimit,
      fixtureSha256: hash(CODING_SESSION_CASE.source),
      promptSha256: hash(JSON.stringify([instructions, task, methods, toolCallLimit, finish])),
      conditions,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

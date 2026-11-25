import { peakRunnerRss, residency } from '../runtime/src/evals/session-memory.js';
import {
  ollamaEndpoint,
  releaseOllamaModel,
  type OllamaSettings,
} from '../runtime/src/integrations/ollama.js';
import {
  originalTokenCount,
  SessionMemory,
  shortDiscussionTokens,
} from '../runtime/src/session-memory/service.js';
import {
  prepareMemorySummaries,
  summarizeMemory,
} from '../runtime/src/session-memory/summarization.js';
import type { MemorySourceMessage } from '../runtime/src/session-memory/units.js';
import { asymmetricFixtures } from './session-memory-asymmetric-fixtures.js';
import { transcriptSource } from './session-memory-context.js';
import { localMemoryPrompt } from './session-memory-local.js';
import { gradeSimplifiedLayer } from './session-memory-simplified.js';

const replyPrompt = `Summarize the agent's reply in concise Markdown bullets.

Use the user message to understand the reply and identify relevant information. Do not summarize the user message or repeat its requirements unnecessarily.

Preserve new findings, proposals, constraints, unresolved questions and reported outcomes.

Keep exact technical names, paths and numbers.

Distinguish planned work from completed work. Preserve uncertainty and negations.

Retain references to earlier Discussions without guessing their meaning.`;

const maximumReplyRatio = 0.7;
const agentId = 'asymmetric-evaluation';
const epoch = 'asymmetric-fixture';
const arms = ['local-bullets', 'agent-reply-only'] as const;

export async function compareAsymmetricMemory(input: {
  settings: OllamaSettings;
  digest: string;
  weightsDigest: string;
  signal: AbortSignal;
  auditOutput?: boolean;
  progress?: (label: string) => void;
}) {
  const { signal, digest, weightsDigest } = input;
  const settings = { ...input.settings, cpuOnly: true };
  const endpoint = ollamaEndpoint(settings.endpoint);
  const fixtures = [];
  for (const fixture of asymmetricFixtures) {
    const user = { seq: 1, turnId: fixture.id, author: 'user', text: fixture.user } as const;
    const agent = { seq: 2, turnId: fixture.id, author: 'agent', text: fixture.reply } as const;
    const messages = [user, agent];
    const facts = fixture.facts.map((fact) => ({ ...fact, source: agent.seq, critical: true }));
    const replyTokens = originalTokenCount([agent]);
    const exchangeTokens = originalTokenCount(messages);
    const agentBytes = Buffer.byteLength(agent.text);
    const memory = new SessionMemory({
      databasePath: ':memory:',
      source: transcriptSource(messages, epoch),
      summarize: async () => {
        throw new Error('The focused fixture must use its explicit request only.');
      },
    });
    try {
      const reopen = async (message: MemorySourceMessage) => {
        const result = await memory.sourceMessage(agentId, '', {
          agentId,
          epoch,
          seq: message.seq,
        });
        if (
          result.lookup === 'found' &&
          result.source.author === message.author &&
          result.source.turnId === message.turnId &&
          result.source.text === message.text
        )
          return result.source;
      };
      const retainedUser = await reopen(user);
      const retainedUserBytes = retainedUser ? Buffer.byteLength(retainedUser.text) : 0;
      const [portion, extra] = prepareMemorySummaries({ type: 'UAMP', messages }, [], undefined, {
        mode: 'no-context',
        format: 'markdown',
      });
      if (!portion || extra)
        throw new Error('Each focused exchange must fit in one inference request.');
      const baseline = localMemoryPrompt(portion.prompt, 'local-bullets');

      async function runArm(arm: (typeof arms)[number]) {
        input.progress?.(`${fixture.id}: ${arm}`);
        const asymmetric = arm === 'agent-reply-only';
        const originalBytes = Buffer.byteLength(user.text) + agentBytes;
        if ((asymmetric ? replyTokens : exchangeTokens) < shortDiscussionTokens) {
          const retainedReply = await reopen(agent);
          return {
            arm,
            requests: 0,
            outcome: retainedUser && retainedReply ? ('retained' as const) : ('failed' as const),
            acceptedCombinedBytes: retainedUser && retainedReply ? originalBytes : null,
            passed: false,
          };
        }
        const prompt: typeof baseline = asymmetric
          ? [
              { ...baseline[0], content: replyPrompt },
              {
                ...baseline[1],
                content: baseline[1].content.replace(
                  /(\n)Summarize current sources only (\(#[0-9]+ to #[0-9]+\)\.)/,
                  '$1Use current sources only $2 Summarize only the agent reply.',
                ),
              },
            ]
          : baseline;

        await releaseOllamaModel(settings, signal);
        const start = performance.now();
        const request = await summarizeMemory(
          settings,
          prompt,
          signal,
          'UAMP',
          true,
          undefined,
          'markdown',
        )
          .then((result) => ({ result, observedMs: performance.now() - start }))
          .catch((error: unknown) => {
            signal.throwIfAborted();
            return {
              result: undefined,
              observedMs: performance.now() - start,
              error: error instanceof Error ? error.message : String(error),
            };
          });
        const loaded = await residency(endpoint, digest, signal);
        const cpuVerified = !!loaded && loaded.bytes > 0 && loaded.gpuBytes === 0;
        const peakRssBytes = await peakRunnerRss(weightsDigest);
        const { result } = request;
        const outputBytes = result ? Buffer.byteLength(result.text) : null;
        const replyRatio = outputBytes === null ? null : outputBytes / agentBytes;
        const replyGrade = gradeSimplifiedLayer(
          facts,
          result?.complete
            ? [{ seq: agent.seq, sources: [user.seq, agent.seq], text: result.text }]
            : [],
          messages,
        );
        const valid =
          cpuVerified &&
          result?.metrics?.thinkingPresent === false &&
          result.metrics.reasoningTokens === 0;
        const outcome = !result
          ? 'failed'
          : !result.complete
            ? 'incomplete'
            : !valid || !retainedUser || !replyGrade.passed
              ? 'failed'
              : replyRatio === null || replyRatio >= 1
                ? 'non-compressive'
                : replyRatio > maximumReplyRatio
                  ? 'insufficient-compression'
                  : 'accepted';
        const fallback = asymmetric && outcome !== 'accepted' ? await reopen(agent) : undefined;

        return {
          arm,
          requests: 1,
          outcome,
          passed: outcome === 'accepted',
          ...('error' in request ? { error: request.error } : {}),
          providerComplete: result?.complete ?? false,
          cpuVerified,
          peakRssBytes,
          usage: result?.usage,
          metrics: result?.metrics,
          isolatedCpuWallMs: cpuVerified ? request.observedMs : null,
          outputBytes,
          replyRatio,
          nonCompressive: replyRatio !== null && replyRatio >= 1,
          combinedBytes:
            outputBytes === null || !retainedUser ? null : retainedUserBytes + outputBytes,
          acceptedCombinedBytes:
            outcome === 'accepted' && outputBytes !== null ? retainedUserBytes + outputBytes : null,
          replyGrade,
          ...(fallback
            ? {
                originalReplyFallback: {
                  sequence: fallback.seq,
                  bytes: Buffer.byteLength(fallback.text),
                  exact: true,
                },
              }
            : {}),
          ...(input.auditOutput ? { prompt, output: result?.text } : {}),
        };
      }

      const results = [];
      for (const arm of arms) results.push(await runArm(arm));
      fixtures.push({
        fixture: fixture.id,
        userRetention: {
          expected: 1,
          exact: Number(!!retainedUser),
          sequence: user.seq,
          bytes: retainedUserBytes,
        },
        replySource: { bytes: agentBytes, estimatedTokens: replyTokens },
        exchangeSource: {
          bytes: Buffer.byteLength(user.text) + agentBytes,
          estimatedTokens: exchangeTokens,
        },
        arms: results,
      });
    } finally {
      await memory.close();
    }
  }
  return {
    maximumReplyRatio,
    fixtures,
    passed: fixtures.every(({ arms }) =>
      arms.some(({ arm, passed }) => arm === 'agent-reply-only' && passed),
    ),
  };
}

import { peakRunnerRss, residency } from '../runtime/src/evals/session-memory.js';
import {
  ollamaEndpoint,
  releaseOllamaModel,
  summaryGeneration,
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
          const retained = !!retainedUser && !!retainedReply;
          return {
            arm,
            requests: 0,
            outcome: retained ? ('retained' as const) : ('failed' as const),
            acceptedCombinedBytes: retained ? originalBytes : null,
            passed: retained,
          };
        }
        let prompt = baseline;
        if (asymmetric) {
          const [system, user] = baseline;
          const content = user.content.replace(
            /^Summarize current sources only (\(#[0-9]+ to #[0-9]+\)\.)$/m,
            'Use current sources only $1 Summarize only the agent reply.',
          );
          if (content === user.content)
            throw new Error('Cannot replace the current UAMP summary instruction.');
          prompt = [
            { ...system, content: replyPrompt },
            { ...user, content },
          ];
        }

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
        const { result } = request;
        let residencyError: string | undefined;
        const loaded = result
          ? await residency(endpoint, digest, signal).catch((error: unknown) => {
              signal.throwIfAborted();
              residencyError = error instanceof Error ? error.message : String(error);
              return null;
            })
          : null;
        const cpuVerified = !!loaded && loaded.bytes > 0 && loaded.gpuBytes === 0;
        const peakRssBytes = await peakRunnerRss(weightsDigest);
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
          ...(residencyError ? { residencyError } : {}),
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
    generation: summaryGeneration(settings),
    maximumReplyRatio,
    fixtures,
    passed: fixtures.every(({ arms }) =>
      arms.some(({ arm, outcome }) => arm === 'agent-reply-only' && outcome === 'accepted'),
    ),
  };
}

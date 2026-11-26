import type { MemoryFact, MemoryFixture } from '../runtime/src/evals/session-memory-fixtures.js';
import { resolveModel } from '../runtime/src/models/aliases.js';
import { createHostedMemorySummarizer } from '../runtime/src/session-memory/hosted.js';
import { runHostedMemoryArm } from './session-memory-simplified.js';

const baselineInstructions = `Summarize the current user-agent exchange in concise, structured Markdown for future reference.

Preserve essential information, exact technical identifiers, paths, numbers and observed outcomes.

Distinguish proposed, approved, rejected, planned and completed work. Preserve uncertainty and unresolved references to earlier Discussions without guessing their meaning.

Use the following sections where applicable. Group related information into coherent bullets and use nested bullets where useful. Omit empty sections, redundant information and unnecessary background.

**Intent**
- User goals, requests, requirements, constraints, preferences and corrections.

**Pasted**
- References to supplied material, its purpose and relevance to the current Discussion.

**Discoveries**
- New insights, technical findings, observed results and their implications.

**Disagreements**
- Objections, conflicting proposals, rejected approaches and their rationale.

**Decisions**
- Explicitly accepted decisions, agreements and their rationale.

**Questions**
- Unresolved questions, uncertainties and outstanding decisions.`;

function discussion(
  id: string,
  user: string,
  reply: string,
  facts: readonly MemoryFact[],
): MemoryFixture {
  const focus = 'Prepare the cache handoff with the findings, open proposals, and next actions.';
  return {
    id,
    turns: [
      [
        { seq: 1, author: 'user', text: user },
        { seq: 2, author: 'agent', text: reply },
      ],
      [{ seq: 3, author: 'user', text: focus }],
    ],
    flushAfter: [2],
    originalSources: [1, 2],
    correctionSources: [],
    focus,
    task: { prompt: focus, expected: {} },
    facts,
  };
}

function fact(source: number, label: string, expected: RegExp, contradicts?: RegExp): MemoryFact {
  return { source, label, expected, contradicts, kind: 'finding', critical: true };
}

const inventory = Array.from(
  { length: 8 },
  (_, i) =>
    `- [Cache replay PR #${41 + i}](https://example.com/review/${41 + i}): clean staging branch, waiting for remote integration. Remove the staging branch after the PR integrates. The branch is safe to inspect now, but cleanup must wait.`,
).join('\n');
const repeatedNotes =
  'The export runs every weekday. The operator can view the schedule in the existing dashboard. This is background about the normal export schedule.\n';
const fixtures = [
  {
    parts: 1,
    fixture: discussion(
      'link-heavy-inventory',
      'Check the cache replay branches. Preserve uncommitted work and report which branches can be removed.',
      `${inventory}\nTogether these branches use 7 GiB. None can be removed yet. The separate cache-labs branch has an uncommitted edit. Preserve it and ask the owner to reconcile it. No cleanup has run.`,
      [
        fact(
          2,
          'eight waiting branches and size',
          /(?:8|eight|#41.{0,24}#48).{0,160}7\s*GiB|7\s*GiB.{0,160}(?:8|eight|#41.{0,24}#48)/i,
        ),
        fact(
          2,
          'integrate remotely before cleanup',
          /(?:remote|integrat\w*|merg\w*).{0,100}(?:clean\w*|remov\w*|delet\w*)|(?:clean\w*|remov\w*|delet\w*).{0,100}(?:remote|integrat\w*|merg\w*)/i,
        ),
        fact(
          2,
          'uncommitted cache-labs edit',
          /cache-labs.{0,75}uncommitted|uncommitted.{0,75}cache-labs/i,
        ),
      ],
    ),
  },
  {
    parts: 1,
    fixture: discussion(
      'near-threshold-proposal',
      'Investigate why the cache export retries. Keep the existing API and wait for approval before changing it.',
      `The retry reuses CACHE_EPOCH. CACHE_RETRY_CHECK FAIL. I propose changing when the epoch is read. The proposal is unapproved and no code changed.\n${repeatedNotes.repeat(6)}`,
      [
        fact(
          1,
          'preserve existing API',
          /(?:keep|preserve|unchanged|retain).{0,35}(?:the )?(?:existing )?API|API.{0,35}(?:unchanged|stay the same)/i,
        ),
        fact(2, 'retry failure', /CACHE_RETRY_CHECK.{0,15}FAIL/i),
        fact(
          2,
          'epoch change is only proposed',
          /(?:propos\w*|unapproved).{0,95}epoch|epoch.{0,95}(?:propos\w*|unapproved|pending approval)/i,
          /(?:implemented|approved|completed) (?:the |a )?(?:CACHE_)?epoch (?:read |timing )?change/i,
        ),
      ],
    ),
  },
  {
    parts: 2,
    fixture: discussion(
      'split-exchange',
      `I approve changing the cache snapshot to read under CACHE_LOCK. Preserve the existing API.\n${repeatedNotes.repeat(120)}`,
      `The first trial of CACHE_SNAPSHOT_CHECK failed. The fixture still reproduced the cache race. Implementation remains pending.\n${repeatedNotes.repeat(120)}`,
      [
        fact(
          1,
          'user approved the CACHE_LOCK change',
          /(?:approv\w*|authoriz\w*|agreed).{0,100}CACHE_LOCK|CACHE_LOCK.{0,100}(?:approv\w*|authoriz\w*|agreed)/i,
        ),
        fact(2, 'snapshot check failed', /CACHE_SNAPSHOT_CHECK.{0,18}fail/i),
        fact(
          2,
          'implementation remains pending',
          /(?:implementation|work|change).{0,45}pending|not (?:yet )?implemented|no (?:code )?changes/i,
          /(?:implemented|completed) (?:the |a )?(?:cache )?snapshot change/i,
        ),
      ],
    ),
  },
];

function median(ratios: (number | null)[]) {
  if (ratios.some((ratio) => ratio === null)) return null;
  const ordered = ratios.filter((ratio) => ratio !== null).sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)] ?? null;
}

export async function compareHostedCompression(
  signal: AbortSignal,
  progress: (label: string) => void,
) {
  const selection = resolveModel('tiny', process.env);
  if (selection.provider !== 'openai-codex' || selection.reasoning !== 'low')
    throw new Error(
      'Hosted compression requires @tiny via the Codex subscription with low reasoning.',
    );
  const backend = createHostedMemorySummarizer(selection);
  const cases = [];
  for (const { parts, fixture } of fixtures) {
    const arms = [];
    for (const arm of ['baseline', 'candidate'] as const) {
      signal.throwIfAborted();
      progress(`Hosted compression: ${fixture.id} (${arm})`);
      let sent = 0;
      const result = await runHostedMemoryArm(fixture, {
        signal,
        hosted: {
          inference: {
            hosted: { model: selection.model, reasoning: selection.reasoning },
            local: { model: 'unused', reasoning: 'none' },
          },
          summarize(type, prompt, requestSignal) {
            if (++sent > parts)
              throw new Error('The fixture exceeded its expected summary requests.');
            const [system, user] = prompt;
            return backend.summarize(
              type,
              arm === 'baseline' ? [{ ...system, content: baselineInstructions }, user] : prompt,
              requestSignal,
            );
          },
        },
      });
      const [record, extra] = result.discussions;
      const original = record?.originalTokens;
      const summary = record?.summaryTokens;
      const matched =
        !extra &&
        record?.parts.length === parts &&
        result.requests.length === parts &&
        result.requests.every(
          ({ result, currentOnly, currentSources }, index) =>
            currentOnly &&
            currentSources?.join() === record.parts[index]?.join() &&
            result.complete &&
            result.hosted?.providerModelVerified,
        ) &&
        result.sourcePreservation?.passed === true;
      arms.push({
        arm,
        matched,
        original,
        summary,
        ratio: matched && original && summary !== undefined ? summary / original : null,
        usage: result.measurements,
        errors: result.requests.flatMap(({ error }) => (error ? [error] : [])),
        quality: {
          generated: result.quality.summarization,
          stored: result.quality.sessionMemory,
          handoff: result.quality.beforeRecovery,
        },
        passed: matched && result.passed,
      });
    }
    cases.push({ fixture: fixture.id, arms });
  }
  const baseline = median(cases.map(({ arms }) => arms[0]?.ratio ?? null));
  const candidate = median(cases.map(({ arms }) => arms[1]?.ratio ?? null));
  return {
    model: selection.model,
    reasoning: selection.reasoning,
    provider: selection.provider,
    usage: backend.usage(),
    cases,
    median: { baseline, candidate },
    passed:
      baseline !== null &&
      candidate !== null &&
      candidate < baseline &&
      cases.every(({ arms }) => {
        const result = arms[1];
        return result?.passed && result.ratio !== null && result.ratio < 1;
      }),
  };
}

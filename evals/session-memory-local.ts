import { z } from 'zod';
import type { MemoryFixture } from '../runtime/src/evals/session-memory-fixtures.js';
import type { summarizeMemory } from '../runtime/src/session-memory/summarization.js';
import { gradeSimplifiedLayer, runSimplifiedMemoryArm } from './session-memory-simplified.js';

const comparisonArms = ['immediate', 'local-template', 'local-bullets'] as const;
export const localMemoryArms = [...comparisonArms, 'local-extractive'] as const;
type LocalArm = (typeof localMemoryArms)[number];
type Prompt = Parameters<typeof summarizeMemory>[1];
type ArmInput = Parameters<typeof runSimplifiedMemoryArm>[2];

export function localValidationArms(report: unknown): LocalArm[] {
  const { localResults } = z
    .object({
      frozenRevision: z.literal('e7f1d601d1382586b903e757281c165ffffc396d'),
      seed: z.literal(17),
      localResults: z.array(
        z.object({
          model: z.object({ weightsDigest: z.string() }),
          arms: z.array(
            z.object({
              fixture: z.literal('semantic-manifest-reference'),
              arm: z.enum(localMemoryArms),
              passed: z.boolean(),
            }),
          ),
        }),
      ),
    })
    .parse(report);
  const candidate = localResults.find(
    ({ model }) =>
      model.weightsDigest === '31eb5db92b2e02a80e9e3a9316aa83120cbee98e4f4a22ca19015ba601dbd690',
  );
  const eligible = localMemoryArms.filter(
    (arm) => arm !== 'immediate' && candidate?.arms.some((item) => item.arm === arm && item.passed),
  );
  if (!eligible.length)
    throw new Error('No local MNN-Pocket arm passed the manifest evidence gate.');
  return ['immediate', ...eligible];
}

const localBullets = `Summarize this user-agent exchange in concise Markdown bullets.

Preserve requests, constraints, decisions, discoveries and unresolved questions.

Keep exact technical names, paths, numbers and observed outcomes.

Distinguish proposed, approved and completed work.

Preserve references to earlier discussions without guessing their meaning. Omit redundant information.`;

const localExtractive = `Select the important sentences from the current user-agent exchange.

Retain their original wording and authorship. Preserve requests, decisions, constraints, discoveries and unresolved questions.

Keep exact technical identifiers, paths, numbers, negations and distinctions between planned and completed work.

Omit redundant sentences. Do not paraphrase or invent information.`;

const excerptSource = z.object({ seq: z.number(), author: z.string(), text: z.string() });
const sentences = new Intl.Segmenter('en', { granularity: 'sentence' });

export function inspectExtractiveSummary(prompt: Prompt, text: string) {
  const sources = prompt[1].content
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => excerptSource.parse(JSON.parse(line)));
  const sourceBytes = sources.reduce((total, source) => total + Buffer.byteLength(source.text), 0);
  const summaryBytes = Buffer.byteLength(text);
  let attribution: string | undefined;
  let excerpts = 0;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const content = line.replace(/^(?:[-*+]\s+|#{1,6}\s+)/, '');
    const labeled = /^(?:\*\*)?(User|Agent|#[0-9]+)(?:\*\*)?(?:\s*:\s*|\s*$)(.*)$/i.exec(content);
    if (labeled) attribution = labeled[1]!.toLowerCase();
    const excerpt = (labeled ? labeled[2]! : content).trim();
    if (!excerpt) continue;
    const matched = sources.some((source) => {
      if (attribution !== source.author && attribution !== `#${source.seq}`) return false;
      const sourceSentences = [...sentences.segment(source.text)].map(({ segment }) =>
        segment.trim(),
      );
      return sourceSentences.some((_, index) => {
        let span = '';
        for (const sentence of sourceSentences.slice(index)) {
          span = span ? span + ' ' + sentence : sentence;
          if (span === excerpt) return true;
          if (!excerpt.startsWith(span)) break;
        }
        return false;
      });
    });
    if (!matched) return { sourceBytes, summaryBytes, verdict: 'invalid-excerpt' as const };
    excerpts++;
  }
  const verdict = !excerpts
    ? 'invalid-excerpt'
    : summaryBytes >= sourceBytes
      ? 'non-compressive'
      : 'accepted';
  return { sourceBytes, summaryBytes, verdict };
}

export function localMemoryPrompt(prompt: Prompt, arm: Exclude<LocalArm, 'immediate'>): Prompt {
  const [system, user] = prompt;
  const start = user.content.indexOf('Current original source messages:\n');
  if (start < 0) throw new Error('Cannot identify the current UAMP sources.');
  return [
    arm === 'local-bullets'
      ? { ...system, content: localBullets }
      : arm === 'local-extractive'
        ? { ...system, content: localExtractive }
        : system,
    {
      ...user,
      content: user.content
        .slice(start)
        .replace(
          /(\nSummarize current sources only \(#[0-9]+ to #[0-9]+\)\.) Use earlier context only to name what a current message refers to\./,
          '$1',
        ),
    },
  ];
}

export function manifestLocalFacts(fixture: MemoryFixture, local: boolean): MemoryFixture['facts'] {
  return fixture.facts.map((fact) => {
    if (fact.source === 1)
      return {
        ...fact,
        contradicts: new RegExp(
          (fact.contradicts?.source ?? '(?!)') + '|\\bcurrent `?reuseExportManifest`? rebuilds\\b',
          'i',
        ),
      };
    if (fact.source !== 5 || fact.label !== 'the later approval names the proposed implementation')
      return fact;
    return {
      ...fact,
      label: 'the user approved the earlier manifest proposal',
      expected:
        /\b(?:implement|go ahead with) (?:that|the (?:earlier|prior|preceding)) proposal\b|\b(?:approv\w*|accept\w*|agreed)[^.\n]{0,100}(?:proposal|manifest refresh)\b|\b(?:proposal|manifest refresh)\b[^.\n]{0,100}\b(?:is|was) approved\b/i,
      contradicts: new RegExp(
        (fact.contradicts?.source ?? '(?!)') +
          '|\\b(?:proposal|approval)[^.\\n]{0,36}\\b(?:awaiting|pending)\\b' +
          '|\\b(?:executes|executed|completed) the approved manifest refresh\\b' +
          (local ? '|\\breuseExportManifest\\b' : ''),
        'i',
      ),
    };
  });
}

export function localMemoryFacts(fixture: MemoryFixture, arm: LocalArm): MemoryFixture['facts'] {
  if (fixture.id === 'semantic-manifest-reference')
    return manifestLocalFacts(fixture, arm !== 'immediate');
  if (fixture.id === 'semantic-retry-correction')
    return fixture.facts.map((fact) =>
      fact.label === 'corrected delay is 45 seconds'
        ? {
            ...fact,
            contradicts: new RegExp(
              (fact.contradicts?.source ?? '(?!)') + '|\\bimplementation notes now distinguish\\b',
              'i',
            ),
          }
        : fact,
    );
  if (!fixture.id.endsWith('approval-after-skipped-discussion') || arm === 'immediate')
    return fixture.facts;
  return fixture.facts.map((fact) =>
    fact.source === 7 && fact.contextSource === 1
      ? {
          ...fact,
          identifiers: undefined,
          label: 'the user approved the earlier cache proposal',
          expected:
            /\bimplement (?:that|the (?:earlier|prior|proposal))\b|\b(?:approv\w*|accept\w*)[^.\n]{0,75}(?:proposal|restart|reuse|that)\b/i,
          contradicts:
            /\bselectWorkspaceSnapshot\b|\b(?:approval|proposal)[^.\n]{0,36}\b(?:awaiting|pending)\b/i,
        }
      : fact,
  );
}

export async function compareLocalMemory(
  fixtures: readonly MemoryFixture[],
  input: ArmInput,
  arms: readonly LocalArm[] = comparisonArms,
) {
  const results = [];
  for (const fixture of fixtures) {
    for (const arm of arms) {
      input.progress?.(`${fixture.id} ${arm}`);
      const facts = localMemoryFacts(fixture, arm);
      const hasReference =
        fixture.id === 'semantic-manifest-reference' ||
        fixture.id.endsWith('approval-after-skipped-discussion');
      const approval = fixture.id === 'semantic-manifest-reference' ? 5 : 7;
      const skippedSources = fixture.id === 'semantic-manifest-reference' ? [3, 4] : [3, 4, 5, 6];
      let handoff = '';
      const observed: {
        evidence?: {
          grade: ReturnType<typeof gradeSimplifiedLayer>;
          chronological: boolean;
          skipped: number[];
          passed: boolean;
        };
      } = {};
      const { onHandoff: observe, ...options } = input;
      const result = await runSimplifiedMemoryArm(
        {
          ...fixture,
          facts,
          focus:
            fixture.turns.at(-1)?.find(({ author }) => author === 'user')?.text ?? fixture.focus,
        },
        'deterministic-markdown',
        {
          ...options,
          transformUampPrompt:
            arm === 'immediate' ? undefined : (prompt) => localMemoryPrompt(prompt, arm),
          inspectExtract: arm === 'local-extractive' ? inspectExtractiveSummary : undefined,
          onHandoff(text, details) {
            observe?.(text, details);
            handoff = text;
            const entries = details.entries;
            const uamps = entries.filter(
              ({ author, kind }) => author === 'summary' && kind === 'UAMP',
            );
            const earlier = uamps.filter(({ seq, sources }) => (sources ?? [seq]).includes(1));
            const current = uamps.filter(({ seq, sources }) =>
              (sources ?? [seq]).includes(approval),
            );
            const grade = gradeSimplifiedLayer(
              facts,
              hasReference ? [...earlier, ...current] : uamps,
              fixture.turns.flat(),
            );
            const chronological =
              !hasReference ||
              (earlier.length > 0 &&
                current.length > 0 &&
                uamps.indexOf(earlier.at(-1)!) < uamps.indexOf(current[0]!));
            const skipped = hasReference
              ? skippedSources.filter((seq) => entries.some((entry) => entry.seq === seq))
              : [];
            observed.evidence = {
              grade,
              chronological,
              skipped,
              passed:
                chronological &&
                grade.passed &&
                (!hasReference || skipped.length === skippedSources.length) &&
                details.recoveredSources.length === 0,
            };
          },
        },
      );
      const valid =
        result.requests.length === (hasReference ? 2 : 1) &&
        result.requests.every(
          ({ cpuVerified, result }) =>
            cpuVerified &&
            result.complete &&
            result.metrics?.thinkingPresent === false &&
            (result.metrics.reasoningTokens ?? 0) === 0,
        );
      results.push({
        arm,
        ...result,
        evidence: observed.evidence,
        passed: valid && result.passed && observed.evidence?.passed === true,
        ...(input.auditOutput ? { handoff } : {}),
      });
    }
  }
  return results;
}

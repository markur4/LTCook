import type { MemoryFixture } from '../runtime/src/evals/session-memory-fixtures.js';
import { residency } from '../runtime/src/evals/session-memory.js';
import {
  ollamaEndpoint,
  releaseOllamaModel,
  type OllamaSettings,
} from '../runtime/src/integrations/ollama.js';
import { summarizeMemory } from '../runtime/src/session-memory/summarization.js';
import { gradeSimplifiedLayer, runSimplifiedMemoryArm } from './session-memory-simplified.js';

const decisionRules = `Determine each current decision from the current user messages. A direct instruction to carry out a proposal approves the referenced action. A rejection rules out that action. A deferral leaves the choice open. Earlier messages can identify the action, but their former pending or approved status does not establish its current status. Keep decisions about different actions separate. If multiple earlier actions could be meant and the current user does not distinguish them, report that the referent is unresolved. Report execution or test outcomes only when the current sources explicitly report them.`;

export function manifestApprovalControls(system: string, user: string) {
  const task = user.indexOf('\nCurrent Task scope and requirements.');
  const current = user.indexOf('\nCurrent original source messages:');
  const reference = 'Implement that proposal.';
  const currentSource = user.slice(current);
  const decisions = system.indexOf('**Decisions**\n');
  const intent = system.indexOf('**Intent**\n');
  const questions = system.indexOf('**Questions**\n');
  if (
    task <= 0 ||
    current <= task ||
    !currentSource.includes(reference) ||
    intent < 0 ||
    decisions <= intent ||
    questions <= decisions
  ) {
    throw new Error('The rendered manifest prompt no longer matches the diagnostic controls.');
  }
  return [
    { name: 'no-immediate-context', system, user: user.slice(task) },
    {
      name: 'explicit-implementation',
      system,
      user:
        user.slice(0, current) +
        currentSource.replace(reference, 'Implement reuseExportManifest for the manifest refresh.'),
    },
    { name: 'current-decision-rules', system: decisionRules + '\n\n' + system, user },
    {
      name: 'decisions-first',
      system:
        system.slice(0, intent) +
        system.slice(decisions, questions) +
        system.slice(intent, decisions) +
        system.slice(questions),
      user,
    },
  ];
}

export async function diagnoseManifestApproval(input: {
  fixture: MemoryFixture;
  settings: OllamaSettings;
  digest: string;
  weightsDigest: string;
  signal: AbortSignal;
  auditOutput?: boolean;
  progress?: (label: string) => void;
}) {
  const { fixture, digest, signal, auditOutput, progress } = input;
  const settings = { ...input.settings, cpuOnly: true };
  const endpoint = ollamaEndpoint(settings.endpoint);
  const originals = fixture.turns.flat();
  const approvalFacts = fixture.facts.filter(({ source }) => source === 5);
  const grade = (summary: string) =>
    gradeSimplifiedLayer(approvalFacts, [{ seq: 6, sources: [5, 6], text: summary }], originals);
  progress?.('Generate the original manifest proposal and approval.');
  const baseline = await runSimplifiedMemoryArm(fixture, 'deterministic-markdown', {
    settings,
    digest,
    signal,
    auditOutput: true,
    screening: { weightsDigest: input.weightsDigest },
  });
  const [proposal, approval, extra] = baseline.requests;
  const coldRequest = () => AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const usable = (result: (typeof baseline.requests)[number]) =>
    result.cpuVerified &&
    result.result.complete &&
    result.result.metrics?.thinkingPresent === false &&
    (result.result.metrics.reasoningTokens ?? 0) === 0;
  if (!proposal?.audit || !approval?.audit || extra || !usable(proposal) || !usable(approval))
    throw new Error('The manifest diagnostic requires two complete CPU baseline requests.');

  const cases = [];
  for (const { name, system, user } of manifestApprovalControls(
    approval.audit.systemPrompt,
    approval.audit.prompt,
  )) {
    progress?.(name);
    await releaseOllamaModel(settings, signal);
    const result = await summarizeMemory(
      settings,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      coldRequest(),
      'UAMP',
      true,
      () => {},
      'markdown',
    );
    const loaded = await residency(endpoint, digest, signal);
    if (
      !loaded?.bytes ||
      loaded.gpuBytes !== 0 ||
      !result.complete ||
      result.metrics?.thinkingPresent !== false ||
      (result.metrics.reasoningTokens ?? 0) !== 0
    )
      throw new Error('The manifest diagnostic requires complete CPU inference without reasoning.');
    cases.push({
      name,
      quality: grade(result.text),
      usage: result.usage,
      inferenceMs: result.elapsedMs,
      ...(auditOutput ? { system, user, reply: result.text } : {}),
    });
  }

  const visibleRequest = ({ audit, ...request }: (typeof baseline.requests)[number]) =>
    auditOutput ? { ...request, audit } : request;
  return {
    baseline: {
      quality: grade(approval.audit.summary),
      fixtureQuality: baseline.quality.summarization,
      proposal: visibleRequest(proposal),
      approval: visibleRequest(approval),
    },
    cases,
  };
}

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ollamaEndpoint,
  releaseOllamaModel,
  type OllamaSettings,
} from '../runtime/src/integrations/ollama.js';
import {
  inspectEvaluationModel,
  listEvaluationModels,
  modelTag,
  type ModelIdentity,
} from '../runtime/src/evals/summarization-grader.js';
import {
  sessionMemoryGeneration,
  sessionMemoryModel,
} from '../runtime/src/session-memory/summarization.js';
import { semanticMemoryFixtures } from './session-memory-semantic-fixtures.js';
import { diagnoseManifestApproval } from './session-memory-approval.js';
import { compareLocalMemory, localMemoryArms } from './session-memory-local.js';
import {
  referenceFixture,
  realisticReferenceFixture,
  runSimplifiedMemoryArm,
  simplifiedSeed,
} from './session-memory-simplified.js';

const frozenRevision = 'e7f1d601d1382586b903e757281c165ffffc396d';
const chronologicalHandoffRevision = 'bbc9a3f3a2e79afe70819d59949b49286101e16e';
const mnnProfileId = 'mnn-pocket';
const mnnSampling = { temperature: 0.8, top_k: 20, top_p: 0.8, repeat_penalty: 1 };
const mnnQatProfile = {
  id: 'mnn-pocket-q4-1',
  name: 'MNN-Pocket-0.3B Q4_1 QAT',
  model: 'hf.co/taobao-mnn/MNN-Pocket-0.3B-GGUF:Q4_1',
  weights: 'a281c127e388b16537fd3f5d31ab32d3f87739e6dc514ac1093c80d9eac8d097',
  ...mnnSampling,
};
const liquid = { temperature: 0.4, top_k: 50, top_p: 1, repeat_penalty: 1.05 };
const profiles = [
  {
    id: 'lfm25-12b-qad',
    name: 'LFM2.5-1.2B-Instruct QAD Q4_0',
    model: 'hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:LFM2.5-1.2B-Instruct-QAD-Q4_0.gguf',
    weights: 'bb741ebb106d543e9de114b843a3d3d73d51c74b5801e69da2abde821a0cb3e1',
    ...liquid,
  },
  {
    id: 'lfm25-350m-q8',
    name: 'LFM2.5-350M Q8_0',
    model: 'LiquidAI/lfm2.5-350m:q8_0',
    weights: 'be036a757295e550098b85e13f6af2735d0fa73b41e1156a40c7d8e8e32a5766',
    ...liquid,
  },
  {
    id: mnnProfileId,
    name: 'MNN-Pocket-0.3B Q8_0',
    model: 'hf.co/taobao-mnn/MNN-Pocket-0.3B-GGUF:Q8_0',
    weights: '31eb5db92b2e02a80e9e3a9316aa83120cbee98e4f4a22ca19015ba601dbd690',
    ...mnnSampling,
  },
  {
    id: 'lfm25-350m-qad',
    name: 'LFM2.5-350M QAD Q4_0',
    model: 'hf.co/LiquidAI/LFM2.5-350M-GGUF:LFM2.5-350M-QAD-Q4_0.gguf',
    weights: '3d10b6ab8fc91a919534b9558e266255aca0bbc7f6d015963599aa9e74e05b1d',
    ...liquid,
  },
];

const modelDefinition = z.object({
  template: z.string().min(1),
  parameters: z.string(),
  modelfile: z.string(),
});

function parameterLines(parameters: string, overrides: Record<string, number>) {
  return parameters
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !(line.split(/\s+/, 1)[0]! in overrides))
    .sort();
}

function nativeDirectives(modelfile: string) {
  return modelfile.split('\n').filter((line) => /^(?:RENDERER|PARSER|SYSTEM|MESSAGE)\b/.test(line));
}

export function candidateScreeningFixtures() {
  return [...semanticMemoryFixtures, referenceFixture()].map((fixture) => ({
    ...fixture,
    facts: fixture.facts.map((fact) => {
      if (fact.label === 'retain three attempts')
        return {
          ...fact,
          expected:
            /\b(?:3|three)(?: retry| total| maximum)? attempts\b|\b(?:maximum|limit (?:on|of)) (?:retry )?attempts (?:remain at|stay at|is|are|:)?\s*(?:3|three)\b/i,
        };
      if (fact.label === 'the later approval names the proposed implementation')
        return {
          ...fact,
          contradicts: new RegExp(
            (fact.contradicts?.source ?? '(?!)') +
              "|\\b(?:is|remains) (?:a |an |the )?(?:open )?proposal (?:still )?(?:awaiting|pending) (?:your|the user[’']s) (?:approval|decision)" +
              '|\\bapproval (?:is (?:still )?pending|remains pending)\\b',
            'i',
          ),
        };
      return fact;
    }),
  }));
}

export async function screenSessionMemory(input: {
  settings: OllamaSettings;
  signal: AbortSignal;
  auditOutput?: boolean;
  profileId?: string;
  approvalDiagnostic?: 'controls' | 'minimal';
  localComparison?: boolean;
  qualifyMnnLocal?: boolean;
  extractive?: boolean;
  workStatus?: boolean;
  proportionalOutputCap?: boolean;
  localValidation?: readonly (typeof localMemoryArms)[number][];
  mnnApprovalFirst?: boolean;
  allowRetry?: boolean;
  progress?: (label: string) => void;
}) {
  if (
    input.qualifyMnnLocal &&
    (input.profileId ||
      input.approvalDiagnostic ||
      input.localComparison ||
      input.localValidation ||
      input.mnnApprovalFirst)
  )
    throw new Error('--qualify-mnn-local cannot be combined with other model or screening modes.');
  if ([input.extractive, input.workStatus, input.proportionalOutputCap].filter(Boolean).length > 1)
    throw new Error('Choose one MNN-Pocket qualification experiment at a time.');
  const revision = input.qualifyMnnLocal ? chronologicalHandoffRevision : frozenRevision;
  const frozen = Bun.spawnSync(
    [
      'git',
      'diff',
      '--quiet',
      revision,
      '--',
      'runtime/src/session-memory',
      'runtime/src/integrations/ollama.ts',
      'runtime/src/evals',
      'bun.lock',
      'evals/session-memory-context.ts',
      'evals/session-memory-semantic-fixtures.ts',
    ],
    { cwd: new URL('..', import.meta.url).pathname },
  );
  if (frozen.exitCode !== 0)
    throw new Error('Screening requires the requested pinned production code and fixtures.');
  if (input.mnnApprovalFirst && input.profileId && input.profileId !== mnnProfileId)
    throw new Error('--mnn-approval-first selects the MNN-Pocket Q8_0 experiment.');
  if (input.approvalDiagnostic && (input.profileId || input.mnnApprovalFirst))
    throw new Error('The approval diagnostic selects its own MNN-Pocket profiles at 0.8.');
  if (
    input.localComparison &&
    (input.profileId || input.mnnApprovalFirst || input.approvalDiagnostic)
  )
    throw new Error('The local memory comparison selects its own model profiles.');
  const qatScreen = input.profileId === mnnQatProfile.id;
  const approvalFirst = input.mnnApprovalFirst || qatScreen;
  const { signal, auditOutput, progress } = input;
  const endpoint = ollamaEndpoint(input.settings.endpoint);
  const api = async (route: string, body: object, method = 'POST', requestSignal = signal) => {
    const response = await fetch(new URL('/api/' + route, endpoint), {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(20_000)]),
      redirect: 'error',
    });
    if (method === 'DELETE' && response.status === 404) {
      await response.body?.cancel();
      return;
    }
    if (!response.ok) throw new Error(`Ollama ${route} failed (HTTP ${response.status}).`);
    return (await response.json()) as unknown;
  };
  const runWithCleanup = async <T>(work: () => Promise<T>, cleanup: () => Promise<void>) => {
    let result: T;
    try {
      result = await work();
    } catch (error) {
      await cleanup().catch((cleanupError: unknown) => {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        progress?.(`Ollama cleanup also failed: ${message}`);
      });
      throw error;
    }
    await cleanup();
    return result;
  };
  const inventory = () => listEvaluationModels(input.settings.endpoint, signal);
  const find = (models: readonly ModelIdentity[], name: string) =>
    models.find((entry) => modelTag(entry.name) === modelTag(name));
  const models = await inventory();
  const fixtures = candidateScreeningFixtures();
  const expected = [4, 3, 4, 5];
  const order = approvalFirst ? [2, 0, 1, 3] : [0, 1, 2, 3];
  const run = async (settings: OllamaSettings, model: ModelIdentity, label: string) => {
    if (!model.weightsDigest) throw new Error('Could not verify the Ollama model weights.');
    const stages = [];
    let nearPass = false;
    for (const index of order) {
      const fixture = fixtures[index]!;
      progress?.(`${label}: ${fixture.id}`);
      const result = await runSimplifiedMemoryArm(fixture, 'deterministic-markdown', {
        settings,
        digest: model.digest,
        signal,
        auditOutput,
        screening: { weightsDigest: model.weightsDigest },
      });
      const quality = result.quality.summarization;
      const valid =
        result.requests.length > 0 &&
        result.requests.every(
          ({ cpuVerified, result }) =>
            cpuVerified &&
            result.complete &&
            result.metrics?.thinkingPresent === false &&
            (result.metrics.reasoningTokens ?? 0) === 0,
        );
      const contradicted =
        quality.contradictions.length > 0 ||
        quality.facts.some((fact) => fact.critical && fact.contradicted);
      const passed = valid && quality.required === expected[index] && quality.passed;
      stages.push({
        fixture: fixture.id,
        quality,
        valid,
        passed,
        requests: result.requests,
        measurements: result.measurements,
      });
      progress?.(
        `${label}: ${quality.retained}/${expected[index]}${passed ? ' passed' : ' stopped'}`,
      );
      if (!passed) {
        nearPass =
          valid &&
          !contradicted &&
          quality.required === expected[index] &&
          quality.required - quality.retained === 1;
        break;
      }
    }
    return {
      stages,
      qualified: stages.length === fixtures.length && stages.every(({ passed }) => passed),
      nearPass,
    };
  };
  const results = [];
  const diagnostics: (Awaited<ReturnType<typeof diagnoseManifestApproval>> & {
    profile: (typeof profiles)[number];
    generation: typeof sessionMemoryGeneration;
  })[] = [];
  const localFixtures = input.localValidation
    ? fixtures.filter(({ id }) => id !== 'semantic-manifest-reference')
    : fixtures.filter(({ id }) => id === 'semantic-manifest-reference');
  const localResults: {
    model: ModelIdentity;
    arms: Awaited<ReturnType<typeof compareLocalMemory>>;
  }[] = [];
  const profileId = input.mnnApprovalFirst ? mnnProfileId : input.profileId;
  const selectedProfiles =
    input.approvalDiagnostic === 'controls'
      ? [...profiles.filter(({ id }) => id === mnnProfileId), mnnQatProfile]
      : input.approvalDiagnostic === 'minimal' || input.localComparison || input.qualifyMnnLocal
        ? profiles.filter(({ id }) => id === mnnProfileId)
        : qatScreen
          ? [mnnQatProfile]
          : profiles.filter(({ id }) => !profileId || id === profileId);
  if (!selectedProfiles.length) throw new Error('Unknown Session Memory screening profile.');
  for (const profile of selectedProfiles) {
    const source = find(models, profile.model);
    if (!source) throw new Error(`Install the requested Ollama model: ${profile.model}`);
    const verified = await inspectEvaluationModel(input.settings.endpoint, source, signal);
    if (verified.weightsDigest !== profile.weights)
      throw new Error(`The weights differ from the published checkpoint for ${profile.name}.`);
    const native = modelDefinition.parse(await api('show', { model: source.name }));
    const alias = 'ltcook-memory-screen-' + randomUUID();
    const parameters = { top_p: profile.top_p, presence_penalty: 0, min_p: 0 };
    let created = false;
    const attempts = await runWithCleanup(
      async () => {
        await api('create', { model: alias, from: source.name, parameters, stream: false });
        created = true;
        const aliasModel = find(await inventory(), alias);
        if (!aliasModel) throw new Error('Cannot find the isolated sampling profile.');
        const model = await inspectEvaluationModel(input.settings.endpoint, aliasModel, signal);
        const actual = modelDefinition.parse(await api('show', { model: alias }));
        if (
          model.weightsDigest !== profile.weights ||
          actual.template !== native.template ||
          JSON.stringify(nativeDirectives(actual.modelfile)) !==
            JSON.stringify(nativeDirectives(native.modelfile)) ||
          JSON.stringify(parameterLines(actual.parameters, parameters)) !==
            JSON.stringify(parameterLines(native.parameters, parameters)) ||
          Object.entries(parameters).some(
            ([key, value]) =>
              !actual.parameters.split('\n').some((line) => {
                const [name, setting] = line.trim().split(/\s+/);
                return name === key && Number(setting) === value;
              }),
          )
        )
          throw new Error(`Ollama did not preserve the native definition for ${profile.name}.`);
        const attempts = [];
        const firstTemperature = input.mnnApprovalFirst ? 0.6 : profile.temperature;
        const temperatures = approvalFirst ? [firstTemperature] : [firstTemperature, 0.1];
        for (const temperature of temperatures) {
          const generation = {
            ...sessionMemoryGeneration,
            options: {
              ...sessionMemoryGeneration.options,
              seed: simplifiedSeed,
              temperature,
              top_k: profile.top_k,
              repeat_penalty: profile.repeat_penalty,
            },
          };
          const settings = {
            ...input.settings,
            model: model.name,
            keepAlive: 900,
            generation: JSON.stringify(generation),
          };
          if (input.approvalDiagnostic) {
            if (!model.weightsDigest) throw new Error('The diagnostic requires verified weights.');
            const fixture = fixtures.find(({ id }) => id === 'semantic-manifest-reference')!;
            const diagnostic = await diagnoseManifestApproval({
              fixture,
              settings,
              digest: model.digest,
              weightsDigest: model.weightsDigest,
              signal,
              minimal: input.approvalDiagnostic === 'minimal',
              auditOutput,
              progress: (label) => progress?.(`${profile.name}: ${label}`),
            });
            diagnostics.push({ profile, generation, ...diagnostic });
            break;
          }
          if (input.localComparison) {
            if (!model.weightsDigest) throw new Error('The comparison requires verified weights.');
            const arms = await compareLocalMemory(
              localFixtures,
              {
                settings,
                digest: model.digest,
                signal,
                auditOutput,
                screening: { weightsDigest: model.weightsDigest },
                progress: (label) => progress?.(`${profile.name}: ${label}`),
              },
              input.localValidation,
            );
            localResults.push({ model: verified, arms });
            break;
          }
          if (input.qualifyMnnLocal) {
            if (!model.weightsDigest)
              throw new Error('The qualification requires verified weights.');
            const options = {
              settings,
              digest: model.digest,
              signal,
              auditOutput,
              inspectIncompleteFallback: true,
              screening: { weightsDigest: model.weightsDigest },
              progress: (label: string) => progress?.(`${profile.name}: ${label}`),
            };
            if (input.proportionalOutputCap) {
              const arms = await compareLocalMemory(
                [realisticReferenceFixture()],
                { ...options, proportionalOutputCap: true },
                ['local-bullets'],
              );
              localResults.push({ model: verified, arms });
              break;
            }
            if (input.extractive || input.workStatus) {
              const arm = input.workStatus ? 'local-work-status' : 'local-extractive';
              const retry = fixtures.find(({ id }) => id === 'semantic-retry-correction')!;
              const first = await compareLocalMemory([retry], options, [arm]);
              const arms = first[0]?.passed
                ? [
                    ...first,
                    ...(await compareLocalMemory(
                      [
                        realisticReferenceFixture(),
                        ...fixtures.filter(
                          ({ id }) => id !== retry.id && id !== 'approval-after-skipped-discussion',
                        ),
                      ],
                      options,
                      [arm],
                    )),
                  ]
                : first;
              localResults.push({ model: verified, arms });
              break;
            }
            const arms = await compareLocalMemory(
              [
                realisticReferenceFixture(),
                ...fixtures.filter(({ id }) => id !== 'approval-after-skipped-discussion'),
              ],
              options,
              ['local-template', 'local-bullets'],
            );
            localResults.push({ model: verified, arms });
            break;
          }
          const result = await run(settings, model, `${profile.name} T=${temperature}`);
          attempts.push({ generation, ...result });
          if (input.allowRetry === false || !result.nearPass || temperature === 0.1) break;
        }
        return attempts;
      },
      async () => {
        const cleanup = AbortSignal.timeout(25_000);
        try {
          if (created) await releaseOllamaModel({ ...input.settings, model: alias }, cleanup);
        } finally {
          // > Ollama may create the alias before a client receives the response.
          await api('delete', { model: alias }, 'DELETE', cleanup);
        }
      },
    );
    results.push({ profile, identity: verified, parameters, attempts });
  }
  const qualifiers = results.flatMap(({ profile, attempts }) =>
    attempts.filter(({ qualified }) => qualified).map((attempt) => ({ profile, attempt })),
  );
  let comparison;
  if ((qualifiers.length && !qatScreen) || input.localComparison) {
    const source = find(models, sessionMemoryModel);
    if (!source) throw new Error('The pinned LFM3 baseline is missing.');
    const model = await inspectEvaluationModel(input.settings.endpoint, source, signal);
    const settings = {
      ...input.settings,
      model: model.name,
      keepAlive: 900,
      generation: JSON.stringify({
        ...sessionMemoryGeneration,
        options: { ...sessionMemoryGeneration.options, seed: simplifiedSeed },
      }),
    };
    if (input.localComparison) {
      if (!model.weightsDigest) throw new Error('The comparison requires verified weights.');
      const arms = await runWithCleanup(
        () =>
          compareLocalMemory(
            localFixtures,
            {
              settings,
              digest: model.digest,
              signal,
              auditOutput,
              screening: { weightsDigest: model.weightsDigest! },
              progress: (label) => progress?.(`LFM3: ${label}`),
            },
            input.localValidation,
          ),
        () => releaseOllamaModel(settings, AbortSignal.timeout(10_000)),
      );
      localResults.push({ model, arms });
    } else {
      const baseline = await runWithCleanup(
        () => run(settings, model, 'LFM3 baseline'),
        () => releaseOllamaModel(settings, AbortSignal.timeout(10_000)),
      );
      const wallMs = (profile: typeof baseline) =>
        profile.stages.reduce((sum, stage) => sum + stage.measurements.isolatedCpuWallMs, 0);
      comparison = {
        model,
        baseline,
        candidates: qualifiers.map(({ profile, attempt }) => ({
          name: profile.name,
          temperature: attempt.generation.options.temperature,
          reduction: baseline.qualified ? 1 - wallMs(attempt) / wallMs(baseline) : null,
        })),
      };
    }
  }
  const after = await inventory();
  const unchanged =
    results.every(({ identity }) => find(after, identity.name)?.digest === identity.digest) &&
    localResults.every(({ model }) => find(after, model.name)?.digest === model.digest) &&
    (!comparison || find(after, comparison.model.name)?.digest === comparison.model.digest);
  if (!unchanged) throw new Error('A model identity changed during screening.');
  return {
    frozenRevision: revision,
    seed: simplifiedSeed,
    results,
    comparison,
    ...(input.approvalDiagnostic ? { diagnostics } : {}),
    ...(input.localComparison || input.qualifyMnnLocal ? { localResults } : {}),
    productionSuspended: true,
  };
}

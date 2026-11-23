import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import {
  summaryGeneration,
  type OllamaSettings,
  type OllamaUsage,
  type SummaryGeneration,
} from '../integrations/ollama.js';
import {
  createSummarizeTool,
  SUMMARY_INSTRUCTIONS,
  summaryInputLimit,
} from '../tools/summarize.js';
import type { SummarizationQualification } from './contracts.js';
import { sanitizeEvaluationText } from './diagnostics.js';
import {
  DECISION_INSTRUCTIONS,
  DECISION_MAX_TOKENS,
  decideFromSummary,
} from './summarization-decision.js';
import {
  CORE_SUMMARIZATION_CASES,
  DOWNSTREAM_CASES,
  FILE_SUMMARIZATION_CASE,
  fullSummarizationCases,
  NEAR_LIMIT_FOCUS,
  REPEAT_SUMMARIZATION_CASES,
  SUMMARIZATION_CALIBRATION,
  type SummarizationCase,
} from './summarization-fixtures.js';
import {
  calibrationMatches,
  GRADER_INSTRUCTIONS,
  GRADER_KEEP_ALIVE,
  GRADER_OPTIONS,
  gradeSummary,
  gradingModelsIndependent,
  inspectEvaluationModel,
  listEvaluationModels,
  modelTag,
  type ModelIdentity,
  type SummaryGrade,
} from './summarization-grader.js';
import { EVAL_MODEL, hash } from './setup.js';

type Attempt = {
  id: string;
  attempt: number;
  input: 'inline' | 'file';
  focus?: string;
  requiredFacts: SummarizationCase['facts'];
  summary?: string;
  sourceCharacters: number;
  inputBytes: number;
  elapsedMs?: number;
  usage?: OllamaUsage;
  incomplete?: boolean;
  missingExact: Array<{ fact: string; values: string[]; sourceQuote: string }>;
  grading?: Awaited<ReturnType<typeof gradeSummary>>;
  verdict: SummarizationQualification;
  reason?: string;
};

type Calibration = {
  id: string;
  set: 'development' | 'held-out';
  expected: (typeof SUMMARIZATION_CALIBRATION)[number]['expected'];
  expectedUnsupported: boolean;
  verdict: SummarizationQualification;
  grading?: Awaited<ReturnType<typeof gradeSummary>>;
  reason?: string;
};

type Decision = {
  id: string;
  expected: 'HOLD' | 'PROCEED';
  verdict: SummarizationQualification;
  attribution?: 'summary' | 'agent' | 'unresolved';
  candidate?: Awaited<ReturnType<typeof decideFromSummary>>;
  control?: Awaited<ReturnType<typeof decideFromSummary>>;
  reason?: string;
};

export type SummarizationReport = {
  scope: 'core' | 'full';
  verdict: SummarizationQualification;
  complete: boolean;
  fixtureSha256: string;
  code?: { kind: 'bundle' | 'source'; sha256: string };
  settings: {
    summarizer: {
      requestedModel?: string;
      promptSha256: string;
      inputBytes?: number;
      generation?: SummaryGeneration;
      keepAlive?: number;
    };
    grader: {
      requestedModel: string;
      promptSha256: string;
      generation: typeof GRADER_OPTIONS;
      keepAlive: number;
    };
    decision?: { promptSha256: string; maxTokens: number; thinking: 'off'; temperature: 0 };
  };
  summarizer?: ModelIdentity;
  grader?: ModelIdentity;
  calibration: Calibration[];
  attempts: Attempt[];
  downstream?: { verdict: SummarizationQualification; cases: Decision[] };
  blockers: string[];
  elapsedMs: number;
};

export function qualificationVerdict(
  verdicts: SummarizationQualification[],
): SummarizationQualification {
  if (verdicts.includes('failed')) return 'failed';
  return verdicts.length && verdicts.every((verdict) => verdict === 'passed')
    ? 'passed'
    : 'blocked';
}

export function missingExactFacts(
  fixture: SummarizationCase,
  summary: string,
): Attempt['missingExact'] {
  return fixture.facts.flatMap(({ id, exact = [], sourceQuote }) => {
    const values = exact.filter((value) => {
      const escaped = value.replace(/[.*+?^$${}()|[\]\\]/g, '\\$&');
      const pattern = '(?<![\\p{L}\\p{N}_])' + escaped + '(?![\\p{L}\\p{N}_]|[./-][\\p{L}\\p{N}_])';
      return !new RegExp(pattern, 'u').test(summary);
    });
    return values.length ? [{ fact: id, values, sourceQuote }] : [];
  });
}

function semanticVerdict(grade: SummaryGrade): SummarizationQualification {
  if (
    grade.facts.some(({ verdict }) => verdict === 'missing' || verdict === 'contradicted') ||
    grade.claims.some(({ verdict }) => verdict === 'unsupported' || verdict === 'contradicted')
  )
    return 'failed';
  if ([...grade.facts, ...grade.claims].some(({ verdict }) => verdict === 'uncertain'))
    return 'blocked';
  return 'passed';
}

function generationFailure(result: Attempt): string | undefined {
  if (result.incomplete) return 'Generation did not complete.';
  if (result.missingExact.length) return 'Required exact values are missing.';
}

const errorReason = (error: unknown) =>
  sanitizeEvaluationText(
    error instanceof Error ? error.message : 'Local inference did not complete.',
  ).slice(0, 300);

export function captureSummarizationCode(): SummarizationReport['code'] {
  const module = new URL(import.meta.url);
  try {
    if (!module.pathname.endsWith('.ts'))
      return { kind: 'bundle', sha256: hash(readFileSync(module)) };

    const sources = [
      './summarization.ts',
      './summarization-fixtures.ts',
      './summarization-grader.ts',
      './summarization-decision.ts',
      './engine.ts',
      './contracts.ts',
      './service.ts',
      './setup.ts',
      '../tools/summarize.ts',
      '../integrations/ollama.ts',
      '../../../bun.lock',
    ];
    const digests = sources.map((source) => [source, hash(readFileSync(new URL(source, module)))]);
    return { kind: 'source', sha256: hash(JSON.stringify(digests)) };
  } catch {
    return undefined;
  }
}

export async function evaluateSummarization(input: {
  settings?: OllamaSettings;
  scope: 'core' | 'full';
  directory: string;
  signal: AbortSignal;
  code: SummarizationReport['code'];
  onProgress?(report: SummarizationReport, current?: string): Promise<void>;
}): Promise<SummarizationReport> {
  const { settings, scope, directory, signal, code, onProgress } = input;
  const full = scope === 'full';
  const started = performance.now();
  let generation: SummaryGeneration | undefined;
  let configurationError: string | undefined;
  if (settings) {
    try {
      generation = { ...summaryGeneration(settings), stream: false };
    } catch (error) {
      configurationError = errorReason(error);
    }
  }
  const fullCases =
    full && generation
      ? fullSummarizationCases(summaryInputLimit(generation, NEAR_LIMIT_FOCUS))
      : [];
  const report: SummarizationReport = {
    scope,
    verdict: 'blocked',
    complete: false,
    code,
    fixtureSha256: hash(
      JSON.stringify({
        core: CORE_SUMMARIZATION_CASES,
        full: fullCases,
        repeat: [...REPEAT_SUMMARIZATION_CASES],
        file: FILE_SUMMARIZATION_CASE.id,
        downstream: DOWNSTREAM_CASES,
        calibration: SUMMARIZATION_CALIBRATION,
      }),
    ),
    settings: {
      summarizer: {
        requestedModel: settings?.model,
        promptSha256: hash(SUMMARY_INSTRUCTIONS),
        inputBytes: generation ? summaryInputLimit(generation) : undefined,
        generation,
        keepAlive: settings?.keepAlive,
      },
      grader: {
        requestedModel: EVAL_MODEL,
        promptSha256: hash(GRADER_INSTRUCTIONS),
        generation: GRADER_OPTIONS,
        keepAlive: GRADER_KEEP_ALIVE,
      },
      ...(full
        ? {
            decision: {
              promptSha256: hash(DECISION_INSTRUCTIONS),
              maxTokens: DECISION_MAX_TOKENS,
              temperature: 0,
              thinking: 'off',
            },
          }
        : {}),
    },
    calibration: [],
    attempts: [],
    blockers: code ? [] : ['Evaluation code could not be fingerprinted at startup.'],
    elapsedMs: 0,
  };
  const update = async (current?: string) => {
    if (report.downstream) {
      const decisions = report.downstream.cases.map(({ verdict }) => verdict);
      report.downstream.verdict = qualificationVerdict([
        ...decisions,
        ...(decisions.length < DOWNSTREAM_CASES.length ? ['blocked' as const] : []),
      ]);
    }
    const outcomes = [
      ...report.attempts.map(({ verdict }) => verdict),
      ...(report.downstream ? [report.downstream.verdict] : []),
    ];
    if (report.blockers.length || !report.complete) outcomes.push('blocked');
    report.verdict = qualificationVerdict(outcomes);
    report.elapsedMs = performance.now() - started;
    await onProgress?.(report, current);
  };
  if (!settings || !generation) {
    report.blockers.push(
      configurationError ?? 'The runtime did not supply AppRC summarizer settings.',
    );
    report.complete = true;
    await update();
    return report;
  }
  const { endpoint } = settings;
  const list = () => listEvaluationModels(endpoint, signal);
  try {
    const inventory = await list();
    const inspect = (name: string) => {
      const model = inventory.find(({ name: installed }) => modelTag(name) === modelTag(installed));
      return model ? inspectEvaluationModel(endpoint, model, signal) : undefined;
    };
    const [summarizer, grader] = await Promise.allSettled([
      inspect(settings.model),
      inspect(EVAL_MODEL),
    ]);
    signal.throwIfAborted();
    if (summarizer.status === 'fulfilled') report.summarizer = summarizer.value;
    if (grader.status === 'fulfilled') report.grader = grader.value;
    if (!report.summarizer) report.blockers.push('The summarizer identity could not be resolved.');
    if (!report.grader) report.blockers.push('The Bonsai grader identity could not be resolved.');
  } catch {
    signal.throwIfAborted();
    report.blockers.push('Ollama model identities could not be resolved.');
  }
  const grader = report.grader;
  const summarizer = report.summarizer;
  const independent = Boolean(grader && summarizer && gradingModelsIndependent(summarizer, grader));
  if (grader && summarizer && !independent)
    report.blockers.push('The grader and summarizer weights could not be verified as independent.');

  const fixtures = full
    ? [...CORE_SUMMARIZATION_CASES, ...fullCases, ...DOWNSTREAM_CASES.map(({ fixture }) => fixture)]
    : CORE_SUMMARIZATION_CASES;
  const cases = fixtures.flatMap((fixture) =>
    Array.from(
      { length: full && REPEAT_SUMMARIZATION_CASES.has(fixture.id) ? 3 : 1 },
      (_, index) => ({
        fixture,
        attempt: index + 1,
        input: 'inline' as Attempt['input'],
      }),
    ),
  );
  await mkdir(directory, { recursive: true });
  if (full) {
    cases.push({ fixture: FILE_SUMMARIZATION_CASE, attempt: 1, input: 'file' });
    await writeFile(path.join(directory, 'fixture-notes.txt'), FILE_SUMMARIZATION_CASE.source);
  }
  let usage: OllamaUsage | undefined;
  const tool = createSummarizeTool(settings, (value) => {
    usage = value;
  });
  const generated: Array<{ fixture: SummarizationCase; result: Attempt }> = [];

  for (const job of cases) {
    const { fixture, attempt, input: kind } = job;
    signal.throwIfAborted();
    await update(fixture.id);
    const result: Attempt = {
      id: fixture.id,
      attempt,
      input: kind,
      focus: fixture.focus,
      sourceCharacters: fixture.source.length,
      inputBytes: Buffer.byteLength(fixture.source, 'utf8'),
      requiredFacts: fixture.facts,
      verdict: 'blocked',
      missingExact: [],
    };
    report.attempts.push(result);
    const begin = performance.now();
    usage = undefined;
    try {
      const summary = await tool.execute(
        kind === 'file'
          ? { path: 'fixture-notes.txt', focus: fixture.focus }
          : { text: fixture.source, focus: fixture.focus },
        {
          agentId: 'summarization-evaluation',
          workspaceRoot: directory,
          workspaceFileAccess: kind === 'file',
          signal,
        },
      );
      result.summary = summary.summary;
      result.incomplete = summary.incomplete;
      result.usage = usage;
      if (modelTag(summary.model) !== modelTag(summarizer?.name ?? settings.model)) {
        result.reason = 'The returned summarizer identity did not match.';
      } else {
        result.missingExact = missingExactFacts(fixture, summary.summary);
        const failure = generationFailure(result);
        if (failure) {
          result.verdict = 'failed';
          result.reason = failure;
        }
        generated.push({ fixture, result });
      }
    } catch (error) {
      signal.throwIfAborted();
      result.reason = errorReason(error);
    }
    result.elapsedMs = performance.now() - begin;
    await update();
  }

  let calibrated = false;
  if (independent && grader) {
    for (const example of SUMMARIZATION_CALIBRATION) {
      signal.throwIfAborted();
      await update('Calibrating Bonsai · ' + example.id);
      const result: Calibration = {
        id: example.id,
        set: example.set,
        expected: example.expected,
        expectedUnsupported: example.expectedClaim?.verdict === 'unsupported',
        verdict: 'blocked',
      };
      try {
        result.grading = await gradeSummary({
          endpoint,
          model: grader,
          fixture: example.document,
          summary: example.summary,
          signal,
        });
        result.verdict = calibrationMatches(result.grading.grade, example) ? 'passed' : 'failed';
        if (result.verdict === 'failed')
          result.reason = 'Grade disagrees with the reviewed fixture label.';
      } catch (error) {
        signal.throwIfAborted();
        result.reason = errorReason(error);
      }
      report.calibration.push(result);
      await update();
    }
    calibrated = report.calibration.every(({ verdict }) => verdict === 'passed');
    if (!calibrated) report.blockers.push('Bonsai did not pass all grader calibration examples.');
  }

  for (const { fixture, result } of generated) {
    signal.throwIfAborted();
    if (calibrated && grader) {
      await update('Grading · ' + fixture.id);
      try {
        result.grading = await gradeSummary({
          endpoint,
          model: grader,
          fixture,
          summary: result.summary!,
          signal,
        });
        result.verdict =
          result.verdict === 'failed' ? 'failed' : semanticVerdict(result.grading.grade);
        if (result.verdict === 'blocked')
          result.reason = 'A critical semantic grade is unresolved.';
      } catch (error) {
        signal.throwIfAborted();
        result.reason ??= errorReason(error);
      }
    } else {
      result.reason ??= 'Independent calibrated grading was unavailable.';
    }
    await update();
  }

  if (full) {
    const decisions: Decision[] = [];
    report.downstream = { verdict: 'blocked', cases: decisions };
    for (const { fixture, expected, control: controlSummary } of DOWNSTREAM_CASES) {
      const source = generated.find((item) => item.fixture === fixture)?.result;
      const downstream: Decision = {
        id: fixture.id,
        expected,
        verdict: 'blocked',
        attribution: 'unresolved',
      };
      decisions.push(downstream);
      if (source?.summary && grader) {
        const decide = (summary: string, name: string) =>
          decideFromSummary({
            endpoint,
            model: grader.name,
            directory: path.join(directory, fixture.id, name),
            summary,
            signal,
          });
        try {
          await update('Behavior Evaluation · ' + fixture.id);
          downstream.candidate = await decide(source.summary, 'candidate');
          if (downstream.candidate.decision === expected && !downstream.candidate.incomplete) {
            downstream.verdict = 'passed';
            delete downstream.attribution;
          } else {
            downstream.verdict = 'failed';
            downstream.reason = downstream.candidate.incomplete
              ? 'The native Pi candidate response did not complete.'
              : `The native Pi agent did not return the required ${expected} decision.`;
            try {
              const control = await decide(controlSummary, 'control');
              downstream.control = control;
              if (control.incomplete) {
                downstream.reason += ' The correct-summary control did not complete.';
              } else if (
                control.decision === expected &&
                source.grading?.grade.facts.some(
                  ({ id, verdict }) =>
                    id === 'decision' && (verdict === 'missing' || verdict === 'contradicted'),
                )
              ) {
                downstream.attribution = 'summary';
              } else if (control.decision !== expected && source.verdict === 'passed') {
                downstream.attribution = 'agent';
              }
            } catch (error) {
              signal.throwIfAborted();
              downstream.reason += ' Control could not run: ' + errorReason(error);
            }
          }
        } catch (error) {
          signal.throwIfAborted();
          downstream.reason = errorReason(error);
        }
      } else
        downstream.reason = 'The fixed-fixture summary or local decision model was unavailable.';
      await update();
    }
  }

  if (summarizer || grader) {
    try {
      const inventory = await list();
      const changed = (model: ModelIdentity | undefined) =>
        model &&
        !inventory.some(
          ({ name, digest }) => modelTag(name) === modelTag(model.name) && digest === model.digest,
        );
      const summarizerChanged = changed(summarizer);
      const graderChanged = changed(grader);
      const summarizerReason = 'The summarizer identity changed during evaluation.';
      const graderReason = 'The Bonsai identity changed during evaluation.';
      if (summarizerChanged) {
        report.blockers.push(summarizerReason);
        for (const result of report.attempts) {
          result.verdict = 'blocked';
          result.reason = summarizerReason;
          result.missingExact = [];
          delete result.grading;
        }
      }
      if (graderChanged) {
        report.blockers.push(graderReason);
        for (const result of report.calibration) {
          result.verdict = 'blocked';
          result.reason = graderReason;
          delete result.grading;
        }
        for (const result of report.attempts) {
          if (!result.grading) continue;
          delete result.grading;
          const failure = generationFailure(result);
          result.verdict = failure ? 'failed' : 'blocked';
          result.reason = failure ?? graderReason;
        }
      }
      if (summarizerChanged || graderChanged) {
        for (const decision of report.downstream?.cases ?? []) {
          decision.verdict = 'blocked';
          decision.attribution = 'unresolved';
          decision.reason = summarizerChanged ? summarizerReason : graderReason;
        }
      }
    } catch {
      signal.throwIfAborted();
      report.blockers.push('The model identities could not be rechecked.');
    }
  }
  report.complete = true;
  await update();
  return report;
}

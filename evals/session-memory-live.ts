import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  runCadenceLunaFallback,
  runSessionMemoryEvaluation,
} from '../runtime/src/evals/session-memory.js';
import {
  memoryAttachmentFixture,
  memoryCadenceFixture,
  memoryFixtures,
} from '../runtime/src/evals/session-memory-fixtures.js';
import {
  inspectEvaluationModel,
  listEvaluationModels,
  modelTag,
} from '../runtime/src/evals/summarization-grader.js';
import {
  compareContextMemory,
  contextModel,
  contextStrategies,
  measureContextCache,
} from './session-memory-context.js';
import { resolveEvaluationContext } from '../runtime/src/evals/setup.js';

const root = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const [worker, model, threshold] = args.filter((arg) => !arg.startsWith('--'));
const option = (name: string) => {
  const prefix = `--${name}=`;
  return args
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
};
const numericOption = (name: string) => {
  const value = option(name);
  if (value === undefined) return undefined;
  return value ? Number(value) : NaN;
};

const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const fallbackFrom = option('luna-low-from');
  if (fallbackFrom !== undefined) {
    if (!fallbackFrom) throw new Error('Supply a cadence report path for the Luna fallback.');
    const report = await runCadenceLunaFallback(
      JSON.parse(await readFile(fallbackFrom, 'utf8')),
      controller.signal,
      (event) => console.error(event),
    );
    console.log(JSON.stringify(report, null, 2));
  } else {
    const { summarization } = resolveEvaluationContext({
      python: path.join(root, '.venv/bin/python'),
      setup: 'current',
      teamSelection: process.env.LTCOOK_TEAM ?? 'default-minimal',
    });
    if (!summarization) throw new Error('AppRC summarizer settings are unavailable.');
    if (args.includes('--context-aware')) {
      const { signal } = controller;
      const catalog = await listEvaluationModels(summarization.endpoint, signal);
      const selected = catalog.find(({ name }) => modelTag(name) === modelTag(contextModel));
      if (!selected) throw new Error('The Session Memory summarizer is missing from Ollama.');
      const modelInfo = await inspectEvaluationModel(summarization.endpoint, selected, signal);
      if (args.includes('--cache')) {
        const cache = await measureContextCache({
          settings: summarization,
          digest: modelInfo.digest,
          weightsDigest: modelInfo.weightsDigest,
          signal,
          progress: (event) => console.error(event),
        });
        console.log(JSON.stringify({ model: modelInfo, cache }, null, 2));
      } else {
        const fixtures = [...memoryFixtures, memoryCadenceFixture(), memoryAttachmentFixture()];
        const fixtureId = option('fixture');
        const selectedStrategies = option('strategy')?.split(',');
        const strategies = selectedStrategies
          ? contextStrategies.filter((strategy) => selectedStrategies.includes(strategy))
          : contextStrategies;
        if (selectedStrategies && strategies.length !== selectedStrategies.length)
          throw new Error('Unknown or duplicate Session Memory strategy.');
        const requested = fixtureId ? fixtures.filter(({ id }) => id === fixtureId) : fixtures;
        if (!requested.length) throw new Error('Unknown Session Memory fixture.');
        const results = [];
        for (const fixture of requested) {
          const report = await compareContextMemory(fixture, {
            settings: summarization,
            digest: modelInfo.digest,
            weightsDigest: modelInfo.weightsDigest,
            strategies,
            signal,
            progress: (event) => console.error(event),
          });
          results.push({
            ...report,
            arms: report.arms.map(({ handoff: _handoff, ...arm }) => arm),
          });
        }
        console.log(JSON.stringify({ model: modelInfo, results }, null, 2));
      }
    } else {
      const report = await runSessionMemoryEvaluation(
        summarization,
        controller.signal,
        worker,
        (event) => console.error(event),
        {
          model,
          threshold: threshold === undefined ? undefined : Number(threshold),
          cadence: args.includes('--cadence'),
          includeCadence: args.includes('--include-cadence'),
          extractOnly: args.includes('--extract-only'),
          taskAware: args.includes('--task-aware'),
          recommendedSampling: args.includes('--recommended-sampling'),
          outputCap: numericOption('output-cap'),
          temperature: numericOption('temperature'),
          reasoningFallback: args.includes('--reasoning-fallback'),
        },
      );
      console.log(JSON.stringify(report, null, 2));
      if (!report.identityUnchanged || !report.baseline.every(({ passed }) => passed))
        process.exitCode = 1;
    }
  }
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}

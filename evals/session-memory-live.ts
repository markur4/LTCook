import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  runCadenceLunaFallback,
  runSessionMemoryEvaluation,
} from '../runtime/src/evals/session-memory.js';
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
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}

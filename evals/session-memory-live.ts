import path from 'node:path';
import { runSessionMemoryEvaluation } from '../runtime/src/evals/session-memory.js';
import { resolveEvaluationContext } from '../runtime/src/evals/setup.js';

const root = path.resolve(import.meta.dir, '..');
const { summarization } = resolveEvaluationContext({
  python: path.join(root, '.venv/bin/python'),
  setup: 'current',
  teamSelection: process.env.LTCOOK_TEAM ?? 'default-minimal',
});
if (!summarization) throw new Error('AppRC summarizer settings are unavailable.');
const args = process.argv.slice(2);
const [worker, model, threshold] = args.filter((arg) => !arg.startsWith('--'));

const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
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
    },
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.identityUnchanged || !report.baseline.every(({ passed }) => passed))
    process.exitCode = 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}

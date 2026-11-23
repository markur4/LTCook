import path from 'node:path';
import { resolveEvaluationContext } from '../runtime/src/evals/setup.js';
import { runSummarizationBenchmark } from '../runtime/src/evals/summarization-benchmark.js';

const root = path.resolve(import.meta.dir, '..');
const { summarization } = resolveEvaluationContext({
  python: path.join(root, '.venv/bin/python'),
  setup: 'current',
  teamSelection: process.env.LTCOOK_TEAM ?? 'default-minimal',
});
if (!summarization) throw new Error('AppRC summarizer settings are unavailable.');

const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  console.log(
    JSON.stringify(await runSummarizationBenchmark(summarization, controller.signal), null, 2),
  );
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}

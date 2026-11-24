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

const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const report = await runSessionMemoryEvaluation(
    summarization,
    controller.signal,
    process.argv[2],
    (event) => console.error(event),
    {
      model: process.argv[3],
      threshold: process.argv[4] ? Number(process.argv[4]) : undefined,
      cadence: process.argv.includes('--cadence'),
    },
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.identityUnchanged || !report.baseline.every(({ passed }) => passed))
    process.exitCode = 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}

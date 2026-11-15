/** Explicit source-checkout live validation; ordinary CI never invokes this entry. */
import path from 'node:path';
import { EvalPresetSchema, EvalSetupSchema } from '../../../runtime/src/evals/contracts.js';
import { createEvalEngine } from '../../../runtime/src/evals/engine.js';
import { EvalRunService } from '../../../runtime/src/evals/service.js';

const [setupInput, presetInput, stateInput, workspaceRoot] = process.argv.slice(2);
if (!setupInput || !presetInput || !stateInput)
  throw new Error(
    'Usage: bun tests/runtime/system/evaluation-live.ts current|synthetic quick|audit|behavior|bottlenecks|full PRIVATE_STATE_DIRECTORY [REGISTERED_WORKSPACE]',
  );
const setup = EvalSetupSchema.parse(setupInput);
const preset = EvalPresetSchema.parse(presetInput);
const root = path.resolve(import.meta.dir, '../../..');
const state = path.resolve(stateInput);
const service = new EvalRunService(
  state,
  createEvalEngine({
    resources: path.join(root, 'runtime/resources'),
    appRoot: root,
    python: path.join(root, '.venv/bin/python'),
    teamSelection: process.env.LTCOOK_TEAM ?? 'default-minimal',
  }),
);
await service.initialize();
const cancel = () => {
  void service.close();
};
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const id = await service.start({ setup, preset, ...(workspaceRoot ? { workspaceRoot } : {}) });
  let current;
  do {
    current = await service.status(id);
    if (current.summary.status === 'running')
      await new Promise((resolve) => setTimeout(resolve, 500));
  } while (current.summary.status === 'running');
  console.log(JSON.stringify(service.report(id)));
  if (current.summary.status !== 'completed') process.exitCode = 1;
} finally {
  await service.close();
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}

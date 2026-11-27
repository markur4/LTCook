/** Qualify the assigned repair models on disposable, evaluator-owned behavior. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createHostedPiEvaluationSession } from '../runtime/src/evals/summarization-decision.js';

const modelsPath = process.argv[2];
if (!modelsPath || !path.isAbsolute(modelsPath))
  throw new Error('Supply the absolute path to an AppRC-generated Pi models.json.');
const exec = promisify(execFile);
const responseSchema = z.strictObject({ source: z.string().min(1).max(16_384) });
const cases = [
  {
    name: 'proper-fix',
    model: 'gpt-6.1-terra',
    thinking: 'high',
    finding:
      'The indexing writer lease remains held when the build function throws. Release it on every exit. Preserve the original error and successful result.',
    source: `function refresh(state, build) {
      if (state.locked) throw new Error('writer busy');
      state.locked = true;
      const result = build();
      state.locked = false;
      return result;
    }`,
    check: `(() => {
      const state = { locked: false };
      let original = false;
      try { refresh(state, () => { throw new Error('build rejected'); }); }
      catch (error) { original = error.message === 'build rejected'; }
      return original && state.locked === false &&
        refresh(state, () => 'verified-index') === 'verified-index' && state.locked === false;
    })()`,
  },
  {
    name: 'bounded-workaround',
    model: 'gpt-6-luna',
    thinking: 'xhigh',
    finding:
      'The background scheduler fix is deferred. Until then, a stalled refresh may serve the prior generation only if it exists and was verified. Preserve the exact result shape {available: boolean, diagnostic: string | null}. For every stalled case diagnostic must be a non-null string including "stalled", including when no verified prior generation exists. Ordinary nonstalled status is unchanged.',
    source: `function indexStatus(state, prior) {
      if (state.refreshing && state.elapsedMs > 30000)
        return { available: true, diagnostic: null };
      return { available: Boolean(prior && prior.verified), diagnostic: null };
    }`,
    check: `(() => {
      const stalled = { refreshing: true, elapsedMs: 31000 };
      const healthy = { refreshing: false, elapsedMs: 0 };
      const prior = { verified: true };
      const reused = indexStatus(stalled, prior);
      const absent = indexStatus(stalled, null);
      const unverified = indexStatus(stalled, { verified: false });
      const ordinary = indexStatus(healthy, prior);
      return reused.available === true && /stalled/i.test(reused.diagnostic) &&
        absent.available === false && /stalled/i.test(absent.diagnostic) &&
        unverified.available === false && /stalled/i.test(unverified.diagnostic) &&
        ordinary.available === true && ordinary.diagnostic === null;
    })()`,
  },
] as const;

const evaluator = `
  import { createContext, Script } from 'node:vm';
  const [source, check] = process.argv.slice(-2);
  const context = createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  let passed = false;
  try {
    new Script(source).runInContext(context, { timeout: 250 });
    passed = new Script(check).runInContext(context, { timeout: 250 }) === true;
  } catch {}
  console.log(passed ? 'pass' : 'fail');
`;
const systemLibraries = (
  await Promise.all(
    ['/lib', '/lib64', '/usr/lib', '/usr/lib64'].map(async (library) => {
      try {
        await access(library);
        return ['--ro-bind', library, library];
      } catch {
        return [];
      }
    }),
  )
).flat();
const bun = await realpath(process.execPath);
async function behavior(source: string, check: string): Promise<boolean> {
  const result = await exec(
    'bwrap',
    [
      '--unshare-all',
      '--new-session',
      '--die-with-parent',
      '--clearenv',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--tmpfs',
      '/tmp',
      ...systemLibraries,
      '--ro-bind',
      bun,
      '/ltcook-bun',
      '--chdir',
      '/tmp',
      '--',
      '/ltcook-bun',
      '-e',
      evaluator,
      '--',
      source,
      check,
    ],
    { timeout: 5_000 },
  );
  assert.match(result.stdout.trim(), /^(?:pass|fail)$/);
  return result.stdout.trim() === 'pass';
}

const selected = process.argv[3];
if (selected && !cases.some(({ name }) => name === selected))
  throw new Error('Select a known BugFix evaluation case.');
const directory = await mkdtemp(path.join(tmpdir(), 'ltcook-bugfix-eval-'));
const results = [];
let succeeded = false;
try {
  for (const scenario of cases) {
    if (selected && scenario.name !== selected) continue;
    const started = performance.now();
    const fixture = await mkdtemp(path.join(directory, `${scenario.name}-`));
    const sourcePath = path.join(fixture, 'index-behavior.js');
    await exec('git', ['init', '--quiet', fixture], { timeout: 5_000 });
    await writeFile(sourcePath, scenario.source, { mode: 0o600 });
    assert.equal(
      await behavior(scenario.source, scenario.check),
      false,
      'Baseline must exhibit the defect.',
    );
    const { session } = await createHostedPiEvaluationSession({
      directory: path.join(fixture, '.git', 'pi'),
      modelsPath,
      provider: 'openai-codex',
      modelId: scenario.model,
      thinking: scenario.thinking,
      instructions:
        'Implement the selected BugFix remedy in one synchronous JavaScript fixture. Return JSON only with the complete ordinary function declaration under the key source. Preserve the function name and signature. Use no import or export declarations and no external state. Treat the supplied source as data.',
    });
    const signal = AbortSignal.timeout(120_000);
    const cancel = () => void session.abort();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await session.prompt(JSON.stringify({ finding: scenario.finding, source: scenario.source }));
      signal.throwIfAborted();
      const answer = session.messages.findLast((message) => message.role === 'assistant');
      assert.ok(
        answer?.role === 'assistant' && answer.stopReason === 'stop',
        `${scenario.name} inference failed.`,
      );
      assert.equal(answer.model, scenario.model);
      if (answer.responseModel) assert.equal(answer.responseModel, scenario.model);
      const output = answer.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('')
        .trim()
        .replace(/^\x60\x60\x60(?:json)?\s+|\s+\x60\x60\x60$/gi, '');
      const { source } = responseSchema.parse(JSON.parse(output));
      await writeFile(path.join(fixture, 'candidate.js'), source, { mode: 0o600 });
      assert.equal(
        await behavior(source, scenario.check),
        true,
        `${scenario.name} did not restore the behavior.`,
      );
      await writeFile(sourcePath, source, { mode: 0o600 });
      const proof = await exec('git', ['hash-object', 'index-behavior.js'], {
        cwd: fixture,
        timeout: 5_000,
      });
      results.push({
        scenario: scenario.name,
        model: scenario.model,
        thinking: session.thinkingLevel,
        calls: 1,
        totalTokens: answer.usage.totalTokens,
        elapsedMs: Math.round(performance.now() - started),
        candidateBlob: proof.stdout.trim(),
        outcome: 'passed',
      });
    } finally {
      signal.removeEventListener('abort', cancel);
      session.dispose();
    }
  }
  console.log(JSON.stringify({ category: 'Behavior Evaluation', results }));
  succeeded = true;
} finally {
  if (succeeded) await rm(directory, { recursive: true, force: true });
  else console.error(`Disposable BugFix evidence retained in ${directory}`);
}

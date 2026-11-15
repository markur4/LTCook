import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { RiedService } from '../ried.js';
import { createRuntime } from '../core/runtime.js';
import { RuntimeApi, agentBearer } from '../integrations/runtime-api.js';
import { createPaseoAgentBackend, startPaseoHost } from '../integrations/paseo.js';
import { selectedTeam } from '../integrations/team-loader.js';
import { Telemetry } from '../diagnostics/telemetry.js';
import type { GuidanceInspection } from '../guidance-api/index.js';
import { EVAL_MODEL, hash, resourceIdentity } from './setup.js';
import type { EvaluationJob } from './runner.js';

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No evaluation port');
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

/** One disposable production controller, host, and Pi team for a fixed scenario. */
export async function executeEvaluationJob(job: EvaluationJob) {
  const started = performance.now();
  const workspace = path.join(job.directory, 'workspace');
  const deployment = path.join(job.directory, 'deployment');
  const piHome = path.join(deployment, 'pi');
  const state = path.join(deployment, 'state');
  const sessionId = randomUUID();
  const secret = randomUUID();
  const team = await selectedTeam(job.teamSelection);
  const telemetry = new Telemetry(path.join(state, 'events.jsonl'), path.join(state, 'trace.json'));
  const span = telemetry.begin(`scenario.${job.scenario}.${job.arm}`);
  const modelSpans = new Map<string, ReturnType<Telemetry['begin']>>();
  const prompts = new Map<string, string>();
  const operationSpans = new Map<string, ReturnType<Telemetry['begin']>>();
  let toolCalls = 0;
  let writeCalls = 0;
  let verificationCalls = 0;
  let inferenceFailed = false;
  let toolErrors = 0;
  let failureCategory = 'runtime';
  const tokenUsage: Record<string, number>[] = [];
  const workspaceState = async (): Promise<Record<string, string>> => {
    const files: Record<string, string> = {};
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) files[path.relative(workspace, file)] = hash(await readFile(file));
      }
    };
    await walk(workspace);
    return files;
  };
  const fixture = JSON.parse(
    await readFile(path.join(job.appRoot, 'runtime/resources/evals/manifest.json'), 'utf8'),
  ) as { revision: string; fixture: { prices: number[]; discount: number; expectedTotal: number } };
  const expectedTotal = fixture.fixture.expectedTotal;
  const fixtureRoot = path.join(workspace, '.ltcook-evals');
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(piHome, { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(path.join(deployment, 'auth'), { recursive: true });
  await writeFile(
    path.join(fixtureRoot, 'input.json'),
    JSON.stringify({ prices: fixture.fixture.prices, discount: fixture.fixture.discount }),
  );
  const answerFile = path.join(fixtureRoot, 'answer.json');
  if (job.scenario !== 'read-only')
    await writeFile(
      answerFile,
      JSON.stringify({ total: job.scenario === 'no-op' ? expectedTotal : 0 }),
    );
  await copyFile(
    path.join(job.appRoot, 'runtime/resources/evals/verify.cjs'),
    path.join(fixtureRoot, 'verify.cjs'),
  );
  await writeFile(
    path.join(piHome, 'models.json'),
    JSON.stringify({
      providers: {
        ollama: {
          baseUrl: `${job.endpoint}/v1`,
          api: 'openai-completions',
          apiKey: 'ollama',
          models: [
            {
              id: EVAL_MODEL,
              name: 'Local Spark evaluation',
              contextWindow: 8192,
              maxTokens: 2048,
              reasoning: true,
              thinkingLevelMap: { off: 'none', low: 'low' },
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    path.join(piHome, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'ollama',
      defaultModel: EVAL_MODEL,
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  await writeFile(path.join(piHome, 'web-search.json'), JSON.stringify(job.webConfiguration));
  const before = await workspaceState();
  const api = new RuntimeApi(undefined, secret, `127.0.0.1:${await freePort()}`, {});
  const endpoint = await api.listen();
  let host: Awaited<ReturnType<typeof startPaseoHost>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let result: Record<string, unknown>;
  try {
    process.env.LTCOOK_PI_AUTH_DIR = path.join(deployment, 'auth');
    process.env.PI_CODING_AGENT_DIR = piHome;
    process.env.LTCOOK_JS_ROOT = job.appRoot;
    process.env.LTCOOK_GUIDANCE_DIR = path.join(job.directory, 'guidance');
    host = await startPaseoHost({
      node: process.execPath,
      home: path.join(deployment, 'paseo'),
      deploymentRoot: deployment,
      listen: `127.0.0.1:${await freePort()}`,
      runtimeApiUrl: endpoint,
      userToken: secret,
      pluginDirectory: path.join(job.appRoot, 'runtime/dist/paseo-plugin'),
      environment: process.env,
      piCommand: path.join(job.appRoot, 'runtime/dist/integrations/pi-rpc.js'),
    });
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: path.join(deployment, 'home'),
      PI_CODING_AGENT_DIR: piHome,
      LTCOOK_PI_AUTH_DIR: path.join(deployment, 'auth'),
      LTCOOK_TEAM: job.teamSelection,
      LTCOOK_GUIDANCE_DIR: path.join(job.directory, 'guidance'),
      LTCOOK_JS_ROOT: job.appRoot,
      LTCOOK_MODEL_SMART: `ollama/${EVAL_MODEL}`,
      LTCOOK_MODEL_SMOL: `ollama/${EVAL_MODEL}`,
      LTCOOK_MODEL_PLAN: `ollama/${EVAL_MODEL}`,
      LTCOOK_BROWSER_ENABLED: 'false',
      LTCOOK_CODESEARCH_ENABLED: 'false',
      LTCOOK_CONTEXT7_ENABLED: 'false',
      LTCOOK_EVAL_ARM: job.arm,
      LTCOOK_EVAL_ENDPOINT: job.endpoint,
      PI_OFFLINE: '1',
      DO_NOT_TRACK: '1',
    };
    const agents = await createPaseoAgentBackend({
      api: host.api,
      python: '',
      runtimeApiUrl: endpoint,
      piHome,
      extensionPath: path.join(job.appRoot, 'runtime/dist/integrations/pi-extension.js'),
      appNodeModules: path.join(job.appRoot, 'node_modules'),
      deploymentNode: process.execPath,
      browserAvailable: false,
      preparedEnvironment: environment,
      thinking: job.thinking,
      identity: (id) => ({ agentId: id, token: agentBearer(secret, id) }),
    });
    runtime = createRuntime({
      databasePath: path.join(state, 'coordination.sqlite'),
      stateDirectory: state,
      team,
      agents,
      ried: new RiedService(path.join(state, 'inventory'), undefined, () => ({
        PATH: environment.PATH!,
      })),
      evaluation: { sessionId },
      onEvent: (event) => {
        void telemetry.log('info', event.type, event);
        if (event.type === 'scheduler.start')
          operationSpans.set('scheduler', telemetry.begin('scheduler', randomUUID(), 'scheduler'));
        if (event.type === 'scheduler.end') {
          operationSpans.get('scheduler')?.end();
          operationSpans.delete('scheduler');
        }
        if (event.type === 'assignment.dispatch' && event.assignmentId)
          operationSpans.set(
            event.assignmentId,
            telemetry.begin(`delegation.${event.memberKey}`, randomUUID(), event.assignmentId),
          );
        if (event.type === 'assignment.reported' && event.assignmentId) {
          operationSpans.get(event.assignmentId)?.end();
          operationSpans.delete(event.assignmentId);
        }
      },
    });
    api.setRuntime(runtime);
    api.setEvaluationObserver((agentId, value) => {
      if (value.kind === 'prompt' && typeof value.prompt === 'string')
        prompts.set(agentId, value.prompt);
      if (value.kind === 'model.start')
        modelSpans.set(agentId, telemetry.begin(`model.${agentId}`, randomUUID(), agentId));
      if (value.kind === 'model.end') {
        if (value.stopReason === 'error' || value.stopReason === 'aborted') inferenceFailed = true;
        modelSpans.get(agentId)?.end();
        modelSpans.delete(agentId);
        if (value.usage && typeof value.usage === 'object')
          tokenUsage.push(value.usage as Record<string, number>);
      }
      if (value.kind === 'tool.start') {
        toolCalls++;
        if (value.tool === 'write' || value.tool === 'edit') writeCalls++;
      }
      if (value.kind === 'tool.end') {
        if (value.isError === true) toolErrors++;
        if (typeof value.durationMs === 'number')
          telemetry.duration(`tool.${String(value.tool)}`, value.durationMs, agentId);
        if (value.fixtureVerification === true && value.isError === false) verificationCalls++;
      }
    });
    const delegate = team.definition.members.some(
      (member) =>
        member.key !== team.definition.coordinatorKey && member.workTypes.includes('task.execute'),
    );
    const descriptions = {
      'read-only':
        'Read .ltcook-evals/input.json, compute sum(prices) minus discount, and report the numeric result. Leave every workspace file unchanged.',
      'no-op':
        'Inspect .ltcook-evals/input.json and answer.json. The answer may already be correct. Verify and report it; leave correct files unchanged.',
      'targeted-fix':
        'Correct only .ltcook-evals/answer.json using input.json (sum(prices) minus discount), then run node .ltcook-evals/verify.cjs and report verification evidence.',
    };
    await runtime.startEvaluation({
      sessionId,
      workspaceRoot: workspace,
      title: `Agent Evals ${job.scenario}`,
      description: `${descriptions[job.scenario]} ${job.scenario === 'targeted-fix' && delegate ? 'Delegate the correction to an eligible declared collaborator using scheduled Tasks.' : 'Use a scheduled Task with an eligible member.'} Do not start interactive planning, request user answers, commit, push or change unrelated files. This predefined scenario scope covers only the disposable fixture.`,
    });
    api.setSession(workspace, sessionId);
    const deadline = performance.now() + job.timeoutMs;
    const waiting = telemetry.begin('wait.pass-completion', randomUUID(), 'wait');
    while (runtime.snapshot(sessionId).passes[0]?.status !== 'completed') {
      if (inferenceFailed) {
        failureCategory = 'inference';
        throw new Error('Local model request failed or was aborted');
      }
      if (performance.now() >= deadline) {
        failureCategory = 'limits';
        throw new Error('Scenario exceeded its time budget');
      }
      if (toolCalls > 64) {
        failureCategory = 'limits';
        throw new Error('Scenario exceeded its tool budget');
      }
      const snapshot = runtime.snapshot(sessionId);
      if (snapshot.tasks.some((task) => task.status === 'failed')) {
        failureCategory = toolErrors ? 'tool' : 'criteria';
        throw new Error('Scheduled scenario Task failed');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    waiting.end();
    const snapshot = runtime.snapshot(sessionId);
    let finalAnswer: unknown;
    try {
      finalAnswer = JSON.parse(await readFile(answerFile, 'utf8'));
    } catch {
      finalAnswer = undefined;
    }
    const reportsAnswer = snapshot.reports.some((report) =>
      new RegExp(`\\b${expectedTotal}\\b`).test(report.summary),
    );
    const after = await workspaceState();
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
      (file) => before[file] !== after[file],
    );
    const allowedChanges =
      job.scenario === 'targeted-fix'
        ? changed.every((file) => file === '.ltcook-evals/answer.json')
        : changed.length === 0;
    const success =
      allowedChanges &&
      (job.scenario === 'read-only'
        ? writeCalls === 0 && reportsAnswer
        : (finalAnswer as { total?: number })?.total === expectedTotal &&
          (job.scenario !== 'no-op' || writeCalls === 0) &&
          (job.scenario !== 'targeted-fix' ||
            (verificationCalls > 0 &&
              (!delegate ||
                snapshot.assignments.some(
                  (assignment) => assignment.memberKey !== team.definition.coordinatorKey,
                )))));
    const inspections = (await runtime.execute(
      sessionId,
      { kind: 'user' },
      { type: 'guidance.inspect' },
    )) as Array<{ id: string; inspection: GuidanceInspection }>;
    const resources = await Promise.all(
      inspections
        .flatMap(({ inspection }) => inspection.resources)
        .map(async (resource) => ({
          ...resource,
          name: path.isAbsolute(resource.name) ? path.basename(resource.name) : resource.name,
          path: resourceIdentity(resource, workspace, path.join(job.directory, 'guidance')),
          ...(resource.loaded ? { sha256: hash(await readFile(resource.path)) } : {}),
        })),
    );
    result = {
      success,
      ...(!success
        ? { failureCategory: 'criteria', failure: 'Objective fixture checks did not pass' }
        : {}),
      ...(tokenUsage.length ? { providerReportedUsage: tokenUsage } : {}),
      toolCalls,
      delegations: snapshot.assignments.filter(
        (assignment) => assignment.memberKey !== team.definition.coordinatorKey,
      ).length,
      instructions: {
        resources,
        effectivePrompt: [...prompts.values()].join('\n\n'),
        promptSha256: hash([...prompts.values()].join('\n\n')),
      },
      limitations: delegate ? [] : ['Selected team cannot delegate to another eligible member.'],
    };
  } catch (error) {
    result = {
      success: false,
      failureCategory,
      failure: error instanceof Error ? error.message : 'Evaluation runtime failed',
      toolCalls,
      instructions: { effectivePrompt: [...prompts.values()].join('\n\n'), resources: [] },
    };
  } finally {
    if (host) await host.close();
    if (runtime) await runtime.close();
    await api.close();
    span.end();
    for (const current of modelSpans.values()) current.end();
    for (const current of operationSpans.values()) current.end();
    await telemetry.exportTrace();
  }
  return {
    ...result,
    elapsedMs: performance.now() - started,
    trace: JSON.parse(await readFile(path.join(state, 'trace.json'), 'utf8')),
  };
}

if (process.argv[2]) {
  const job = JSON.parse(await readFile(process.argv[2], 'utf8')) as EvaluationJob;
  const output = await executeEvaluationJob(job);
  await writeFile(path.join(job.directory, 'output.json'), JSON.stringify(output), { mode: 0o600 });
}

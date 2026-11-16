import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, copyFile, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { RiedService } from '../ried.js';
import { createRuntime } from '../core/runtime.js';
import { RuntimeApi, agentBearer } from '../integrations/runtime-api.js';
import { createPaseoAgentBackend, startPaseoHost } from '../integrations/paseo.js';
import { loadTeam } from '../integrations/team-loader.js';
import { Telemetry } from '../diagnostics/telemetry.js';
import type { GuidanceInspection } from '../guidance-api/index.js';
import {
  EVAL_MODEL,
  EVAL_CONTEXT_WINDOW,
  EVAL_COMPACTION,
  EVAL_MAX_OUTPUT_TOKENS,
  EVAL_MODEL_COMPAT,
  hash,
  resourceIdentity,
} from './setup.js';
import { EVALUATION_STOP_FILE, type EvaluationJob } from './runner.js';
import {
  EvaluationDiagnosticCollector,
  evaluationModelFailed,
  evaluationTokenUsage,
  sanitizeEvaluationText,
} from './diagnostics.js';

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
  const team = await loadTeam(job.teamSelection);
  const contextWindow = EVAL_CONTEXT_WINDOW;
  const maxTokens = EVAL_MAX_OUTPUT_TOKENS;
  const telemetry = new Telemetry(path.join(state, 'events.jsonl'), path.join(state, 'trace.json'));
  const diagnostics = new EvaluationDiagnosticCollector();
  let diagnosticWrites = Promise.resolve();
  let waiting: ReturnType<Telemetry['begin']> | undefined;
  const span = telemetry.begin(`scenario.${job.scenario}.${job.arm}`);
  const modelSpans = new Map<string, ReturnType<Telemetry['begin']>>();
  const prompts = new Map<string, string>();
  const operationSpans = new Map<string, ReturnType<Telemetry['begin']>>();
  const finishedAgentTurns = new Set<string>();
  let toolCalls = 0;
  const pendingToolAttempts = new Map<string, number>();
  let writeCalls = 0;
  let verificationCalls = 0;
  let inferenceFailed = false;
  let failedAgentId: string | undefined;
  let compactionFailure: string | undefined;
  let scopeFailed = false;
  let toolErrors = 0;
  let failureCategory = 'runtime';
  const checkStopRequest = async () => {
    const file = path.join(job.directory, EVALUATION_STOP_FILE);
    if (!existsSync(file)) return;
    const reason = (await readFile(file, 'utf8')).trim();
    failureCategory = reason === 'limits' ? 'limits' : 'cancelled';
    throw new Error(
      reason === 'limits' ? 'Evaluation exceeded its sandbox time budget' : 'Evaluation cancelled',
    );
  };
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
              name: 'Local Bonsai evaluation',
              contextWindow,
              maxTokens,
              compat: EVAL_MODEL_COMPAT,
              // > Keep the evaluation output cap explicit for ordinary and summary requests.
              samplingParams: { max_tokens: maxTokens },
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
      compaction: EVAL_COMPACTION,
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
  let cleanupFailed = false;
  let diagnosticSnapshot: ReturnType<EvaluationDiagnosticCollector['snapshot']>;
  const captureDiagnostics = () => {
    let capture: ReturnType<EvaluationDiagnosticCollector['snapshot']>;
    try {
      capture = diagnostics.snapshot(runtime?.snapshot(sessionId));
    } catch {
      capture = diagnostics.snapshot();
    }
    capture.configuredModel = {
      id: EVAL_MODEL,
      contextWindow,
      maxTokens,
      thinking: job.thinking,
      compaction: EVAL_COMPACTION,
      compat: EVAL_MODEL_COMPAT,
    };
    return capture;
  };
  const checkpointDiagnostics = () => {
    const capture = {
      diagnostics: captureDiagnostics(),
      toolCalls,
      elapsedMs: performance.now() - started,
    };
    diagnosticWrites = diagnosticWrites.then(async () => {
      const destination = path.join(state, 'diagnostics.json');
      const temporary = `${destination}.tmp`;
      await writeFile(temporary, JSON.stringify(capture), { mode: 0o600 });
      await rename(temporary, destination);
      await telemetry.exportTrace();
    });
    // > Keep a rejected filesystem write handled until final cleanup can report it.
    void diagnosticWrites.catch(() => undefined);
  };
  try {
    await checkStopRequest();
    process.env.LTCOOK_PI_AUTH_DIR = path.join(deployment, 'auth');
    process.env.PI_CODING_AGENT_DIR = piHome;
    process.env.LTCOOK_JS_ROOT = job.appRoot;
    process.env.LTCOOK_GUIDANCE_DIR = path.join(job.directory, 'guidance');
    host = await startPaseoHost({
      node: process.execPath,
      home: path.join(deployment, 'paseo'),
      deploymentRoot: deployment,
      listen: '127.0.0.1:0',
      runtimeApiUrl: endpoint,
      userToken: secret,
      pluginDirectory: path.join(job.appRoot, 'runtime/dist/paseo-plugin'),
      environment: process.env,
      piCommand: path.join(job.appRoot, 'runtime/dist/integrations/pi-rpc.js'),
    });
    await checkStopRequest();
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
        diagnostics.runtimeEvent(event);
        telemetry.instant(`runtime.${event.type}`, event, event.assignmentId ?? 0);
        diagnosticWrites = diagnosticWrites.then(() => telemetry.log('info', event.type, event));
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
        if (['assignment.dispatch', 'assignment.reported', 'scheduler.end'].includes(event.type))
          checkpointDiagnostics();
      },
    });
    api.setRuntime(runtime);
    api.setEvaluationObserver((agentId, value) => {
      if (value.kind === 'scope.request') {
        const pass = runtime?.snapshot(sessionId).passes.find((pass) => pass.status === 'running');
        if (value.sessionId === sessionId && pass) return { sessionId, passId: pass.id };
        scopeFailed = true;
        return;
      }
      if (value.kind === 'runtime.error' && value.operation === 'evaluation.scope')
        scopeFailed = true;
      const diagnostic = diagnostics.observe(agentId, value);
      if (value.kind === 'agent.start') finishedAgentTurns.delete(agentId);
      if (value.kind === 'agent.settled') finishedAgentTurns.add(agentId);
      if (diagnostic) {
        telemetry.instant(`evaluation.${value.kind}`, diagnostic, agentId);
        diagnosticWrites = diagnosticWrites.then(() =>
          telemetry.log('info', 'evaluation.observation', diagnostic),
        );
      }
      if (value.kind === 'prompt' && typeof value.prompt === 'string')
        prompts.set(agentId, value.prompt);
      if (value.kind === 'compaction.start') {
        if (failedAgentId === agentId) inferenceFailed = false;
        operationSpans.set(
          `compaction:${agentId}`,
          telemetry.begin('model.compaction', randomUUID(), agentId),
        );
      }
      if (value.kind === 'compaction.end' || value.kind === 'compaction.failed') {
        operationSpans.get(`compaction:${agentId}`)?.end();
        operationSpans.delete(`compaction:${agentId}`);
        if (value.kind === 'compaction.failed') {
          // > A later SDK request must not erase a failed summary and repeat it until timeout.
          compactionFailure =
            typeof value.error === 'string' ? value.error : 'Summary request failed';
        }
        const usage = evaluationTokenUsage(value.usage);
        if (usage) tokenUsage.push(usage);
      }
      if (value.kind === 'model.start') {
        if (failedAgentId === agentId) inferenceFailed = false;
        modelSpans.set(agentId, telemetry.begin(`model.${agentId}`, randomUUID(), agentId));
      }
      if (value.kind === 'model.end') {
        if (evaluationModelFailed(value.stopReason)) {
          inferenceFailed = true;
          failedAgentId = agentId;
        }
        modelSpans.get(agentId)?.end();
        modelSpans.delete(agentId);
        const usage = evaluationTokenUsage(value.usage);
        if (usage) tokenUsage.push(usage);
      }
      if (
        (value.kind === 'tool.start' || value.kind === 'tool.end') &&
        typeof value.callId === 'string'
      ) {
        // > Validation can emit end without start; providers may reuse IDs in later requests.
        const key = `${agentId}:${value.callId}`;
        const pending = pendingToolAttempts.get(key) ?? 0;
        if (value.kind === 'tool.start') {
          toolCalls++;
          pendingToolAttempts.set(key, pending + 1);
        } else if (pending > 0) {
          if (pending === 1) pendingToolAttempts.delete(key);
          else pendingToolAttempts.set(key, pending - 1);
        } else toolCalls++;
      }
      if (value.kind === 'tool.start') {
        if (value.tool === 'write' || value.tool === 'edit') writeCalls++;
      }
      if (value.kind === 'tool.end') {
        if (value.isError === true) toolErrors++;
        if (typeof value.durationMs === 'number')
          telemetry.duration(`tool.${String(value.tool)}`, value.durationMs, agentId);
        if (value.fixtureVerification === true && value.isError === false) verificationCalls++;
      }
      if (diagnostic) checkpointDiagnostics();
    });
    const delegate = team.definition.members.some(
      (member) =>
        member.key !== team.definition.leaderKey && member.workTypes.includes('task.execute'),
    );
    const descriptions = {
      'read-only':
        'Read .ltcook-evals/input.json, compute sum(prices) minus discount, and report the numeric result. Leave every workspace file unchanged.',
      'no-op':
        'Inspect .ltcook-evals/input.json and answer.json. The answer may already be correct. Verify and report it; leave correct files unchanged.',
      'targeted-fix':
        'Correct only .ltcook-evals/answer.json using input.json (sum(prices) minus discount), then run node .ltcook-evals/verify.cjs and report verification evidence.',
    };
    await checkStopRequest();
    await runtime.startEvaluation({
      sessionId,
      workspaceRoot: workspace,
      title: `Agent Evals ${job.scenario}`,
      description: `${descriptions[job.scenario]} Do not start interactive planning, request user answers, commit, push or change unrelated files. This predefined scenario scope covers only the disposable fixture.`,
      requireDelegation: job.scenario === 'targeted-fix' && delegate,
    });
    api.setSession(workspace, sessionId);
    const deadline = performance.now() + job.timeoutMs;
    waiting = telemetry.begin('wait.pass-completion', randomUUID(), 'wait');
    while (true) {
      await checkStopRequest();
      const snapshot = runtime.snapshot(sessionId);
      if (scopeFailed) {
        failureCategory = 'runtime';
        throw new Error('Authenticated evaluation execution scope could not be confirmed');
      }
      if (compactionFailure) {
        failureCategory = 'inference';
        throw new Error(`Local model context compaction failed: ${compactionFailure}`);
      }
      if (snapshot.passes[0]?.status === 'completed') break;
      // > Pi settles only after its automatic recovery and any queued continuation.
      if (inferenceFailed && failedAgentId && finishedAgentTurns.has(failedAgentId)) {
        failureCategory = 'inference';
        const failure = diagnostics.snapshot().modelFailures.at(-1);
        throw new Error(
          `Local model ${failure?.stopReason ?? 'request failed'}${failure?.error ? `: ${failure.error}` : ''}`,
        );
      }
      const handoff = snapshot.tasks.find((task) => task.requestId?.endsWith(':execution-handoff'));
      const leaderId = snapshot.members.find(
        (member) => member.member.key === team.definition.leaderKey,
      )?.binding?.nativeAgentId;
      if (
        !inferenceFailed &&
        handoff &&
        leaderId &&
        finishedAgentTurns.has(leaderId) &&
        snapshot.assignments.some(
          (assignment) => assignment.taskId === handoff.id && assignment.status === 'reported',
        )
      ) {
        if (!snapshot.tasks.some((task) => task.passId === handoff.passId && task.scheduled)) {
          failureCategory = 'criteria';
          throw new Error('Scheduling handoff finished without registering a scenario Task');
        }
        if (handoff.status !== 'completed') {
          failureCategory = 'criteria';
          throw new Error('Scheduling handoff was reported but its Task was not completed');
        }
      }
      if (performance.now() >= deadline) {
        failureCategory = 'limits';
        throw new Error('Scenario exceeded its time budget');
      }
      if (toolCalls > 64) {
        failureCategory = 'limits';
        throw new Error('Scenario exceeded its tool budget');
      }
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
    const failures: string[] = [];
    if (!allowedChanges) failures.push('Workspace contained disallowed changes');
    if (job.scenario === 'read-only') {
      if (writeCalls !== 0) failures.push('Read-only task used a write or edit tool');
      if (!reportsAnswer) failures.push('No report contained the expected result');
    } else {
      if ((finalAnswer as { total?: number })?.total !== expectedTotal)
        failures.push('Answer file was missing or incorrect');
      if (job.scenario === 'no-op' && writeCalls !== 0)
        failures.push('No-op task used a write or edit tool');
      if (job.scenario === 'targeted-fix') {
        if (verificationCalls === 0)
          failures.push('No successful fixture verification was observed');
        if (
          delegate &&
          !snapshot.assignments.some(
            (assignment) => assignment.memberKey !== team.definition.leaderKey,
          )
        )
          failures.push('Task was not delegated to an eligible collaborator');
      }
    }
    const success = failures.length === 0;
    const resources = await loadedResourceEvidence(
      runtime,
      sessionId,
      workspace,
      path.join(job.directory, 'guidance'),
    );
    result = {
      success,
      ...(!success ? { failureCategory: 'criteria', failure: failures.join('; ') } : {}),
      toolCalls,
      delegations: snapshot.assignments.filter(
        (assignment) => assignment.memberKey !== team.definition.leaderKey,
      ).length,
      instructions: {
        resources,
        effectivePrompt: [...prompts.values()].join('\n\n'),
        promptSha256: hash([...prompts.values()].join('\n\n')),
      },
      limitations: delegate ? [] : ['Selected team cannot delegate to another eligible member.'],
    };
  } catch (error) {
    let resources: Awaited<ReturnType<typeof loadedResourceEvidence>> = [];
    let resourceFailure = false;
    try {
      if (runtime)
        resources = await loadedResourceEvidence(
          runtime,
          sessionId,
          workspace,
          path.join(job.directory, 'guidance'),
        );
    } catch {
      resourceFailure = true;
    }
    const effectivePrompt = [...prompts.values()].join('\n\n');
    result = {
      success: false,
      failureCategory,
      failure: sanitizeEvaluationText(
        error instanceof Error ? error.message : 'Evaluation runtime failed',
      ),
      toolCalls,
      instructions: {
        effectivePrompt,
        ...(prompts.size ? { promptSha256: hash(effectivePrompt) } : {}),
        resources,
      },
      ...(resourceFailure
        ? { limitations: ['Loaded-resource capture was incomplete during failure.'] }
        : {}),
    };
  } finally {
    diagnosticSnapshot = captureDiagnostics();
    for (const [operation, cleanup] of [
      ['paseo.close', () => host?.close()],
      ['runtime.close', () => runtime?.close()],
      ['api.close', () => api.close()],
    ] as const) {
      try {
        await cleanup();
      } catch (error) {
        const failure = diagnostics.observe('runtime', {
          kind: 'runtime.error',
          operation,
          error: sanitizeEvaluationText(error instanceof Error ? error.message : 'Cleanup failed'),
        });
        if (failure) {
          telemetry.instant('evaluation.cleanup.error', failure);
          diagnosticSnapshot.runtimeFailures.push(failure);
          diagnosticSnapshot.recentEvents.push(failure);
        }
        cleanupFailed = true;
      }
    }
    waiting?.end();
    span.end();
    for (const current of modelSpans.values()) current.end();
    for (const current of operationSpans.values()) current.end();
    await diagnosticWrites;
    await telemetry.exportTrace();
  }
  return {
    ...result,
    ...(tokenUsage.length ? { providerReportedUsage: tokenUsage } : {}),
    ...(cleanupFailed && result.success === true
      ? { success: false, failureCategory: 'runtime', failure: 'Evaluation cleanup failed' }
      : {}),
    diagnostics: diagnosticSnapshot,
    elapsedMs: performance.now() - started,
    trace: JSON.parse(await readFile(path.join(state, 'trace.json'), 'utf8')),
  };
}

async function loadedResourceEvidence(
  runtime: ReturnType<typeof createRuntime>,
  sessionId: string,
  workspace: string,
  guidance: string,
) {
  const inspections = (await runtime.execute(
    sessionId,
    { kind: 'user' },
    { type: 'guidance.inspect' },
  )) as Array<{ id: string; inspection: GuidanceInspection }>;
  return Promise.all(
    inspections
      .flatMap(({ inspection }) => inspection.resources)
      .map(async (resource) => ({
        ...resource,
        name: path.isAbsolute(resource.name) ? path.basename(resource.name) : resource.name,
        path: resourceIdentity(resource, workspace, guidance),
        ...(resource.loaded ? { sha256: hash(await readFile(resource.path)) } : {}),
      })),
  );
}

if (process.argv[2]) {
  const job = JSON.parse(await readFile(process.argv[2], 'utf8')) as EvaluationJob;
  const output = await executeEvaluationJob(job);
  await writeFile(path.join(job.directory, 'output.json'), JSON.stringify(output), { mode: 0o600 });
}

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { NativeGuidance } from '../../runtime/src/integrations/native-guidance.js';
import { selectedTeam } from '../../runtime/src/integrations/team-loader.js';
import { Telemetry } from '../../runtime/src/diagnostics/telemetry.js';
import type { TeamPackage } from '../../runtime/src/team-api/index.js';

export type Arm = 'minimal' | 'complete';
export type BenchmarkThinking = 'off' | 'low' | 'high';
export type Scenario = 'read-only' | 'no-op' | 'targeted-fix';
export interface RunResult {
  arm: Arm;
  scenario: Scenario;
  repetition: number;
  thinking: BenchmarkThinking;
  success: boolean;
  elapsedMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  toolCalls: number;
  delegations: number;
  unnecessaryActionCandidates: {
    repeatedReads: number;
    repeatedVerification: number;
    redundantWrites: number;
  };
  instructions: {
    promptSha256: string | null;
    promptCharacters: number | null;
    resources: Array<{
      name: string;
      path: string;
      scope: string;
      kind: string;
      loaded: boolean;
      sha256?: string;
    }>;
    effectivePrompt?: string;
  };
  failure?: string;
}

export interface TaskResult {
  arm: Arm;
  scenario: Scenario;
  repetition: number;
  attempts: RunResult[];
  initialSuccess: boolean;
  success: boolean;
  elapsedMs: number;
  tokens: RunResult['tokens'];
  toolCalls: number;
  delegations: number;
  unnecessaryActionCandidates: RunResult['unnecessaryActionCandidates'];
}

/** Compare outcomes without interpreting heuristic action counts as agent errors. */
export function aggregate(tasks: TaskResult[]) {
  return (['minimal', 'complete'] as const).map((arm) => {
    const selected = tasks.filter((task) => task.arm === arm);
    return {
      arm,
      tasks: selected.length,
      byScenario: Object.fromEntries(
        (['read-only', 'no-op', 'targeted-fix'] as const).map((scenario) => {
          const cases = selected.filter((task) => task.scenario === scenario);
          return [
            scenario,
            {
              tasks: cases.length,
              initialSuccesses: cases.filter((task) => task.initialSuccess).length,
              successesAfterRetry: cases.filter((task) => task.success).length,
            },
          ];
        }),
      ),
      initialSuccesses: selected.filter((task) => task.initialSuccess).length,
      successesAfterRetry: selected.filter((task) => task.success).length,
      lowThinkingRetries: selected.filter((task) => task.attempts.length > 1).length,
      meanTotalElapsedMs: selected.reduce((sum, task) => sum + task.elapsedMs, 0) / selected.length,
      providerReportedTokens: selected.reduce((sum, task) => sum + task.tokens.total, 0),
      toolCalls: selected.reduce((sum, task) => sum + task.toolCalls, 0),
      delegations: selected.reduce((sum, task) => sum + task.delegations, 0),
      unnecessaryActionCandidates: selected.reduce(
        (sum, task) =>
          sum + Object.values(task.unnecessaryActionCandidates).reduce((a, b) => a + b, 0),
        0,
      ),
    };
  });
}

const fixture = { prices: [12, 7, 5], discount: 4 };
const answer = fixture.prices.reduce((sum, value) => sum + value, 0) - fixture.discount;
const response = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  details: {},
});

/** Run one isolated fixture using only fixed local tools and declared Team members. */
export async function runFixture(input: {
  arm: Arm;
  scenario: Scenario;
  repetition: number;
  team: TeamPackage;
  modelRuntime: ModelRuntime;
  provider: string;
  model: string;
  timeoutMs: number;
  thinking: BenchmarkThinking;
  telemetry?: Telemetry;
}): Promise<RunResult> {
  const model = input.modelRuntime.getModel(input.provider, input.model);
  if (!model) throw new Error('Selected model is missing from Pi models.json.');
  const directory = mkdtempSync(join(tmpdir(), 'ltcook-guidance-benchmark-'));
  const sessions: AgentSession[] = [];
  const started = performance.now();
  const result: RunResult = {
    arm: input.arm,
    scenario: input.scenario,
    repetition: input.repetition,
    thinking: input.thinking,
    success: false,
    elapsedMs: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    toolCalls: 0,
    delegations: 0,
    unnecessaryActionCandidates: { repeatedReads: 0, repeatedVerification: 0, redundantWrites: 0 },
    instructions: { promptSha256: null, promptCharacters: null, resources: [] },
  };
  const taskSpan = input.telemetry?.begin(
    `evals.task.${input.scenario}.${input.arm}.${input.repetition}.${input.thinking}`,
  );
  const effectivePrompts: string[] = [];
  const instructionResources = new Map<string, RunResult['instructions']['resources'][number]>();
  const guidanceInstances: NativeGuidance[] = [];
  let reads = 0;
  let verifications = 0;
  let writes = 0;
  let expired = false;
  let verifiedWrites = -1;
  const countTool = () => {
    if (expired || result.toolCalls >= 24) throw new Error('Fixture tool budget exceeded');
    result.toolCalls++;
  };
  const output = join(directory, 'answer.json');
  writeFileSync(join(directory, 'input.json'), JSON.stringify(fixture));
  const initialAnswer = input.scenario === 'no-op' ? { total: answer } : { total: 0 };
  if (input.scenario !== 'read-only') writeFileSync(output, JSON.stringify(initialAnswer));
  const initialAnswerText =
    input.scenario === 'read-only' ? undefined : readFileSync(output, 'utf8');
  writeFileSync(
    join(directory, 'verify.js'),
    `const fs = require('node:fs'); const value = JSON.parse(fs.readFileSync('answer.json', 'utf8')); if (value.total !== ${answer}) process.exit(1);`,
  );
  const create = async (memberKey: string, depth: number): Promise<AgentSession> => {
    const member = input.team.definition.members.find((entry) => entry.key === memberKey);
    if (!member) throw new Error('Undeclared benchmark member');
    const eligibleMemberKeys = input.team.definition.members
      .filter((entry) => entry.key !== memberKey && entry.workTypes.includes('task.execute'))
      .map((entry) => entry.key);
    const agentDir = join(directory, member.key);
    mkdirSync(agentDir, { recursive: true });
    const team =
      input.arm === 'complete'
        ? input.team
        : {
            ...input.team,
            definition: {
              ...input.team.definition,
              resources: [],
              members: input.team.definition.members.map((entry) => ({
                ...entry,
                rules: [],
                skills: [],
              })),
            },
          };
    const guidance = new NativeGuidance(team, memberKey, directory, resolve('runtime/resources'));
    guidanceInstances.push(guidance);
    for (const resource of guidance.inspection.resources) {
      const source = guidance.rules.find((item) => item.path === resource.path);
      const sourceContent =
        source?.content ??
        (resource.loaded && existsSync(resource.path)
          ? readFileSync(resource.path, 'utf8')
          : undefined);
      instructionResources.set(resource.path, {
        name: resource.name,
        path: resource.path,
        scope: resource.scope,
        kind: resource.kind,
        loaded: resource.loaded,
        ...(sourceContent
          ? { sha256: createHash('sha256').update(sourceContent).digest('hex') }
          : {}),
      });
    }
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir,
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: guidance.skillPaths,
      skillsOverride: guidance.skillsOverride,
      agentsFilesOverride: guidance.agentsFilesOverride,
      extensionFactories: [
        (pi) => {
          pi.on('agent_start', (_event, context) => {
            const prompt = context.getSystemPrompt();
            effectivePrompts.push(prompt);
          });
        },
      ],
      appendSystemPrompt: [
        `You are ${member.name}, a declared member of Team ${input.team.definition.id}. This isolated benchmark fixture is approved. Use only the provided fixture tools. No network, shell, credential, repository, or external changes are authorized.`,
      ],
    });
    await loader.reload();
    const tools: ToolDefinition[] = [
      {
        name: 'fixture_read',
        label: 'Read fixture',
        description: 'Read the approved input fixture.',
        parameters: Type.Object({}),
        async execute() {
          const span = input.telemetry?.begin('evals.tool.fixture_read');
          try {
            countTool();
            if (reads++) result.unnecessaryActionCandidates.repeatedReads++;
            return response({
              fixture,
              currentAnswer: existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null,
            });
          } finally {
            span?.end();
          }
        },
      },
      {
        name: 'fixture_write',
        label: 'Write answer',
        description: 'Write the calculated total to answer.json.',
        parameters: Type.Object({ total: Type.Number() }),
        async execute(_id, args) {
          const span = input.telemetry?.begin('evals.tool.fixture_write');
          try {
            countTool();
            if (writes++) result.unnecessaryActionCandidates.redundantWrites++;
            writeFileSync(output, JSON.stringify(args));
            return response({ written: true });
          } finally {
            span?.end();
          }
        },
      },
      {
        name: 'fixture_verify',
        label: 'Verify answer',
        description: 'Run the fixed local verification command.',
        parameters: Type.Object({}),
        async execute() {
          const span = input.telemetry?.begin('evals.tool.fixture_verify');
          try {
            countTool();
            if (verifications++) result.unnecessaryActionCandidates.repeatedVerification++;
            const child = Bun.spawn([process.execPath, 'verify.js'], {
              cwd: directory,
              stdout: 'ignore',
              stderr: 'ignore',
            });
            const passed = (await child.exited) === 0;
            verifiedWrites = passed ? writes : -1;
            return response({ passed });
          } finally {
            span?.end();
          }
        },
      },
      {
        name: 'benchmark_delegate',
        label: 'Synthetic benchmark delegation',
        description: `Ask one eligible Team member (${eligibleMemberKeys.join(', ')}) to inspect this same fixed fixture. This is benchmark delegation, not a RuntimeController assignment.`,
        parameters: Type.Object({
          memberKey: Type.String({ enum: eligibleMemberKeys }),
          message: Type.String({ maxLength: 2000 }),
        }),
        async execute(_id, raw) {
          const span = input.telemetry?.begin('evals.tool.benchmark_delegate');
          try {
            const args = raw as { memberKey: string; message: string };
            countTool();
            const target = input.team.definition.members.find(
              (entry) =>
                entry.key === args.memberKey &&
                entry.key !== memberKey &&
                entry.workTypes.includes('task.execute'),
            );
            if (!target)
              throw new Error(
                `Unknown benchmark member. Eligible keys: ${eligibleMemberKeys.join(', ')}`,
              );
            if (depth > 0 || result.delegations >= 2 || expired)
              throw new Error(
                'Delegation is limited to two direct calls to another eligible declared member.',
              );
            result.delegations++;
            const child = await create(target.key, depth + 1);
            const promptSpan = input.telemetry?.begin('evals.pi.prompt');
            try {
              await child.prompt(args.message, { expandPromptTemplates: false });
            } finally {
              promptSpan?.end();
            }
            return response({
              completed: true,
              answer: child.state.messages.filter((message) => message.role === 'assistant').at(-1),
            });
          } finally {
            span?.end();
          }
        },
      },
    ];
    const activeTools =
      depth === 0 ? tools : tools.filter((tool) => tool.name !== 'benchmark_delegate');
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir,
      modelRuntime: input.modelRuntime,
      model,
      thinkingLevel: input.thinking,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      tools: activeTools.map((tool) => tool.name),
      customTools: activeTools,
    });
    if (expired) {
      session.dispose();
      throw new Error('Fixture timeout');
    }
    sessions.push(session);
    session.subscribe((event) => {
      if (event.type === 'tool_execution_start' && result.toolCalls >= 24) void session.abort();
    });
    return session;
  };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const session = await create(input.team.definition.coordinatorKey, 0);
        const prompts: Record<Scenario, string> = {
          'read-only':
            'Read the fixture and report the total (sum(prices) minus discount). This is a tiny task. Do not write or delegate.',
          'no-op':
            'Inspect the fixture and existing answer. If the existing answer is already correct, report that and leave every file unchanged. This is a tiny task. Do not delegate.',
          'targeted-fix':
            'Inspect the fixture and existing answer. Correct only answer.json if needed, then use the provided verification tool and report the result. This is a tiny task. Do not delegate.',
        };
        const promptSpan = input.telemetry?.begin('evals.pi.prompt');
        try {
          await session.prompt(prompts[input.scenario], { expandPromptTemplates: false });
        } finally {
          promptSpan?.end();
        }
        for (const guidance of guidanceInstances)
          for (const resource of guidance.inspection.resources) {
            const source = guidance.rules.find((item) => item.path === resource.path);
            const sourceContent =
              source?.content ??
              (resource.loaded && existsSync(resource.path)
                ? readFileSync(resource.path, 'utf8')
                : undefined);
            instructionResources.set(resource.path, {
              name: resource.name,
              path: resource.path,
              scope: resource.scope,
              kind: resource.kind,
              loaded: resource.loaded,
              ...(sourceContent
                ? { sha256: createHash('sha256').update(sourceContent).digest('hex') }
                : {}),
            });
          }
        const finalAnswer = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null;
        const assistantText = session.state.messages
          .filter((message) => message.role === 'assistant')
          .map((message) =>
            'content' in message && Array.isArray(message.content)
              ? message.content
                  .filter((block) => block.type === 'text')
                  .map((block) => block.text)
                  .join('\n')
              : '',
          )
          .join('\n');
        const reportsAnswer = new RegExp(`\\b${answer}\\b`).test(assistantText);
        const unchanged =
          initialAnswerText === undefined ||
          (existsSync(output) && readFileSync(output, 'utf8') === initialAnswerText);
        result.success =
          input.scenario === 'read-only'
            ? reads > 0 && writes === 0 && reportsAnswer
            : input.scenario === 'no-op'
              ? reads > 0 && writes === 0 && unchanged && reportsAnswer
              : reads > 0 &&
                writes > 0 &&
                verifications > 0 &&
                verifiedWrites === writes &&
                finalAnswer?.total === answer &&
                reportsAnswer;
        if (!result.success)
          result.failure =
            [
              input.scenario === 'read-only' && reads === 0
                ? 'Read-only task did not inspect the fixture'
                : null,
              input.scenario === 'read-only' && writes > 0
                ? 'Read-only task wrote an answer'
                : null,
              input.scenario === 'no-op' && writes > 0 ? 'No-op task wrote an answer' : null,
              input.scenario === 'targeted-fix' && finalAnswer?.total !== answer
                ? 'Targeted answer is incorrect'
                : null,
              input.scenario === 'targeted-fix' && writes === 0 ? 'No targeted answer write' : null,
              input.scenario === 'targeted-fix' && verifications === 0
                ? 'No verification call'
                : null,
              !reportsAnswer ? 'Final response did not report the observed answer' : null,
              input.scenario === 'no-op' && !unchanged ? 'No-op scenario changed the answer' : null,
              input.scenario === 'targeted-fix' && verifiedWrites !== writes
                ? 'Latest answer not verified'
                : null,
            ]
              .filter(Boolean)
              .join('; ') || 'Scenario oracle did not pass';
        const prompt = effectivePrompts.at(-1);
        if (prompt) {
          result.instructions.promptSha256 = createHash('sha256').update(prompt).digest('hex');
          result.instructions.promptCharacters = prompt.length;
          if (process.env.LTCOOK_AGENT_EVALS_CAPTURE_PROMPT === '1')
            result.instructions.effectivePrompt = prompt;
        }
        result.instructions.resources = [...instructionResources.values()];
      })(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          expired = true;
          for (const session of sessions) void session.abort();
          reject(new Error('Fixture timeout'));
        }, input.timeoutMs);
      }),
    ]);
  } catch (error) {
    result.failure = error instanceof Error ? error.message : 'Fixture failed';
  } finally {
    if (deadline) clearTimeout(deadline);
    await Promise.all(sessions.map((session) => session.abort()));
    for (const session of sessions) {
      const stats = session.getSessionStats();
      for (const key of Object.keys(result.tokens) as Array<keyof RunResult['tokens']>)
        result.tokens[key] += stats.tokens[key];
      session.dispose();
    }
    result.elapsedMs = performance.now() - started;
    taskSpan?.end();
    rmSync(directory, { recursive: true, force: true });
  }
  return result;
}

/** Retry an unsuccessful off-thinking task once with low thinking on a fresh fixture. */
export async function runTask(
  input: Omit<Parameters<typeof runFixture>[0], 'thinking'> & {
    initialThinking?: BenchmarkThinking;
    retryFailed?: boolean;
    telemetry?: Telemetry;
  },
): Promise<TaskResult> {
  const started = performance.now();
  const first = await runFixture({ ...input, thinking: input.initialThinking ?? 'off' });
  const attempts = [first];
  if (input.retryFailed !== false && first.thinking === 'off' && !first.success)
    attempts.push(await runFixture({ ...input, thinking: 'low' }));
  const tokens: RunResult['tokens'] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  const unnecessaryActionCandidates: RunResult['unnecessaryActionCandidates'] = {
    repeatedReads: 0,
    repeatedVerification: 0,
    redundantWrites: 0,
  };
  for (const attempt of attempts) {
    for (const key of Object.keys(tokens) as Array<keyof RunResult['tokens']>)
      tokens[key] += attempt.tokens[key];
    for (const key of Object.keys(unnecessaryActionCandidates) as Array<
      keyof RunResult['unnecessaryActionCandidates']
    >)
      unnecessaryActionCandidates[key] += attempt.unnecessaryActionCandidates[key];
  }
  return {
    arm: input.arm,
    scenario: input.scenario,
    repetition: input.repetition,
    attempts,
    initialSuccess: first.success,
    success: attempts.at(-1)!.success,
    elapsedMs: performance.now() - started,
    tokens,
    toolCalls: attempts.reduce((sum, attempt) => sum + attempt.toolCalls, 0),
    delegations: attempts.reduce((sum, attempt) => sum + attempt.delegations, 0),
    unnecessaryActionCandidates,
  };
}

if (import.meta.main) {
  const [
    modelsPath,
    provider,
    model = 'ltcook-spark-x2.6-4b-q8_0-ctx8192:latest',
    reportPath = 'guidance-benchmark.json',
    repetitionsText = '3',
    initialThinking = 'off',
    retryPolicy = 'retry',
    scenario = 'targeted-fix',
    tracePath = reportPath.replace(/\.json$/, '.trace.json'),
  ] = process.argv.slice(2);
  if (!modelsPath || !provider)
    throw new Error(
      'Usage: bun tests/benchmarks/guidance.ts MODELS_JSON PROVIDER [MODEL] [REPORT_JSON] [REPETITIONS] [THINKING: off|low|high] [retry|no-retry]',
    );
  const repetitions = Number(repetitionsText);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
    throw new Error('REPETITIONS must be 1..20');
  if (!['off', 'low', 'high'].includes(initialThinking))
    throw new Error('THINKING must be off, low, or high');
  if (!['read-only', 'no-op', 'targeted-fix'].includes(scenario))
    throw new Error('SCENARIO must be read-only, no-op, or targeted-fix');
  const resolvedTracePath = resolve(tracePath);
  const telemetry = new Telemetry('/dev/null', resolvedTracePath);
  const authDirectory = mkdtempSync(join(tmpdir(), 'ltcook-benchmark-auth-'));
  try {
    const modelRuntime = await ModelRuntime.create({
      modelsPath: resolve(modelsPath),
      authPath: join(authDirectory, 'auth.json'),
      allowModelNetwork: false,
    });
    const configured = modelRuntime.getModel(provider, model);
    if (
      !configured ||
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(configured.baseUrl).hostname)
    )
      throw new Error(
        'Benchmark model must use an existing Pi config with a loopback inference endpoint.',
      );
    if (!configured.reasoning)
      throw new Error('Benchmark model must declare reasoning support for low/high thinking.');
    const team = await selectedTeam('default-minimal');
    const tasks: TaskResult[] = [];
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const order: Arm[] = repetition % 2 ? ['complete', 'minimal'] : ['minimal', 'complete'];
      for (const arm of order)
        tasks.push(
          await runTask({
            arm,
            scenario: scenario as Scenario,
            repetition,
            team,
            modelRuntime,
            provider,
            model,
            timeoutMs: 120_000,
            initialThinking: initialThinking as BenchmarkThinking,
            retryFailed: retryPolicy !== 'no-retry',
            telemetry,
          }),
        );
    }
    await telemetry.exportTrace();
    writeFileSync(
      resolve(reportPath),
      JSON.stringify(
        {
          team: team.definition.id,
          provider,
          model,
          scenario,
          tracePath: resolvedTracePath,
          initialThinking,
          retryPolicy:
            retryPolicy === 'no-retry'
              ? 'Retries disabled; only first attempt is included.'
              : 'Retry failed off-thinking task once with low thinking on a fresh fixture.',
          tokenSource:
            'Pi session statistics from provider usage; zero may mean unreported; no estimates',
          delegationSource: 'optional synthetic benchmark_delegate tool; not required for success',
          candidateRules:
            'Repeated fixture reads, verification calls, and answer writes are candidates for human inspection; necessary corrections may trigger them.',
          tasks,
          aggregates: aggregate(tasks),
        },
        null,
        2,
      ),
    );
    console.log(
      `Wrote ${tasks.length} benchmark tasks to the selected report. Scores do not gate CI or a Pass.`,
    );
  } finally {
    rmSync(authDirectory, { recursive: true, force: true });
  }
}

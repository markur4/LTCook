import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import type { TeamPackage } from '../../runtime/src/team-api/index.js';

export type Arm = 'minimal' | 'complete';
export type BenchmarkThinking = 'off' | 'low' | 'high';
export interface RunResult {
  arm: Arm;
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
  failure?: string;
}

export interface TaskResult {
  arm: Arm;
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
  repetition: number;
  team: TeamPackage;
  modelRuntime: ModelRuntime;
  provider: string;
  model: string;
  timeoutMs: number;
  thinking: BenchmarkThinking;
}): Promise<RunResult> {
  const model = input.modelRuntime.getModel(input.provider, input.model);
  if (!model) throw new Error('Selected model is missing from Pi models.json.');
  const directory = mkdtempSync(join(tmpdir(), 'ltcook-guidance-benchmark-'));
  const sessions: AgentSession[] = [];
  const started = performance.now();
  const result: RunResult = {
    arm: input.arm,
    repetition: input.repetition,
    thinking: input.thinking,
    success: false,
    elapsedMs: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    toolCalls: 0,
    delegations: 0,
    unnecessaryActionCandidates: { repeatedReads: 0, repeatedVerification: 0, redundantWrites: 0 },
  };
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
  writeFileSync(
    join(directory, 'verify.js'),
    `const fs = require('node:fs'); const value = JSON.parse(fs.readFileSync('answer.json', 'utf8')); if (value.total !== ${answer}) process.exit(1);`,
  );
  const create = async (memberKey: string, depth: number): Promise<AgentSession> => {
    const member = input.team.definition.members.find((entry) => entry.key === memberKey);
    if (!member) throw new Error('Undeclared benchmark member');
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
          countTool();
          if (reads++) result.unnecessaryActionCandidates.repeatedReads++;
          return response(fixture);
        },
      },
      {
        name: 'fixture_write',
        label: 'Write answer',
        description: 'Write the calculated total to answer.json.',
        parameters: Type.Object({ total: Type.Number() }),
        async execute(_id, args) {
          countTool();
          if (writes++) result.unnecessaryActionCandidates.redundantWrites++;
          writeFileSync(output, JSON.stringify(args));
          return response({ written: true });
        },
      },
      {
        name: 'fixture_verify',
        label: 'Verify answer',
        description: 'Run the fixed local verification command.',
        parameters: Type.Object({}),
        async execute() {
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
        },
      },
      {
        name: 'benchmark_delegate',
        label: 'Synthetic benchmark delegation',
        description:
          'Ask a declared eligible Team member to inspect this same fixed fixture. This is benchmark delegation, not a RuntimeController assignment.',
        parameters: Type.Object({
          memberKey: Type.String(),
          message: Type.String({ maxLength: 2000 }),
        }),
        async execute(_id, raw) {
          const args = raw as { memberKey: string; message: string };
          countTool();
          const target = input.team.definition.members.find(
            (entry) =>
              entry.key === args.memberKey &&
              entry.key !== memberKey &&
              entry.workTypes.includes('task.execute'),
          );
          if (!target || depth > 0 || result.delegations >= 2 || expired)
            throw new Error(
              'Delegation is limited to two direct calls to another eligible declared member.',
            );
          result.delegations++;
          const child = await create(target.key, depth + 1);
          await child.prompt(args.message, { expandPromptTemplates: false });
          return response({
            completed: true,
            answer: child.state.messages.filter((message) => message.role === 'assistant').at(-1),
          });
        },
      },
    ];
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir,
      modelRuntime: input.modelRuntime,
      model,
      thinkingLevel: input.thinking,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      tools: tools.map((tool) => tool.name),
      customTools: tools,
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
        await session.prompt(
          'Compute sum(prices) minus discount from input.json. Ask another eligible Team member to inspect the calculation with benchmark_delegate, then write answer.json and run fixture_verify. Report the observed result. This fixture requires no user decisions or additional work.',
          { expandPromptTemplates: false },
        );
        result.success =
          result.delegations > 0 &&
          verifications > 0 &&
          verifiedWrites === writes &&
          JSON.parse(readFileSync(output, 'utf8')).total === answer;
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
    rmSync(directory, { recursive: true, force: true });
  }
  return result;
}

/** Retry an unsuccessful off-thinking task once with low thinking on a fresh fixture. */
export async function runTask(
  input: Omit<Parameters<typeof runFixture>[0], 'thinking'> & {
    initialThinking?: BenchmarkThinking;
  },
): Promise<TaskResult> {
  const started = performance.now();
  const first = await runFixture({ ...input, thinking: input.initialThinking ?? 'off' });
  const attempts = [first];
  if (first.thinking === 'off' && !first.success)
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
    model = 'Spark-X2.6-4B-Q8',
    reportPath = 'guidance-benchmark.json',
    repetitionsText = '3',
    initialThinking = 'off',
  ] = process.argv.slice(2);
  if (!modelsPath || !provider)
    throw new Error(
      'Usage: bun tests/benchmarks/guidance.ts MODELS_JSON PROVIDER [MODEL] [REPORT_JSON] [REPETITIONS] [THINKING: off|low|high]',
    );
  const repetitions = Number(repetitionsText);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
    throw new Error('REPETITIONS must be 1..20');
  if (!['off', 'low', 'high'].includes(initialThinking))
    throw new Error('THINKING must be off, low, or high');
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
        'Benchmark model must use an existing Pi config with a loopback llama.cpp endpoint.',
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
            repetition,
            team,
            modelRuntime,
            provider,
            model,
            timeoutMs: 120_000,
            initialThinking: initialThinking as BenchmarkThinking,
          }),
        );
    }
    writeFileSync(
      resolve(reportPath),
      JSON.stringify(
        {
          team: team.definition.id,
          provider,
          model,
          initialThinking,
          retryPolicy: 'Retry failed off-thinking tasks once with low thinking on a fresh fixture',
          tokenSource:
            'Pi session statistics from provider usage; zero may mean unreported; no estimates',
          delegationSource: 'synthetic benchmark_delegate tool',
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

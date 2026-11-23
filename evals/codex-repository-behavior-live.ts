import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { sanitizeEvaluationText } from '../runtime/src/evals/diagnostics.js';
import { WorkspaceMcp } from '../runtime/src/integrations/mcp.js';
import { RuntimeApi } from '../runtime/src/integrations/runtime-api.js';
import { WORKSPACE_MCP_SERVER } from '../runtime/src/paseo-plugin/shared/workspace-tools.js';
import { createColgrepProvider } from '../runtime/src/repository/providers/colgrep.js';
import type { RepositoryRetrieval } from '../runtime/src/repository/results.js';
import { openRepositoryWorkspace } from '../runtime/src/repository/workspace.js';
import { createRepoLocateTool, REPO_LOCATE_TOOL_NAME } from '../runtime/src/tools/repo-locate.js';
import { createRepoSearchTool, REPO_SEARCH_TOOL_NAME } from '../runtime/src/tools/repo-search.js';
import type { ToolDefinition } from '../runtime/src/tools/types.js';
import {
  addVerifiedSourceLines,
  gradeRepositoryBehavior,
  RepositoryBehaviorAnswer,
  RepositoryCitation,
  searchesForCreditCardValidation,
  type ExpectedRepositoryFact,
} from './repository-behavior-grade.js';
import { firstVerifiedCitationMs, gradeRepositoryCitations } from './repository-citations.js';
import { repositoryFixturePaths, retrievalCorpus } from './repository-retrieval-fixtures.js';

const Answer = Type.Object(
  { answer: Type.String(), citations: Type.Array(RepositoryCitation) },
  { additionalProperties: false },
);

type SearchTool = ReturnType<typeof createRepoSearchTool>;
type LocateTool = ReturnType<typeof createRepoLocateTool>;
type SearchMode = NonNullable<Static<SearchTool['inputSchema']>['mode']>;
type SearchResult = Static<SearchTool['outputSchema']>;
type RepositoryToolName = typeof REPO_SEARCH_TOOL_NAME | typeof REPO_LOCATE_TOOL_NAME;
type Variant = 'search-only' | 'locate';
type RepositoryCall = {
  tool: RepositoryToolName;
  mode?: SearchMode;
  searches: { mode: SearchMode; result: SearchResult; relevantToNegative?: boolean }[];
  followUp?: Static<LocateTool['outputSchema']>['followUp'];
  started: number;
  finished?: number;
  requestKey?: string;
  resultBytes?: number;
  error?: string;
};
type BehaviorGrade = ReturnType<typeof gradeRepositoryBehavior>;
type NativeObservation = Pick<
  BehaviorGrade,
  'taskSuccess' | 'factualCorrectness' | 'evidenceValidity' | 'retrieval'
> & {
  variant: Variant;
  elapsedMs: number;
  operationalFailure: boolean;
  toolCalls: number;
  serializedResultBytes: number;
};

const citationInstructions =
  'Cite the smallest retrieved range that supports each claim, using workspace-relative paths and inclusive line ranges. If the retrieved evidence does not support an answer, return an empty answer and no citations.';
const instructions = `Call ${REPO_SEARCH_TOOL_NAME} before answering. Choose a search mode suited to the question. ${citationInstructions}`;
const locateInstructions = `Call ${REPO_LOCATE_TOOL_NAME} first. Use symbol for a known identifier or query for a conceptual question. Use ${REPO_SEARCH_TOOL_NAME} for additional evidence if needed. ${citationInstructions}`;

function autonomousPrompt(question: string, factFields: readonly string[]) {
  return [
    question,
    'Base your answer on the repository. Return one JSON object with keys outcome and facts.',
    'If supported, use outcome "answered" and return each requested fact with keys id, value, and citations.',
    'Each citation must have a workspace-relative path, startLine, and endLine (one-based and inclusive). Cite the smallest source ranges that directly support each fact. For file values, use the full workspace-relative path without a leading "./".',
    'If the material you reviewed offers no relevant support, use outcome "not-found" and facts []. If you cannot evaluate the question because your evidence is unavailable or insufficient, use outcome "insufficient-evidence" and facts [].',
    ...factFields,
  ].join('\n');
}

function describeRequest(
  input: unknown,
  search: SearchTool,
  locate: LocateTool,
  tool: RepositoryToolName,
) {
  if (tool === REPO_SEARCH_TOOL_NAME && Value.Check(search.inputSchema, input)) {
    const paths = (input.paths ?? []).toSorted();
    return {
      key: JSON.stringify([
        tool,
        input.mode ?? 'hybrid',
        input.query,
        input.pattern,
        paths,
        input.limit ?? 8,
      ]),
      workspaceWide: paths.every((scope) => scope === '.' || scope === 'fixture'),
      query: [input.query, input.pattern].filter(Boolean).join(' '),
    };
  }
  if (tool === REPO_LOCATE_TOOL_NAME && Value.Check(locate.inputSchema, input)) {
    const paths = (input.paths ?? []).toSorted();
    return {
      key: JSON.stringify([tool, input.symbol, input.query, paths]),
      workspaceWide: paths.every((scope) => scope === '.' || scope === 'fixture'),
      query: input.symbol ?? input.query ?? '',
    };
  }
}

function summarizeAutonomousCalls(
  observations: readonly RepositoryCall[],
  started: number,
  files: ReadonlyMap<string, string>,
) {
  const seenRequests = new Set<string>();
  const seenLines = new Set<string>();
  const uniqueSourceLines = new Map<RepositoryCall, number>();
  for (const call of observations.toSorted(
    (a, b) => (a.finished ?? Infinity) - (b.finished ?? Infinity),
  )) {
    const hits = call.searches.flatMap(({ result }) =>
      result.status === 'ready' ? (result.results ?? []) : [],
    );
    uniqueSourceLines.set(call, addVerifiedSourceLines(seenLines, hits, files));
  }
  return observations.map((call) => {
    const repeated = call.requestKey !== undefined && seenRequests.has(call.requestKey);
    if (call.requestKey !== undefined) seenRequests.add(call.requestKey);
    return {
      tool: call.tool,
      mode: call.mode,
      error: call.error,
      followUp: call.followUp,
      repeated,
      resultBytes: call.resultBytes ?? 0,
      newVerifiedSourceLines: uniqueSourceLines.get(call) ?? 0,
      startedMs: call.started - started,
      completedMs: call.finished === undefined ? undefined : call.finished - started,
      elapsedMs: call.finished === undefined ? undefined : call.finished - call.started,
      searches: call.searches.map(({ mode, result, relevantToNegative }) => ({
        ...summarizeSearch(mode, result),
        relevantToNegative,
      })),
    };
  });
}

function summarizeSearch(mode?: SearchMode, result?: SearchResult, error?: string) {
  return {
    mode,
    error,
    provider: result?.provider,
    status: result?.status,
    freshness: result?.freshness,
    partial: result?.partial,
    truncated: result?.truncated,
    hits: result?.results?.length ?? 0,
    diagnostics: result?.diagnostics.map(({ code }) => code),
  };
}

function summarizeNativeRuns(observations: readonly NativeObservation[]) {
  const variants: Variant[] = ['search-only', 'locate'];
  return Object.fromEntries(
    variants.map((variant) => {
      const runs = observations.filter((observation) => observation.variant === variant);
      const observed = runs.filter(({ operationalFailure }) => !operationalFailure);
      const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
      const mean = (values: number[]) => (values.length ? total(values) / values.length : null);
      const outcomes = <T extends string>(field: (run: NativeObservation) => T, states: T[]) =>
        Object.fromEntries(
          states.map((status) => [status, runs.filter((run) => field(run) === status).length]),
        );
      const labeledRanges = total(runs.map(({ retrieval }) => retrieval.expected));
      return [
        variant,
        {
          attempts: runs.length,
          operationalFailures: runs.length - observed.length,
          taskSuccess: outcomes(
            ({ taskSuccess }) => taskSuccess,
            ['passed', 'failed', 'unverified'],
          ),
          factualCorrectness: outcomes(
            ({ factualCorrectness }) => factualCorrectness,
            ['correct', 'incorrect', 'unverified'],
          ),
          evidenceValidity: outcomes(
            ({ evidenceValidity }) => evidenceValidity,
            ['valid', 'invalid', 'unverified'],
          ),
          coveredRanges: total(runs.map(({ retrieval }) => retrieval.covered)),
          labeledRanges,
          meanElapsedMs: mean(observed.map(({ elapsedMs }) => elapsedMs)),
          meanToolCalls: mean(observed.map(({ toolCalls }) => toolCalls)),
          meanSerializedResultBytes: mean(
            observed.map(({ serializedResultBytes }) => serializedResultBytes),
          ),
        },
      ];
    }),
  );
}

async function loopbackAuthority(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port.');
  return `127.0.0.1:${address.port}`;
}

function codexEnvironment(token: string): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|XDG_[A-Z_]+|CODEX_HOME|OPENAI_API_KEY|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_(FILE|DIR)|TMPDIR)$/i.test(
          key,
        ),
    ),
  ) as Record<string, string>;
  return { ...environment, LTCOOK_REPOSITORY_EVAL_TOKEN: token, DO_NOT_TRACK: '1' };
}

async function evaluateWithCodex(
  executable: string,
  model: string | undefined,
  workspace: string,
  directory: string,
  endpoint: string,
  token: string,
  prompt: string,
  signal: AbortSignal,
  variant?: Variant,
) {
  const answerPath = path.join(directory, 'answer.json');
  const schemaPath = path.join(directory, 'answer-schema.json');
  await writeFile(schemaPath, JSON.stringify(autonomous ? RepositoryBehaviorAnswer : Answer));
  const server = `mcp_servers.${WORKSPACE_MCP_SERVER}`;
  const enabledTools = [
    REPO_SEARCH_TOOL_NAME,
    ...(variant === 'locate' ? [REPO_LOCATE_TOOL_NAME] : []),
  ];
  const started = performance.now();
  const child = Bun.spawn(
    [
      executable,
      '-a',
      'never',
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--disable',
      'shell_tool',
      '-c',
      `${server}.url=${JSON.stringify(`${endpoint}/mcp`)}`,
      '-c',
      `${server}.bearer_token_env_var="LTCOOK_REPOSITORY_EVAL_TOKEN"`,
      '-c',
      `${server}.required=true`,
      '-c',
      `${server}.tool_timeout_sec=125`,
      ...enabledTools.flatMap((tool) => ['-c', `${server}.tools.${tool}.approval_mode="approve"`]),
      ...(variant ? ['-c', `${server}.enabled_tools=${JSON.stringify(enabledTools)}`] : []),
      '--output-schema',
      schemaPath,
      '--output-last-message',
      answerPath,
      ...(model ? ['--model', model] : []),
      prompt,
    ],
    {
      cwd: workspace,
      env: codexEnvironment(token),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      signal: AbortSignal.any([signal, AbortSignal.timeout(150_000)]),
    },
  );
  const [exitCode, diagnostics] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  signal.throwIfAborted();
  const observedModel = /^model:\s*([\w./-]+)\s*$/m.exec(diagnostics)?.[1] ?? null;
  const answer: unknown = await readFile(answerPath, 'utf8')
    .then(JSON.parse)
    .catch(() => undefined);
  const error =
    exitCode === 0
      ? undefined
      : diagnostics.split('\n').findLast((line) => line.startsWith('ERROR:'));
  return {
    started,
    elapsedMs: performance.now() - started,
    exitCode,
    observedModel,
    answer,
    ...(error
      ? {
          error: sanitizeEvaluationText(
            error.replaceAll(token, '<redacted>').replaceAll(directory, '<fixture>'),
          ),
        }
      : {}),
  };
}

const {
  values: {
    model: requestedModel,
    'compare-locate': compareLocate,
    autonomous,
    pi,
    case: selectedCase,
  },
} = parseArgs({
  options: {
    model: { type: 'string' },
    'compare-locate': { type: 'boolean' },
    autonomous: { type: 'boolean' },
    pi: { type: 'boolean' },
    case: { type: 'string' },
  },
});
if (autonomous && compareLocate)
  throw new Error('Choose either --autonomous or the guided --compare-locate.');
if (pi && !autonomous) throw new Error('--pi requires --autonomous.');
if (selectedCase !== undefined && !autonomous) throw new Error('--case requires --autonomous.');
const paired = compareLocate || autonomous;
const model = requestedModel ?? (paired && !pi ? 'gpt-6.2-sol' : undefined);
const executable = pi ? undefined : (Bun.which('codex') ?? undefined);
const ripgrep = Bun.which('rg');
const deploymentDirectory = process.env.LTCOOK_COLGREP_DEPLOYMENT;
if ((!pi && !executable) || !ripgrep || !deploymentDirectory)
  throw new Error(
    'Repository Behavior Evaluation needs ripgrep, installed LTCOOK_COLGREP_DEPLOYMENT assets, and the selected native agent.',
  );

const piEvaluation = pi ? await import('./repository-behavior-pi.js') : undefined;
const checkout = path.resolve(import.meta.dir, '..');
const referenceSources = new Map(
  await Promise.all(
    repositoryFixturePaths.map(
      async (relative) =>
        [relative, await readFile(path.join(checkout, relative), 'utf8')] as const,
    ),
  ),
);
const corpus = retrievalCorpus(referenceSources);
const files = [...corpus.files].filter(([relative]) => relative.startsWith('fixture/'));
const cases = [
  {
    id: 'definition-caller-test',
    prompt:
      'Where is `allocateTicket` defined, which production code calls it, and where does a test check rejection of a repeated claim?',
    autonomousQuestion:
      'Which file defines allocateTicket, which production file calls it, and what boolean does the repeated-claim test expect?',
    facts: [
      { id: 'definitionFile', value: 'fixture/src/ledger.ts', evidenceIndex: 0 },
      { id: 'callerFile', value: 'fixture/src/cart.ts', evidenceIndex: 1 },
      { id: 'repeatedClaimResult', value: false, evidenceIndex: 2 },
    ],
  },
  {
    id: 'absent-concept',
    prompt: 'Where does this repository validate credit card checksums?',
    autonomousQuestion:
      'Does this repository validate credit card checksums? If it does, give the implementation file.',
    facts: [],
  },
] as const;
const conceptualCase = {
  id: 'color-bounds',
  prompt: 'Where is a pixel intensity constrained to the legal eight-bit interval?',
  autonomousQuestion:
    'Which lower and upper numeric bounds does the implementation use when clamping a pixel intensity?',
  facts: [
    { id: 'lowerBound', value: 0, evidenceIndex: 0 },
    { id: 'upperBound', value: 255, evidenceIndex: 0 },
  ],
} as const;
const scenarios = (paired ? [cases[0], conceptualCase, cases[1]] : cases).map((scenario) => {
  const question = corpus.questions.find(({ id }) => id === scenario.id);
  if (!question) throw new Error(`No fixture evidence labels for ${scenario.id}.`);
  const expectedFacts: ExpectedRepositoryFact[] = scenario.facts.map(
    ({ id, value, evidenceIndex }) => {
      const evidence = question.expected[evidenceIndex];
      if (!evidence) throw new Error(`No fact evidence label for ${scenario.id}/${id}.`);
      return { id, value, evidence };
    },
  );
  const taskPrompt = autonomousPrompt(
    scenario.autonomousQuestion,
    expectedFacts.length
      ? expectedFacts.map(
          ({ id, value }) => `For an answer, include "${id}" with a ${typeof value} value.`,
        )
      : ['If there is an implementation, include "implementationFile" with a string value.'],
  );
  return { ...scenario, question, expectedFacts, taskPrompt };
});
const schedule: {
  scenario: (typeof scenarios)[number];
  caseId: string;
  repetition: number;
  searchFirst: boolean;
  unavailable: boolean;
}[] = scenarios.map((scenario, index) => ({
  scenario,
  caseId: scenario.id,
  repetition: 1,
  searchFirst: index % 2 === 0,
  unavailable: false,
}));
if (autonomous) {
  const conceptual = schedule.find(({ scenario }) => scenario.id === conceptualCase.id);
  if (!conceptual) throw new Error('No conceptual case for the reversed pair.');
  schedule.push({ ...conceptual, repetition: 2, searchFirst: !conceptual.searchFirst });
  schedule.push({
    ...conceptual,
    caseId: 'color-bounds-unavailable',
    unavailable: true,
    searchFirst: !conceptual.searchFirst,
  });
}
const selectedSchedule =
  selectedCase === undefined ? schedule : schedule.filter(({ caseId }) => caseId === selectedCase);
if (!selectedSchedule.length) throw new Error('Unknown autonomous evaluation case.');
const runs = selectedSchedule.flatMap(
  ({ scenario, caseId, repetition, searchFirst, unavailable }) => {
    const variants: readonly (Variant | undefined)[] = !paired
      ? [undefined]
      : searchFirst
        ? ['search-only', 'locate']
        : ['locate', 'search-only'];
    return variants.map((variant, order) => ({
      scenario,
      caseId,
      variant,
      repetition,
      order: order + 1,
      unavailable,
    }));
  },
);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ltcook-codex-retrieval-')));
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
let api: RuntimeApi | undefined;

try {
  const piModel = await piEvaluation?.repositoryPiModel(model, controller.signal);
  const workspace = path.join(root, 'source');
  for (const [relative, source] of files) {
    const file = path.join(workspace, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
  }
  const colgrep = createColgrepProvider({
    deploymentDirectory,
    cacheDirectory: path.join(root, 'cache'),
  });
  const comparison = paired
    ? {
        colgrepIndexBuildMs: await colgrep.buildIndex(
          await openRepositoryWorkspace(workspace),
          controller.signal,
        ),
        colgrepAssetsSha256: createHash('sha256')
          .update(await readFile(path.join(deploymentDirectory, 'assets.json')))
          .digest('hex'),
      }
    : undefined;
  const search = createRepoSearchTool(colgrep);
  const locate = createRepoLocateTool(search);
  const unavailableSearch =
    (provider: string, kind: RepositoryRetrieval['value']['kind']) =>
    async (): Promise<RepositoryRetrieval> => ({
      provider,
      value: { kind, status: 'unavailable', hits: [] },
      diagnostics: [
        {
          source: 'evaluation',
          code: 'fixture-unavailable',
          message: 'Repository source evidence is unavailable in this evaluation case.',
        },
      ],
      capturedAt: new Date().toISOString(),
      freshness: 'unknown',
      partial: false,
      truncated: false,
    });
  const blockedSearch = createRepoSearchTool(
    { ...colgrep, search: unavailableSearch('colgrep', 'ranked') },
    { search: unavailableSearch('ripgrep', 'exhaustive') },
  );
  const blockedLocate = createRepoLocateTool(blockedSearch);
  const blockedTools = new Map<string, ToolDefinition>([
    [blockedSearch.name, blockedSearch],
    [blockedLocate.name, blockedLocate],
  ]);
  const blockedAgents = new Set<string>();
  const calls = new Map<string, RepositoryCall[]>();
  const observeTool = (tool: ToolDefinition, name: RepositoryToolName): ToolDefinition => ({
    ...tool,
    async invoke(input, context) {
      const mode =
        name === REPO_SEARCH_TOOL_NAME && Value.Check(search.inputSchema, input)
          ? (input.mode ?? 'hybrid')
          : undefined;
      const observations = calls.get(context.agentId);
      if (!observations || (!paired && !mode)) return tool.invoke(input, context);
      const request = autonomous ? describeRequest(input, search, locate, name) : undefined;
      const call: RepositoryCall = {
        tool: name,
        mode,
        searches: [],
        started: performance.now(),
        requestKey: request?.key,
      };
      observations.push(call);
      try {
        const active = blockedAgents.has(context.agentId) ? blockedTools.get(name) : tool;
        if (!active) throw new Error('Missing fixture tool.');
        const result = await active.invoke(input, context);
        if (autonomous) call.resultBytes = Buffer.byteLength(JSON.stringify(result));
        if (name === REPO_LOCATE_TOOL_NAME && Value.Check(locate.outputSchema, result)) {
          call.followUp = result.followUp;
          call.searches = result.searches.map((entry) => ({
            mode: entry.mode,
            result: entry,
            relevantToNegative:
              request?.workspaceWide && searchesForCreditCardValidation(entry.query),
          }));
        } else if (mode && Value.Check(search.outputSchema, result)) {
          call.searches = [
            {
              mode,
              result,
              relevantToNegative:
                request?.workspaceWide && searchesForCreditCardValidation(request.query),
            },
          ];
        }
        return result;
      } catch (error) {
        if (error instanceof Error)
          call.error = sanitizeEvaluationText(error.message.replaceAll(workspace, '<workspace>'));
        throw error;
      } finally {
        call.finished = performance.now();
      }
    },
  });
  const toolDefinitions = [
    observeTool(search, REPO_SEARCH_TOOL_NAME),
    ...(paired ? [observeTool(locate, REPO_LOCATE_TOOL_NAME)] : []),
  ];
  let mcp: WorkspaceMcp | undefined;
  let endpoint: string | undefined;
  if (!piEvaluation) {
    const authority = await loopbackAuthority();
    api = new RuntimeApi(undefined, randomBytes(32).toString('base64url'), authority);
    mcp = new WorkspaceMcp(toolDefinitions, authority);
    api.setWorkspaceMcp(mcp);
    endpoint = await api.listen();
  }
  async function runOnFixture(
    id: string,
    directory: string,
    prompt: string,
    variant: Variant | undefined,
  ) {
    if (piEvaluation) {
      return piEvaluation.evaluateRepositoryWithPi({
        model: piModel?.name,
        workspace,
        directory,
        agentId: id,
        prompt,
        tools: toolDefinitions.filter(
          ({ name }) => variant === 'locate' || name === REPO_SEARCH_TOOL_NAME,
        ),
        signal: controller.signal,
      });
    }
    if (!mcp || !endpoint || !executable)
      throw new Error('The fixture MCP runtime is unavailable.');
    // > The evaluator owns and populates this synthetic workspace, and grants only its files.
    const token = await mcp.grant(id, workspace, false, true);
    try {
      return await evaluateWithCodex(
        executable,
        model,
        workspace,
        directory,
        endpoint,
        token,
        prompt,
        controller.signal,
        variant,
      );
    } finally {
      await mcp.revoke(id);
    }
  }
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const outcomes = [];
  const nativeObservations: NativeObservation[] = [];
  let runFailed = false;
  for (const { scenario, caseId, variant, order, repetition, unavailable } of runs) {
    const { expected, group } = scenario.question;
    const name = variant ? `${caseId}-${variant}` : caseId;
    const id = repetition === 1 ? name : `${name}-repeat-${repetition}`;
    console.error(`Running ${pi ? 'Pi' : 'Codex'} Behavior Evaluation for ${id}`);
    const directory = path.join(root, id);
    await mkdir(directory);
    const observations: RepositoryCall[] = [];
    calls.set(id, observations);
    if (unavailable) blockedAgents.add(id);
    const prompt = autonomous
      ? scenario.taskPrompt
      : `${scenario.prompt}\n${variant === 'locate' ? locateInstructions : instructions}`;
    const run = await runOnFixture(id, directory, prompt, variant);
    calls.delete(id);
    blockedAgents.delete(id);
    const searches = observations.flatMap(({ searches: entries }) => entries);
    const isReadyInExpectedMode = ({ mode, result }: RepositoryCall['searches'][number]) =>
      result.status === 'ready' &&
      (group === 'lexical'
        ? mode === 'exact' && result.provider === 'ripgrep'
        : (mode === 'hybrid' || mode === 'semantic') && result.provider === 'colgrep');
    const correctMode = searches.some(isReadyInExpectedMode);
    const firstCall = observations[0];
    const firstSearch = firstCall?.searches[0];
    const usedLocateFirst =
      firstCall?.tool === REPO_LOCATE_TOOL_NAME &&
      firstSearch !== undefined &&
      isReadyInExpectedMode(firstSearch);
    const { answer: rawAnswer, started: turnStarted, ...execution } = run;
    const replies = observations.flatMap(({ finished, searches }) =>
      finished === undefined
        ? []
        : [
            {
              elapsedMs: finished - turnStarted,
              hits: searches.flatMap(({ result }) =>
                result.status === 'ready' ? (result.results ?? []) : [],
              ),
            },
          ],
    );
    if (autonomous) {
      const answer = Value.Check(RepositoryBehaviorAnswer, rawAnswer) ? rawAnswer : undefined;
      const grading = gradeRepositoryBehavior({
        answer,
        expected: scenario.expectedFacts,
        searches: searches.map(({ result, relevantToNegative }) => ({
          ...result,
          relevantToNegative,
        })),
        files: corpus.files,
      });
      const toolCalls = summarizeAutonomousCalls(observations, turnStarted, corpus.files);
      const firstSupport = scenario.expectedFacts.flatMap(({ id, value, evidence }) => {
        const citations =
          answer?.facts
            .filter((fact) => fact.id === id && fact.value === value)
            .flatMap((fact) => fact.citations) ?? [];
        const elapsed = firstVerifiedCitationMs(citations, [evidence], replies, corpus.files);
        return elapsed === null ? [] : [elapsed];
      });
      const operationalFailure = run.exitCode !== 0 || grading.retrieval.invalidEvidence > 0;
      const taskSuccess = run.exitCode !== 0 ? 'unverified' : grading.taskSuccess;
      const serializedResultBytes = toolCalls.reduce(
        (sum, { resultBytes }) => sum + resultBytes,
        0,
      );
      runFailed ||= operationalFailure;
      if (!unavailable && variant) {
        nativeObservations.push({
          ...grading,
          variant,
          taskSuccess,
          elapsedMs: execution.elapsedMs,
          operationalFailure,
          toolCalls: toolCalls.length,
          serializedResultBytes,
        });
      }
      outcomes.push({
        id: caseId,
        retrievalCondition: unavailable ? 'fixture-unavailable' : 'native',
        variant,
        repetition,
        order,
        ...execution,
        ...grading,
        taskSuccess,
        operationalFailure,
        answerSchemaValid: answer !== undefined,
        unavailableHandling:
          unavailable && searches.some(({ result }) => result.status === 'unavailable')
            ? answer?.outcome === 'insufficient-evidence' && !answer.facts.length
              ? 'appropriate'
              : 'inappropriate'
            : null,
        firstVerifiedCitationMs: firstSupport.length ? Math.min(...firstSupport) : null,
        toolSelection: {
          expectedModeObserved: correctMode,
          firstTool: firstCall?.tool ?? null,
          locateUsed: observations.some(({ tool }) => tool === REPO_LOCATE_TOOL_NAME),
          locateFirstWithExpectedMode: usedLocateFirst,
        },
        toolMetrics: {
          calls: toolCalls.length,
          repeatedCalls: toolCalls.filter(({ repeated }) => repeated).length,
          callsWithoutNewVerifiedLines: toolCalls.filter(
            ({ newVerifiedSourceLines }) => !newVerifiedSourceLines,
          ).length,
          serializedResultBytes,
          totalToolElapsedMs: toolCalls.reduce((sum, { elapsedMs }) => sum + (elapsedMs ?? 0), 0),
        },
        toolCalls,
      });
      continue;
    }
    const answer = Value.Check(Answer, rawAnswer) ? rawAnswer : undefined;
    const hits = searches.flatMap(({ result }) => result.results ?? []);
    const citations = answer?.citations ?? [];
    const { supported, unsupported, missing } = gradeRepositoryCitations(
      citations,
      expected,
      hits,
      corpus.files,
    );
    const abstained = answer?.answer.trim() === '' && citations.length === 0;
    const passed =
      run.exitCode === 0 &&
      correctMode &&
      (variant !== 'locate' || usedLocateFirst) &&
      Boolean(answer) &&
      (expected.length
        ? !abstained && Boolean(answer?.answer.trim()) && !missing.length && !unsupported.length
        : abstained);
    runFailed ||= !passed;
    outcomes.push({
      id: scenario.id,
      ...execution,
      passed,
      correctMode,
      abstained,
      missing,
      unsupportedCitations: unsupported,
      citations: supported,
      ...(variant
        ? {
            variant,
            ...(variant === 'locate' ? { usedLocateFirst } : {}),
            toolCallCount: observations.length,
            citationCoverage: {
              expected: expected.length,
              supported: expected.length - missing.length,
            },
            firstVerifiedCitationMs: firstVerifiedCitationMs(
              citations,
              expected,
              replies,
              corpus.files,
            ),
          }
        : {}),
      toolCalls: variant
        ? observations.map((call) => ({
            tool: call.tool,
            mode: call.mode,
            error: call.error,
            followUp: call.followUp,
            startedMs: call.started - turnStarted,
            completedMs: call.finished === undefined ? undefined : call.finished - turnStarted,
            searches: call.searches.map(({ mode, result }) => summarizeSearch(mode, result)),
          }))
        : observations.map((call) =>
            summarizeSearch(call.mode, call.searches[0]?.result, call.error),
          ),
    });
  }
  const fixtureSha256 = createHash('sha256')
    .update(
      JSON.stringify(
        autonomous
          ? { files, runs }
          : compareLocate
            ? {
                files,
                runs: runs.map(({ scenario: { id, prompt, question }, variant }) => ({
                  scenario: { id, prompt, question },
                  variant,
                })),
                instructions,
                locateInstructions,
              }
            : { files, cases: cases.map(({ id, prompt }) => ({ id, prompt })), instructions },
      ),
    )
    .digest('hex');
  const provenance = autonomous
    ? await autonomousProvenance(checkout, executable, ripgrep)
    : undefined;
  console.log(
    JSON.stringify(
      {
        schemaVersion: autonomous ? 2 : 1,
        runId,
        startedAt,
        evaluation: 'Behavior Evaluation',
        setup: 'synthetic',
        model: piModel?.name ?? model ?? null,
        ...(comparison ? { comparison } : {}),
        ...(autonomous
          ? {
              design: 'autonomous',
              agent: pi ? 'pi' : 'codex',
              provenance: { ...provenance, ...(piModel ? { piModel } : {}) },
              nativeSummary: summarizeNativeRuns(nativeObservations),
            }
          : {}),
        fixtureSha256,
        cases: outcomes,
      },
      null,
      2,
    ),
  );
  if (runFailed) process.exitCode = 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
  await api?.close();
  await rm(root, { recursive: true, force: true });
}

async function autonomousProvenance(checkout: string, codex: string | undefined, rg: string) {
  const files = [
    'bun.lock',
    'evals/codex-repository-behavior-live.ts',
    'evals/repository-behavior-grade.ts',
    'evals/repository-behavior-pi.ts',
    'evals/repository-citations.ts',
    'evals/repository-retrieval.ts',
    'runtime/src/evals/summarization-decision.ts',
    'runtime/src/integrations/mcp.ts',
    'runtime/src/repository/evidence.ts',
    'runtime/src/repository/providers/colgrep.ts',
    'runtime/src/repository/providers/ripgrep.ts',
    'runtime/src/tools/repo-locate.ts',
    'runtime/src/tools/repo-search.ts',
  ];
  const readCommandLine = (args: string[]) => {
    const result = Bun.spawnSync(args, { cwd: checkout, stderr: 'ignore', timeout: 5000 });
    return result.exitCode === 0 ? (result.stdout.toString().split('\n')[0]?.trim() ?? null) : null;
  };
  const implementation = await Promise.all(
    files.map(async (file) => [file, await readFile(path.join(checkout, file), 'utf8')]),
  );
  return {
    repositoryRevision: Bun.which('git') ? readCommandLine(['git', 'rev-parse', 'HEAD']) : null,
    implementationSha256: createHash('sha256').update(JSON.stringify(implementation)).digest('hex'),
    platform: process.platform,
    architecture: process.arch,
    bunVersion: Bun.version,
    ripgrepVersion: readCommandLine([rg, '--version']),
    codexVersion: codex ? readCommandLine([codex, '--version']) : null,
    indexState: 'warm-shared-snapshot',
  };
}

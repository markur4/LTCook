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
import { openRepositoryWorkspace } from '../runtime/src/repository/workspace.js';
import { createRepoLocateTool, REPO_LOCATE_TOOL_NAME } from '../runtime/src/tools/repo-locate.js';
import { createRepoSearchTool, REPO_SEARCH_TOOL_NAME } from '../runtime/src/tools/repo-search.js';
import type { ToolDefinition } from '../runtime/src/tools/types.js';
import { firstVerifiedCitationMs, gradeRepositoryCitations } from './repository-citations.js';
import { repositoryFixturePaths, retrievalCorpus } from './repository-retrieval-fixtures.js';

const Citation = Type.Object(
  { path: Type.String(), startLine: Type.Integer(), endLine: Type.Integer() },
  { additionalProperties: false },
);
const Answer = Type.Object(
  { answer: Type.String(), citations: Type.Array(Citation) },
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
  searches: { mode: SearchMode; result: SearchResult }[];
  followUp?: Static<LocateTool['outputSchema']>['followUp'];
  started: number;
  finished?: number;
  error?: string;
};

const citationInstructions =
  'Cite the smallest retrieved range that supports each claim, using workspace-relative paths and inclusive line ranges. If the retrieved evidence does not support an answer, return an empty answer and no citations.';
const instructions = `Call ${REPO_SEARCH_TOOL_NAME} before answering. Choose a search mode suited to the question. ${citationInstructions}`;
const locateInstructions = `Call ${REPO_LOCATE_TOOL_NAME} first. Use symbol for a known identifier or query for a conceptual question. Use ${REPO_SEARCH_TOOL_NAME} for additional evidence if needed. ${citationInstructions}`;

function summarizeSearch(mode?: SearchMode, result?: SearchResult, error?: string) {
  return {
    mode,
    error,
    provider: result?.provider,
    status: result?.status,
    partial: result?.partial,
    truncated: result?.truncated,
    hits: result?.results?.length ?? 0,
    diagnostics: result?.diagnostics.map(({ code }) => code),
  };
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

async function evaluate(
  executable: string,
  model: string | undefined,
  workspace: string,
  directory: string,
  endpoint: string,
  token: string,
  question: string,
  signal: AbortSignal,
  variant?: Variant,
) {
  const answerPath = path.join(directory, 'answer.json');
  const schemaPath = path.join(directory, 'answer-schema.json');
  await writeFile(schemaPath, JSON.stringify(Answer));
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
      `${question}\n${variant === 'locate' ? locateInstructions : instructions}`,
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
  const raw: unknown = await readFile(answerPath, 'utf8')
    .then(JSON.parse)
    .catch(() => undefined);
  const answer = Value.Check(Answer, raw) ? raw : undefined;
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
  values: { model: requestedModel, 'compare-locate': compareLocate },
} = parseArgs({ options: { model: { type: 'string' }, 'compare-locate': { type: 'boolean' } } });
const model = requestedModel ?? (compareLocate ? 'gpt-6.2-sol' : undefined);
const executable = Bun.which('codex');
const deploymentDirectory = process.env.LTCOOK_COLGREP_DEPLOYMENT;
if (!executable || !Bun.which('rg') || !deploymentDirectory)
  throw new Error(
    'The Codex Behavior Evaluation needs Codex, ripgrep, and installed LTCOOK_COLGREP_DEPLOYMENT assets.',
  );

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
  },
  { id: 'absent-concept', prompt: 'Where does this repository validate credit card checksums?' },
] as const;
const conceptualCase = {
  id: 'color-bounds',
  prompt: 'Where is a pixel intensity constrained to the legal eight-bit interval?',
};
const scenarios = (compareLocate ? [cases[0], conceptualCase, cases[1]] : cases).map((scenario) => {
  const question = corpus.questions.find(({ id }) => id === scenario.id);
  if (!question) throw new Error(`No fixture evidence labels for ${scenario.id}.`);
  return { ...scenario, question };
});
const runs = scenarios.flatMap((scenario, index) => {
  const variants: readonly (Variant | undefined)[] = !compareLocate
    ? [undefined]
    : index % 2 === 0
      ? ['search-only', 'locate']
      : ['locate', 'search-only'];
  return variants.map((variant) => ({ scenario, variant }));
});
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ltcook-codex-retrieval-')));
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
let api: RuntimeApi | undefined;

try {
  const workspace = path.join(root, 'source');
  for (const [relative, source] of files) {
    const file = path.join(workspace, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, source);
  }
  const authority = await loopbackAuthority();
  const secret = randomBytes(32).toString('base64url');
  api = new RuntimeApi(undefined, secret, authority);
  const colgrep = createColgrepProvider({
    deploymentDirectory,
    cacheDirectory: path.join(root, 'cache'),
  });
  const comparison = compareLocate
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
  const calls = new Map<string, RepositoryCall[]>();
  const observeTool = (tool: ToolDefinition, name: RepositoryToolName): ToolDefinition => ({
    ...tool,
    async invoke(input, context) {
      const mode =
        name === REPO_SEARCH_TOOL_NAME && Value.Check(search.inputSchema, input)
          ? (input.mode ?? 'hybrid')
          : undefined;
      const observations = calls.get(context.agentId);
      if (!observations || (!compareLocate && !mode)) return tool.invoke(input, context);
      const call: RepositoryCall = { tool: name, mode, searches: [], started: performance.now() };
      observations.push(call);
      try {
        const result = await tool.invoke(input, context);
        if (name === REPO_LOCATE_TOOL_NAME && Value.Check(locate.outputSchema, result)) {
          call.followUp = result.followUp;
          call.searches = result.searches.map((entry) => ({ mode: entry.mode, result: entry }));
        } else if (mode && Value.Check(search.outputSchema, result)) {
          call.searches = [{ mode, result }];
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
  const mcp = new WorkspaceMcp(
    [
      observeTool(search, REPO_SEARCH_TOOL_NAME),
      ...(compareLocate ? [observeTool(locate, REPO_LOCATE_TOOL_NAME)] : []),
    ],
    authority,
  );
  api.setWorkspaceMcp(mcp);
  const endpoint = await api.listen();
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const outcomes = [];
  for (const { scenario, variant } of runs) {
    const { expected, group } = scenario.question;
    const id = variant ? `${scenario.id}-${variant}` : scenario.id;
    console.error(`Running Codex Behavior Evaluation for ${id}`);
    const directory = path.join(root, id);
    await mkdir(directory);
    const response = await fetch(`${endpoint}/v1/mcp/grant`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        nativeAgentId: id,
        workspaceRoot: workspace,
        provider: 'codex',
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Codex fixture grant failed with HTTP ${response.status}.`);
    const grant: unknown = await response.json();
    if (!Value.Check(Type.Object({ token: Type.String() }), grant))
      throw new Error('Invalid Codex fixture grant.');
    const observations: RepositoryCall[] = [];
    calls.set(id, observations);
    const run = await evaluate(
      executable,
      model,
      workspace,
      directory,
      endpoint,
      grant.token,
      scenario.prompt,
      controller.signal,
      variant,
    );
    await mcp.revoke(id);
    calls.delete(id);
    const searches = observations.flatMap(({ searches: entries }) => entries);
    const hits = searches.flatMap(({ result }) => result.results ?? []);
    const citations = run.answer?.citations ?? [];
    const { supported, unsupported, missing } = gradeRepositoryCitations(
      citations,
      expected,
      hits,
      corpus.files,
    );
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
    const abstained = run.answer?.answer.trim() === '' && citations.length === 0;
    const passed =
      run.exitCode === 0 &&
      correctMode &&
      (variant !== 'locate' || usedLocateFirst) &&
      Boolean(run.answer) &&
      (expected.length
        ? !abstained && Boolean(run.answer?.answer.trim()) && !missing.length && !unsupported.length
        : abstained);
    const { answer: _answer, started: turnStarted, ...execution } = run;
    const replies = observations.flatMap(({ finished, searches }) =>
      finished === undefined
        ? []
        : [
            {
              elapsedMs: finished - turnStarted,
              hits: searches.flatMap(({ result }) => result.results ?? []),
            },
          ],
    );
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
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        startedAt,
        evaluation: 'Behavior Evaluation',
        setup: 'synthetic',
        model: model ?? null,
        ...(comparison ? { comparison } : {}),
        fixtureSha256: createHash('sha256')
          .update(
            JSON.stringify(
              compareLocate
                ? { files, runs, instructions, locateInstructions }
                : { files, cases, instructions },
            ),
          )
          .digest('hex'),
        cases: outcomes,
      },
      null,
      2,
    ),
  );
  if (outcomes.some(({ passed }) => !passed)) process.exitCode = 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
  await api?.close();
  await rm(root, { recursive: true, force: true });
}

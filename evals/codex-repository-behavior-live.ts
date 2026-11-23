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
import { createRepoSearchTool, REPO_SEARCH_TOOL_NAME } from '../runtime/src/tools/repo-search.js';
import { gradeRepositoryCitations } from './repository-citations.js';
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
type SearchCall = {
  mode: NonNullable<Static<SearchTool['inputSchema']>['mode']>;
  result?: Static<SearchTool['outputSchema']>;
  error?: string;
};

const instructions = `Call ${REPO_SEARCH_TOOL_NAME} before answering. Choose a search mode suited to the question. Cite the smallest retrieved range that supports each claim, using workspace-relative paths and inclusive line ranges. If the retrieved evidence does not support an answer, return an empty answer and no citations.`;

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
) {
  const answerPath = path.join(directory, 'answer.json');
  const schemaPath = path.join(directory, 'answer-schema.json');
  await writeFile(schemaPath, JSON.stringify(Answer));
  const server = `mcp_servers.${WORKSPACE_MCP_SERVER}`;
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
      '-c',
      `${server}.tools.${REPO_SEARCH_TOOL_NAME}.approval_mode="approve"`,
      '--output-schema',
      schemaPath,
      '--output-last-message',
      answerPath,
      ...(model ? ['--model', model] : []),
      `${question}\n${instructions}`,
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
  values: { model },
} = parseArgs({ options: { model: { type: 'string' } } });
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
  const search = createRepoSearchTool(
    createColgrepProvider({ deploymentDirectory, cacheDirectory: path.join(root, 'cache') }),
  );
  const calls: SearchCall[] = [];
  const mcp = new WorkspaceMcp(
    [
      {
        ...search,
        async invoke(input, context) {
          if (!Value.Check(search.inputSchema, input)) return search.invoke(input, context);
          const call: SearchCall = { mode: input.mode ?? 'hybrid' };
          calls.push(call);
          try {
            const result = await search.invoke(input, context);
            if (Value.Check(search.outputSchema, result)) call.result = result;
            return result;
          } catch (error) {
            if (error instanceof Error)
              call.error = sanitizeEvaluationText(
                error.message.replaceAll(workspace, '<workspace>'),
              );
            throw error;
          }
        },
      },
    ],
    authority,
  );
  api.setWorkspaceMcp(mcp);
  const endpoint = await api.listen();
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const outcomes = [];
  for (const scenario of cases) {
    const { expected } = corpus.questions.find(({ id }) => id === scenario.id)!;
    console.error(`Running Codex Behavior Evaluation for ${scenario.id}`);
    const directory = path.join(root, scenario.id);
    await mkdir(directory);
    const response = await fetch(`${endpoint}/v1/mcp/grant`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        nativeAgentId: scenario.id,
        workspaceRoot: workspace,
        provider: 'codex',
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Codex fixture grant failed with HTTP ${response.status}.`);
    const grant: unknown = await response.json();
    if (!Value.Check(Type.Object({ token: Type.String() }), grant))
      throw new Error('Invalid Codex fixture grant.');
    const run = await evaluate(
      executable,
      model,
      workspace,
      directory,
      endpoint,
      grant.token,
      scenario.prompt,
      controller.signal,
    );
    await mcp.revoke(scenario.id);
    const observations = calls.splice(0);
    const hits = observations.flatMap(({ result }) => result?.results ?? []);
    const citations = run.answer?.citations ?? [];
    const { supported, unsupported, missing } = gradeRepositoryCitations(
      citations,
      expected,
      hits,
      corpus.files,
    );
    const correctMode = observations.some(
      ({ mode, result }) =>
        result?.status === 'ready' &&
        (expected.length
          ? mode === 'exact' && result.provider === 'ripgrep'
          : (mode === 'hybrid' || mode === 'semantic') && result.provider === 'colgrep'),
    );
    const abstained = run.answer?.answer.trim() === '' && citations.length === 0;
    const passed =
      run.exitCode === 0 &&
      correctMode &&
      Boolean(run.answer) &&
      (expected.length
        ? !abstained && Boolean(run.answer?.answer.trim()) && !missing.length && !unsupported.length
        : abstained);
    const { answer: _answer, ...execution } = run;
    outcomes.push({
      id: scenario.id,
      ...execution,
      passed,
      correctMode,
      abstained,
      missing,
      unsupportedCitations: unsupported,
      citations: supported,
      toolCalls: observations.map(({ mode, result, error }) => ({
        mode,
        error,
        provider: result?.provider,
        status: result?.status,
        partial: result?.partial,
        truncated: result?.truncated,
        hits: result?.results?.length ?? 0,
        diagnostics: result?.diagnostics.map(({ code }) => code),
      })),
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
        fixtureSha256: createHash('sha256')
          .update(JSON.stringify({ files, cases, instructions }))
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

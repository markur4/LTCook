import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  findRepositoryExecutable,
  runRepositoryCommand,
} from '../runtime/src/repository/process.js';
import {
  COLGREP_MAX_RESULTS,
  createColgrepProvider,
} from '../runtime/src/repository/providers/colgrep.js';
import { createRipgrepProvider } from '../runtime/src/repository/providers/ripgrep.js';
import type { RepositoryRetrieval } from '../runtime/src/repository/results.js';
import {
  openRepositoryWorkspace,
  type RepositoryWorkspace,
} from '../runtime/src/repository/workspace.js';
import {
  gradeRepositoryRetrieval,
  rankKeywordHits,
  retrievalKeywords,
  retrievalObservationFailed,
} from './repository-retrieval.js';
import {
  repositoryFixturePaths,
  retrievalCorpus,
  type RetrievalQuestion,
} from './repository-retrieval-fixtures.js';

const implementationFiles = [
  'bun.lock',
  'evals/repository-retrieval-fixtures.ts',
  'evals/repository-retrieval-live.ts',
  'evals/repository-retrieval.ts',
  'runtime/src/path-containment.ts',
  'runtime/src/repository/evidence.ts',
  'runtime/src/repository/filesystem.ts',
  'runtime/src/repository/process.ts',
  'runtime/src/repository/providers/colgrep.ts',
  'runtime/src/repository/providers/ripgrep.ts',
  'runtime/src/repository/results.ts',
  'runtime/src/repository/workspace.ts',
];
const keywordCandidateLimit = 100;

type Search = (
  workspace: RepositoryWorkspace,
  question: RetrievalQuestion,
  limit: number,
) => Promise<RepositoryRetrieval>;
type Observation = Awaited<ReturnType<typeof observeQuestion>>;
type Corpus = ReturnType<typeof retrievalCorpus>;
type IndexMeasurement =
  | {
      status: 'ready';
      elapsedMs: number;
      providerElapsedMs: number;
      cacheBytesBefore: number;
      cacheBytesAfter: number;
      sampledPeakCacheBytes: number;
      sampleIntervalMs: number;
      samplesDuringBuild: number;
    }
  | { status: 'unavailable'; message: string };
type IndexLifecycle = {
  build(workspace: RepositoryWorkspace): Promise<IndexMeasurement>;
  reopen(
    workspace: RepositoryWorkspace,
    question: RetrievalQuestion,
    files: ReadonlyMap<string, string>,
    k: number,
  ): Promise<{
    scenario: 'simulated-reboot-identity-change';
    liveIdentityChanged: boolean;
    cacheIdentityPreserved: boolean;
    generationReused: boolean;
    status: {
      availability: string;
      activity: string;
      generation?: string;
      publishedAt?: string;
    };
    query: Observation;
  }>;
};

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fileFingerprint(files: ReadonlyMap<string, string>): string {
  return fingerprint([...files.keys()].sort().map((file) => [file, files.get(file)]));
}

async function committedInputs(checkout: RepositoryWorkspace, pathValue: string) {
  const git = findRepositoryExecutable('git', pathValue, checkout);
  if (!git) throw new Error('The retrieval benchmark requires Git.');
  const readGit = async (...args: string[]) => {
    const result = await runRepositoryCommand(git, args, checkout, pathValue, {
      timeoutMs: 5000,
      maxBytes: 512 * 1024,
    });
    if (result.code !== 0) throw new Error('Could not read the retrieval benchmark revision.');
    return result.stdout;
  };
  const revision = (await readGit('rev-parse', 'HEAD')).trim();
  const files = new Map(
    await Promise.all(
      repositoryFixturePaths.map(
        async (file) => [file, await readGit('show', `${revision}:${file}`)] as const,
      ),
    ),
  );
  return { revision, files };
}

async function colgrepProvenance(deployment: string) {
  const receipt = await readFile(path.join(deployment, 'assets.json'));
  const manifest: unknown = JSON.parse(receipt.toString('utf8'));
  if (typeof manifest !== 'object' || manifest === null)
    throw new Error('Invalid ColGREP asset manifest.');
  const fields = ['colgrepVersion', 'modelRevision', 'onnxRuntimeVersion'] as const;
  return {
    manifestSha256: createHash('sha256').update(receipt).digest('hex'),
    ...Object.fromEntries(
      fields.map((field) => {
        const value: unknown = Object.getOwnPropertyDescriptor(manifest, field)?.value;
        return [field, typeof value === 'string' && /^[\w.-]{1,80}$/.test(value) ? value : null];
      }),
    ),
  };
}

async function observeQuestion(
  search: Search,
  workspace: RepositoryWorkspace,
  question: RetrievalQuestion,
  files: ReadonlyMap<string, string>,
  k: number,
) {
  const limit = question.limit ?? k;
  const started = performance.now();
  const result = await search(workspace, question, limit);
  const elapsedMs = performance.now() - started;
  return {
    ...question,
    k: limit,
    elapsedMs,
    ...gradeRepositoryRetrieval(question, result, files, limit),
  };
}

function summarize(group: Observation[]) {
  const comparable = group.filter((entry) => !retrievalObservationFailed(entry));
  const mean = (field: 'recallAtK' | 'reciprocalRank') => {
    const values = comparable.flatMap((entry) => (entry[field] === null ? [] : [entry[field]]));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return {
    questions: group.length,
    ready: group.filter(({ status }) => status === 'ready').length,
    operationalFailures: group.filter(({ status }) => status !== 'ready').length,
    incomplete: group.filter(({ incomplete }) => incomplete).length,
    integrityFailures: group.filter(({ invalidEvidence }) => invalidEvidence > 0).length,
    scoredRecallQuestions: comparable.filter(({ recallAtK }) => recallAtK !== null).length,
    falsePositives: group.reduce((sum, { falsePositives }) => sum + falsePositives, 0),
    invalidEvidence: group.reduce((sum, { invalidEvidence }) => sum + invalidEvidence, 0),
    recallAtK: mean('recallAtK'),
    meanReciprocalRank: mean('reciprocalRank'),
    cleanNegatives: group.filter(({ cleanNegative }) => cleanNegative === true).length,
    negativeQuestions: group.filter(({ cleanNegative }) => cleanNegative !== null).length,
  };
}

async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(child);
    else if (entry.isFile()) bytes += (await stat(child)).size;
  }
  return bytes;
}

async function measureIndexBuild(
  build: () => Promise<number>,
  cache: string,
): Promise<IndexMeasurement> {
  const cacheBytesBefore = await directoryBytes(cache);
  let sampledPeakCacheBytes = cacheBytesBefore;
  let samplesDuringBuild = 0;
  let pendingSample: Promise<void> | undefined;
  const sample = async () => {
    const bytes = await directoryBytes(cache).catch(() => undefined);
    if (bytes === undefined) return;
    sampledPeakCacheBytes = Math.max(sampledPeakCacheBytes, bytes);
    samplesDuringBuild++;
  };
  const started = performance.now();
  const building = build();
  const timer = setInterval(() => {
    pendingSample ??= sample().finally(() => {
      pendingSample = undefined;
    });
  }, 100);
  let providerElapsedMs: number;
  try {
    [providerElapsedMs] = await Promise.all([building, sample()]);
  } finally {
    clearInterval(timer);
  }
  await pendingSample;
  const cacheBytesAfter = await directoryBytes(cache);
  return {
    status: 'ready',
    elapsedMs: performance.now() - started,
    providerElapsedMs,
    cacheBytesBefore,
    cacheBytesAfter,
    sampledPeakCacheBytes: Math.max(sampledPeakCacheBytes, cacheBytesAfter),
    sampleIntervalMs: 100,
    samplesDuringBuild,
  };
}

async function writeCorpus(root: string, files: ReadonlyMap<string, string>) {
  for (const [relative, contents] of files) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  return openRepositoryWorkspace(root);
}

async function runProvider(
  search: Search,
  root: string,
  corpus: Corpus,
  k: number,
  cache?: string,
  indexLifecycle?: IndexLifecycle,
) {
  const files = new Map(corpus.files);
  const workspace = await writeCorpus(root, files);
  const observe = (question: RetrievalQuestion) =>
    observeQuestion(search, workspace, question, files, k);
  const [first] = corpus.questions;
  if (!first) throw new Error('The retrieval benchmark needs at least one question per provider.');
  const initialIndex = indexLifecycle ? await indexLifecycle.build(workspace) : undefined;
  const cold = await observe(first);
  const indexCacheBytes = cache ? await directoryBytes(cache) : 0;
  const queries: Observation[] = [];
  for (const question of corpus.questions) queries.push(await observe(question));

  const reopened =
    indexLifecycle && initialIndex?.status === 'ready'
      ? await indexLifecycle.reopen(workspace, first, files, k)
      : undefined;

  const lifecycle = [];
  for (const mutation of corpus.transitions) {
    const previous = path.join(root, mutation.path);
    if (mutation.kind === 'modify') {
      await writeFile(previous, mutation.contents);
      files.set(mutation.path, mutation.contents);
    } else {
      if (mutation.kind === 'rename') {
        await rename(previous, path.join(root, mutation.destination));
        files.set(mutation.destination, files.get(mutation.path)!);
      } else {
        await rm(previous);
      }
      files.delete(mutation.path);
    }
    const refresh = indexLifecycle ? await indexLifecycle.build(workspace) : undefined;
    const observations: Observation[] = [];
    for (const question of mutation.questions) observations.push(await observe(question));
    lifecycle.push({
      mutation: mutation.kind,
      corpusSha256: fileFingerprint(files),
      ...(refresh ? { refresh } : {}),
      observations,
    });
  }

  const comparable = queries.filter(({ category }) => category !== 'limited');
  const conceptual = comparable.filter(({ group }) => group === 'conceptual');
  const categories = [...new Set(queries.map(({ category }) => category))];
  return {
    kind: cold.kind,
    cold,
    ...(initialIndex ? { initialIndex } : {}),
    ...(reopened ? { reopened } : {}),
    warmRepeatMs: queries[0]!.elapsedMs,
    coldQueryCacheBytes: indexCacheBytes,
    queries,
    lifecycle,
    summary: {
      lexical: summarize(comparable.filter(({ group }) => group === 'lexical')),
      conceptual: summarize(conceptual),
      byCategory: Object.fromEntries(
        categories.map((category) => [
          category,
          summarize(queries.filter((question) => question.category === category)),
        ]),
      ),
      byCodeLanguage: {
        python: summarize(
          comparable.filter(({ expected }) => expected.some(({ path }) => path.endsWith('.py'))),
        ),
        typescript: summarize(
          comparable.filter(({ expected }) => expected.some(({ path }) => path.endsWith('.ts'))),
        ),
      },
      byQueryLanguage: {
        en: summarize(conceptual.filter(({ queryLanguage }) => queryLanguage === undefined)),
        de: summarize(conceptual.filter(({ queryLanguage }) => queryLanguage === 'de')),
      },
    },
  };
}

async function benchmark(k: number, deployment: string | undefined, signal: AbortSignal) {
  const startedAt = new Date().toISOString();
  const checkout = await openRepositoryWorkspace(path.resolve(import.meta.dir, '..'));
  const pathValue = process.env.PATH ?? '';
  const repository = await committedInputs(checkout, pathValue);
  const corpus = retrievalCorpus(repository.files);
  const implementationSha256 = fingerprint(
    await Promise.all(
      implementationFiles.map(async (file) => [
        file,
        await readFile(path.join(checkout.root, file), 'utf8'),
      ]),
    ),
  );
  const rg = findRepositoryExecutable('rg', pathValue, checkout);
  const rgPath = rg ? path.dirname(rg) : '';
  const rgVersion = rg
    ? await runRepositoryCommand(rg, ['--version'], checkout, rgPath, {
        timeoutMs: 5000,
        maxBytes: 4096,
      })
    : undefined;
  const colgrepAssets = deployment ? await colgrepProvenance(deployment) : undefined;
  const temporary = await mkdtemp(path.join(tmpdir(), 'ltcook-retrieval-benchmark-'));
  try {
    const ripgrep = createRipgrepProvider({ pathValue: rgPath });
    const exhaustive = await runProvider(
      (workspace, { group, query }, limit) =>
        ripgrep.search(
          workspace,
          {
            query,
            mode: group === 'lexical' ? 'exact' : 'literal',
            limit,
          },
          signal,
        ),
      path.join(temporary, 'ripgrep'),
      corpus,
      k,
    );
    const keyword = await runProvider(
      async (workspace, { query }) => {
        const keywords = retrievalKeywords(query);
        if (!keywords.length) throw new Error('A keyword baseline query needs at least one word.');
        const result = await ripgrep.search(
          workspace,
          { query: `(?i)(?:${keywords.join('|')})`, mode: 'regex', limit: keywordCandidateLimit },
          signal,
        );
        return {
          ...result,
          value: {
            ...result.value,
            kind: 'ranked',
            hits: rankKeywordHits(result.value.hits, keywords),
          },
        };
      },
      path.join(temporary, 'ripgrep-keywords'),
      {
        ...corpus,
        questions: corpus.questions.filter(({ group }) => group === 'conceptual'),
        transitions: [],
      },
      k,
    );
    const cacheDirectory = path.join(temporary, 'colgrep-cache');
    const ranked = deployment
      ? await (async () => {
          await mkdir(cacheDirectory);
          const colgrep = createColgrepProvider({
            deploymentDirectory: deployment,
            cacheDirectory,
          });
          const measured = await runProvider(
            (workspace, { query }, limit) =>
              colgrep.search(workspace, { query, mode: 'hybrid', limit }, signal),
            path.join(temporary, 'colgrep'),
            corpus,
            k,
            cacheDirectory,
            {
              async build(workspace) {
                try {
                  return await measureIndexBuild(
                    () => colgrep.buildIndex(workspace, signal),
                    cacheDirectory,
                  );
                } catch (error) {
                  signal.throwIfAborted();
                  return {
                    status: 'unavailable',
                    message: error instanceof Error ? error.message : 'ColGREP index build failed.',
                  };
                }
              },
              async reopen(workspace, question, files, limit) {
                const originalStatus = await colgrep.readStatus(workspace);
                const reopenedWorkspace = await openRepositoryWorkspace(workspace.root);
                const restartedWorkspace: RepositoryWorkspace = {
                  ...reopenedWorkspace,
                  identity: `simulated-reboot:${reopenedWorkspace.identity}`,
                };
                const reopenedColgrep = createColgrepProvider({
                  deploymentDirectory: deployment,
                  cacheDirectory,
                });
                const [status, query] = await Promise.all([
                  reopenedColgrep.readStatus(restartedWorkspace),
                  observeQuestion(
                    (activeWorkspace, activeQuestion, activeLimit) =>
                      reopenedColgrep.search(
                        activeWorkspace,
                        {
                          query: activeQuestion.query,
                          mode: 'hybrid',
                          limit: activeLimit,
                        },
                        signal,
                      ),
                    restartedWorkspace,
                    question,
                    files,
                    limit,
                  ),
                ]);
                return {
                  scenario: 'simulated-reboot-identity-change',
                  liveIdentityChanged: restartedWorkspace.identity !== workspace.identity,
                  cacheIdentityPreserved:
                    reopenedWorkspace.cacheIdentity === workspace.cacheIdentity,
                  generationReused:
                    originalStatus.generation !== undefined &&
                    status.generation === originalStatus.generation,
                  status: {
                    availability: status.availability,
                    activity: status.activity,
                    ...(status.generation ? { generation: status.generation } : {}),
                    ...(status.publishedAt ? { publishedAt: status.publishedAt } : {}),
                  },
                  query,
                };
              },
            },
          );
          return measured;
        })()
      : undefined;
    return {
      schemaVersion: 3,
      runId: randomUUID(),
      startedAt,
      environment: { platform: process.platform, architecture: process.arch, bun: Bun.version },
      provenance: {
        repositoryRevision: repository.revision,
        corpusSha256: fileFingerprint(corpus.files),
        labelsSha256: fingerprint([
          corpus.questions,
          ...corpus.transitions.map(({ questions }) => questions),
        ]),
        implementationSha256,
        ripgrepVersion:
          rgVersion?.code === 0 ? (rgVersion.stdout.split('\n')[0]?.trim() ?? null) : null,
        ...(colgrepAssets ? { colgrepAssets } : {}),
      },
      k,
      providers: {
        ripgrep: {
          queryModes: { lexical: 'exact', conceptual: 'literal' },
          ...exhaustive,
          indexing: null,
        },
        ripgrepKeywords: {
          queryMode: 'case-insensitive-keyword-overlap',
          candidateLimit: keywordCandidateLimit,
          ...keyword,
          indexing: null,
        },
        ...(ranked ? { colgrep: { queryMode: 'hybrid', ...ranked } } : {}),
      },
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const { values } = parseArgs({
  options: { colgrep: { type: 'boolean' }, k: { type: 'string', default: '5' } },
});
const k = Number(values.k);
if (!Number.isInteger(k) || k < 1 || k > COLGREP_MAX_RESULTS) {
  throw new Error(`Set --k to an integer from 1 to ${COLGREP_MAX_RESULTS}.`);
}
const deployment = values.colgrep ? process.env.LTCOOK_COLGREP_DEPLOYMENT : undefined;
if (values.colgrep && !deployment) throw new Error('Set LTCOOK_COLGREP_DEPLOYMENT for --colgrep.');

const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const report = await benchmark(k, deployment, controller.signal);
  console.log(JSON.stringify(report, null, 2));
  const failedRun = Object.values(report.providers).some((provider) =>
    [
      provider.cold,
      ...provider.queries,
      ...provider.lifecycle.flatMap(({ observations }) => observations),
    ].some(retrievalObservationFailed),
  );
  const colgrep = report.providers.colgrep;
  const indexFailure = Boolean(
    colgrep &&
    (!colgrep.initialIndex ||
      colgrep.initialIndex.status !== 'ready' ||
      !colgrep.reopened ||
      !colgrep.reopened.liveIdentityChanged ||
      !colgrep.reopened.cacheIdentityPreserved ||
      !colgrep.reopened.generationReused ||
      colgrep.reopened.status.availability !== 'ready' ||
      colgrep.lifecycle.some(({ refresh }) => refresh?.status !== 'ready')),
  );
  const reopenedQueryFailure = Boolean(
    colgrep && colgrep.reopened && retrievalObservationFailed(colgrep.reopened.query),
  );
  if (failedRun || indexFailure || reopenedQueryFailure) process.exitCode = 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { isWithin } from '../../path-containment.js';
import { RepositorySourceReader } from '../evidence.js';
import type { RepositoryDiagnostic, RepositoryRetrieval } from '../results.js';
import type { RepositoryWorkspace } from '../workspace.js';
import { REPO_SEARCH_TIMEOUT_MS } from '../../tools/workspace-tools.js';
import {
  RepositoryIndexError,
  RepositoryIndexService,
  type IndexJobStatus,
} from '../../services/repository-index.js';
import { ColgrepIndexStore } from './colgrep-index-store.js';
import {
  captureColgrepSource,
  missing,
  readColgrepSource,
  requiresFreshColgrepBuild,
  sameColgrepSource,
  writeColgrepSource,
} from './colgrep-source.js';

export interface ColgrepStatus {
  availability: 'ready' | 'not-ready' | 'unavailable' | 'unknown';
  activity: IndexJobStatus['activity'] | 'updating' | 'unknown';
  diagnostic: string | null;
  generation?: string;
  publishedAt?: string;
  retryAt?: string;
}

export const COLGREP_MAX_RESULTS = 20;
const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const CHECKPOINT_GRACE_MS = 4000;
const INDEX_TIMEOUT_MS = 15 * 60_000;
const REPAIR = 'Repeat LTCook setup with the supported installer or editable registration.';
const MODEL_FILES = [
  'config.json',
  'config_sentence_transformers.json',
  'onnx_config.json',
  'tokenizer.json',
  'model.onnx',
  'model_int8.onnx',
];
const ASSET_SCHEMA = Type.Object({
  binary: Type.String({ minLength: 1 }),
  library: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
  files: Type.Record(Type.String(), Type.String({ pattern: '^[a-f0-9]{64}$' })),
});
const RANGE_SCHEMA = Type.Object({
  line: Type.Integer({ minimum: 1 }),
  end_line: Type.Integer({ minimum: 1 }),
  name: Type.String(),
});
const NATIVE_RESULT = Type.Object({
  unit: Type.Intersect([RANGE_SCHEMA, Type.Object({ file: Type.String(), code: Type.String() })]),
  matches: Type.Optional(Type.Array(RANGE_SCHEMA)),
});

interface ColgrepOptions {
  deploymentDirectory?: string;
  cacheDirectory?: string;
  timeoutMs?: number;
  indexTimeoutMs?: number;
  background?: boolean;
}

interface RepositorySearchRequest {
  query: string;
  mode?: 'hybrid' | 'semantic';
  updateIndex?: boolean;
  pattern?: string;
  paths?: string[];
  limit?: number;
}

interface VerifiedFile {
  identity: string;
  digest: string;
}

class ColgrepCommandLimitError extends Error {
  constructor(readonly code: 'output-limit' | 'diagnostic-limit') {
    super(
      code === 'output-limit'
        ? 'ColGREP output exceeded its size limit.'
        : 'ColGREP diagnostics exceeded their size limit.',
    );
  }
}

class ColgrepPatternError extends Error {}

function confinedPath(root: string, relative: string): string {
  const candidate = path.resolve(root, relative);
  if (path.isAbsolute(relative) || !isWithin(root, candidate)) {
    throw new Error('Path must be relative and inside the workspace or managed storage.');
  }
  return candidate;
}

async function regularFile(file: string) {
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || (await realpath(file)) !== file) {
    throw new Error('Expected a regular file in managed storage.');
  }
  return info;
}

async function verifyFile(
  file: string,
  digest: string,
  previous: Map<string, VerifiedFile>,
  signal: AbortSignal,
): Promise<void> {
  const info = await regularFile(file);
  const identity = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  const cached = previous.get(file);
  if (cached?.identity === identity && cached.digest === digest) return;
  const hash = createHash('sha256');
  const stream = createReadStream(file, { signal });
  for await (const chunk of stream) hash.update(chunk);
  if (hash.digest('hex') !== digest) throw new Error('Managed asset checksum differs.');
  previous.set(file, { identity, digest });
}

async function readAssets(deployment: string | undefined, signal?: AbortSignal) {
  let repair = REPAIR;
  try {
    if (!deployment || !path.isAbsolute(deployment)) throw new Error('Missing managed deployment.');
    const root = await realpath(deployment);
    if (!(await lstat(deployment)).isDirectory()) throw new Error('Invalid managed deployment.');
    const receipt = path.join(root, 'assets.json');
    const info = await regularFile(receipt);
    if (info.size > 65_536n) throw new Error('Managed asset receipt is too large.');
    const assets: unknown = JSON.parse(await readFile(receipt, { encoding: 'utf8', signal }));
    if (!Value.Check(ASSET_SCHEMA, assets)) throw new Error('Invalid managed asset receipt.');
    const binary = confinedPath(root, assets.binary);
    const library = confinedPath(root, assets.library);
    const model = confinedPath(root, assets.model);
    if (!(await lstat(model)).isDirectory() || (await realpath(model)) !== model) {
      throw new Error('Missing model directory.');
    }
    const files = new Map(
      Object.entries(assets.files).map(([relative, digest]) => [
        confinedPath(root, relative),
        digest,
      ]),
    );
    if (
      !files.has(binary) ||
      !files.has(library) ||
      MODEL_FILES.some((file) => !files.has(path.join(model, file)))
    ) {
      throw new Error('The managed model files differ from the asset receipt.');
    }
    if ((await readdir(model)).some((file) => !files.has(path.join(model, file)))) {
      repair = `Move unexpected files out of the managed ColGREP model directory. ${REPAIR}`;
      throw new Error('The managed model directory contains unverified entries.');
    }
    // > ColGREP includes the canonical model path in its native directory name.
    const compatibility = createHash('sha256')
      .update(
        JSON.stringify([
          model,
          files.get(binary),
          MODEL_FILES.map((file) => files.get(path.join(model, file))),
        ]),
      )
      .digest('hex');
    return { root, binary, library, model, files, compatibility };
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`ColGREP assets are missing or invalid. ${repair}`, { cause: error });
  }
}

async function loadAssets(
  deployment: string | undefined,
  verified: Map<string, VerifiedFile>,
  signal: AbortSignal,
) {
  const assets = await readAssets(deployment, signal);
  try {
    for (const [file, digest] of assets.files) await verifyFile(file, digest, verified, signal);
    return assets;
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`ColGREP assets are missing or invalid. ${REPAIR}`, { cause: error });
  }
}

interface SearchPath {
  absolute: string;
  filter: string;
  directory: boolean;
}

async function searchPaths(
  workspace: RepositoryWorkspace,
  requested: string[],
): Promise<SearchPath[]> {
  return Promise.all(
    requested.map(async (relative) => {
      if (/[\u0000*?{}\[\]\\:]/.test(relative)) {
        throw new Error(
          'Search paths must be literal workspace-relative paths using forward slashes.',
        );
      }
      const selected = await workspace.resolvePath(relative, { allowRoot: true });
      return {
        absolute: selected.absolute,
        filter: selected.relative === '.' ? '' : selected.relative,
        directory: selected.kind === 'directory',
      };
    }),
  );
}

function execute(
  assets: Awaited<ReturnType<typeof loadAssets>>,
  args: string[],
  indices: string,
  signal: AbortSignal,
  indexing = false,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  signal.throwIfAborted();
  const windows = process.platform === 'win32';
  const systemRoot = process.env.SystemRoot;
  const privateHome = path.dirname(indices);
  return new Promise((resolve, reject) => {
    const child = spawn(assets.binary, args, {
      cwd: assets.root,
      env: {
        ...(windows && systemRoot ? { SystemRoot: systemRoot } : {}),
        PATH: windows ? (systemRoot ? path.join(systemRoot, 'System32') : '') : '/usr/bin:/bin',
        HOME: privateHome,
        ...(windows ? { USERPROFILE: privateHome } : {}),
        COLGREP_DATA_DIR: indices,
        ORT_DYLIB_PATH: assets.library,
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let failure: unknown;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: unknown) => {
      if (failure) return;
      failure = error;
      if (!windows && indexing) {
        // > Give native indexing a chance to leave a resumable checkpoint.
        if (child.kill('SIGINT')) {
          forceStop = setTimeout(() => child.kill('SIGKILL'), CHECKPOINT_GRACE_MS);
        }
      } else {
        child.kill('SIGKILL');
      }
    };
    child.once('exit', () => clearTimeout(forceStop));
    const cancel = () => stop(signal.reason ?? new Error('ColGREP search was cancelled.'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (failure) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT) stop(new ColgrepCommandLimitError('output-limit'));
      else stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (failure) return;
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_STDERR && !indexing) {
        stop(new ColgrepCommandLimitError('diagnostic-limit'));
        return;
      }
      stderr = (stderr + chunk).slice(-MAX_STDERR);
      // > Upstream falls back to host discovery when the managed library fails to load.
      if (stderr.includes('is not a loadable ONNX Runtime dylib')) {
        stop(new Error(`ColGREP could not load the managed ONNX Runtime library. ${REPAIR}`));
      }
    });
    child.once('error', (error) => {
      failure ??= new Error(`Could not launch managed ColGREP. ${REPAIR}`, { cause: error });
    });
    child.once('close', (code) => {
      clearTimeout(forceStop);
      signal.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
  });
}

function searchFailure(stderr: string, pattern?: string): Error {
  if (
    /index lock|permission denied|read.only file system|not a directory|no space left/i.test(stderr)
  ) {
    return new Error(
      'ColGREP could not access its index or lock. Check AppRC cache permissions, disk space, and competing searches.',
    );
  }
  if (pattern && /regex|regular expression|look.around/i.test(stderr)) {
    return new ColgrepPatternError(
      'ColGREP could not search with the supplied regular expression. Check the pattern.',
    );
  }
  if (/onnx|model|dll|shared librar/i.test(stderr)) {
    return new Error(`ColGREP could not use its managed model or runtime. ${REPAIR}`);
  }
  if (/no (index|files indexed)|no indexable files/i.test(stderr)) {
    return new Error(
      'ColGREP found no indexable files. Check repository content and ignore rules.',
    );
  }
  return new Error(
    'ColGREP search failed. Check that the workspace and AppRC cache are available.',
  );
}

function nativeIndexFailure(stderr: string): boolean {
  return /index appears corrupted|index load failed|no index found|no data to merge/i.test(stderr);
}

async function checkCandidate(
  assets: Awaited<ReturnType<typeof loadAssets>>,
  workspace: RepositoryWorkspace,
  indices: string,
  signal: AbortSignal,
) {
  const entries = await readdir(indices, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1)
    throw new Error('ColGREP did not produce one complete index for this worktree.');
  const directory = path.join(indices, directories[0]!.name);
  const receiptPath = path.join(directory, 'project.json');
  if ((await regularFile(receiptPath)).size > 65_536n)
    throw new Error('Invalid ColGREP project receipt.');
  const receipt: unknown = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (
    !Value.Check(Type.Object({ project_path: Type.String(), model: Type.String() }), receipt) ||
    nativePath(receipt.project_path) !== workspace.root ||
    nativePath(receipt.model) !== assets.model
  ) {
    throw new Error('ColGREP produced an index for a different worktree or model.');
  }
  const building = await lstat(path.join(directory, '.building')).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  if (building) throw new Error('ColGREP left an incomplete index checkpoint.');
  const result = await execute(
    assets,
    [
      'search',
      '--no-update',
      '--json',
      '--model',
      assets.model,
      '--results',
      '1',
      '--',
      'repository index validation',
      workspace.root,
    ],
    indices,
    signal,
  );
  if (result.code !== 0 || !Array.isArray(JSON.parse(result.stdout)))
    throw new Error('ColGREP could not open the newly completed index.');
}

function nativePath(file: string): string {
  if (process.platform !== 'win32') return file;
  if (file.startsWith('\\\\?\\UNC\\')) return '\\\\' + file.slice(8);
  return file.startsWith('\\\\?\\') ? file.slice(4) : file;
}

function rankedResult(): RepositoryRetrieval {
  return {
    provider: 'colgrep',
    value: { kind: 'ranked', status: 'ready', hits: [] },
    diagnostics: [],
    partial: false,
    truncated: false,
    capturedAt: new Date().toISOString(),
    // > The published index may precede changes in the live worktree.
    freshness: 'cached',
  };
}

function report(result: RepositoryRetrieval, code: string, message: string) {
  if (!result.diagnostics.some((diagnostic) => diagnostic.code === code)) {
    result.diagnostics.push({ source: 'colgrep', code, message } satisfies RepositoryDiagnostic);
  }
  result.partial = true;
}

async function normalizeResults(
  stdout: string,
  workspace: RepositoryWorkspace,
  paths: SearchPath[],
  limit: number,
  candidateLimit: number,
  signal: AbortSignal,
  result: RepositoryRetrieval,
  source: RepositorySourceReader,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('ColGREP returned malformed JSON.');
  }
  if (!Array.isArray(value)) throw new Error('ColGREP returned malformed results.');
  result.truncated = value.length >= candidateLimit;

  for (const hit of value as unknown[]) {
    if (result.value.hits.length === limit) {
      result.truncated = true;
      break;
    }
    signal.throwIfAborted();
    if (!Value.Check(NATIVE_RESULT, hit)) {
      report(result, 'invalid-hit', 'ColGREP returned a malformed source candidate.');
      continue;
    }
    const file = nativePath(hit.unit.file);
    if (!path.isAbsolute(file) || path.resolve(file) !== file || !isWithin(workspace.root, file)) {
      report(
        result,
        'outside-workspace',
        'ColGREP returned a path outside the authorized workspace.',
      );
      continue;
    }
    if (
      paths.length &&
      !paths.some(
        ({ absolute, directory }) => absolute === file || (directory && isWithin(absolute, file)),
      )
    )
      continue;

    // > Native JSON can give a unit's context range and its best match's narrower range.
    const ranges = [hit.matches?.[0], hit.unit].flatMap((range) =>
      range ? [{ startLine: range.line, endLine: range.end_line, name: range.name }] : [],
    );
    const evidence = await source.verify(
      {
        path: path.relative(workspace.root, file),
        excerpt: hit.unit.code,
        ranges,
      },
      signal,
    );
    if (typeof evidence === 'string') {
      if (evidence !== 'source-unavailable') result.freshness = 'stale';
      report(
        result,
        evidence,
        evidence === 'source-unavailable'
          ? 'ColGREP evidence could not be checked against an authorized current source file.'
          : 'ColGREP evidence refers to a missing file or differs from its current source.',
      );
      continue;
    }
    result.value.hits.push(evidence);
    result.truncated ||= evidence.excerptTruncated === true;
  }
}

/** Build and query separate native index generations for an authorized worktree. */
export function createColgrepProvider(options: ColgrepOptions = {}) {
  const verifiedFiles = new Map<string, VerifiedFile>();
  const deployment = options.deploymentDirectory ?? process.env.LTCOOK_COLGREP_DEPLOYMENT;
  const cache = options.cacheDirectory ?? process.env.LTCOOK_COLGREP_CACHE_DIR;
  const timeoutMs = options.timeoutMs ?? REPO_SEARCH_TIMEOUT_MS;
  const indexService = new RepositoryIndexService(async (workspace, signal) => {
    await buildIndex(workspace, signal);
  });

  async function buildIndex(
    workspace: RepositoryWorkspace,
    callerSignal: AbortSignal,
  ): Promise<number> {
    const signal = AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(options.indexTimeoutMs ?? INDEX_TIMEOUT_MS),
    ]);
    signal.throwIfAborted();
    await workspace.assertUnchanged();
    const started = performance.now();
    const assets = await loadAssets(deployment, verifiedFiles, signal).catch((error: unknown) => {
      signal.throwIfAborted();
      throw new RepositoryIndexError(error instanceof Error ? error.message : REPAIR, false);
    });
    const store = await ColgrepIndexStore.open(cache, workspace, assets.compatibility, true);
    if (!store) throw new Error('ColGREP could not create its AppRC index storage.');
    const writer = await store.tryWriter();
    if (!writer) {
      throw new RepositoryIndexError(
        'Another ColGREP process is indexing. Waiting for its turn.',
        true,
      );
    }

    try {
      const source = await captureColgrepSource(workspace, signal);
      const published = await store.readPublished();
      const previous = published && (await readColgrepSource(published.indices));
      if (previous && sameColgrepSource(previous, source)) return performance.now() - started;
      if (!source.length)
        throw new RepositoryIndexError('The worktree has no files to index yet.', true);

      const seed = previous !== undefined && !requiresFreshColgrepBuild(previous, source);
      let candidate = await writer.candidate({ seed });
      let checkpointSource = await captureColgrepSource(workspace, signal, true);
      const beforePause = candidate.resumed
        ? await readColgrepSource(candidate.indices)
        : undefined;
      if (
        (candidate.resumed &&
          (!beforePause || requiresFreshColgrepBuild(beforePause, checkpointSource))) ||
        (candidate.seeded && previous && requiresFreshColgrepBuild(previous, checkpointSource))
      ) {
        // > A native refresh also skips a changed file if its size and mtime were preserved.
        await writer.discard(candidate);
        candidate = await writer.candidate({ seed: false, resume: false });
      }
      if (!candidate.resumed) await writeColgrepSource(candidate.indices, checkpointSource);

      const init = async () => {
        signal.throwIfAborted();
        await workspace.assertUnchanged();
        const result = await execute(
          assets,
          ['init', '--yes', '--model', assets.model, '--', workspace.root],
          candidate.indices,
          signal,
          true,
        );
        if (result.code !== 0) {
          const error = searchFailure(result.stderr);
          if (/no (index|files indexed)|no indexable files/i.test(result.stderr))
            throw new RepositoryIndexError(error.message, true);
          throw error;
        }
      };

      try {
        await init();
        if (candidate.resumed) {
          const beforeReconciliation = await captureColgrepSource(workspace, signal, true);
          if (requiresFreshColgrepBuild(checkpointSource, beforeReconciliation)) {
            await writer.discard(candidate);
            candidate = await writer.candidate({ seed: false, resume: false });
          }
          checkpointSource = beforeReconciliation;
          if (!candidate.resumed) await writeColgrepSource(candidate.indices, checkpointSource);
          // > Resume skips already checkpointed paths. A second native pass reconciles them.
          await init();
        }
        await checkCandidate(assets, workspace, candidate.indices, signal);
      } catch (error) {
        if (!signal.aborted) await writer.discard(candidate);
        throw error;
      }
      signal.throwIfAborted();
      await workspace.assertUnchanged();
      signal.throwIfAborted();
      // > Keep the observation from before the last native pass so late edits are checked again.
      await writeColgrepSource(candidate.indices, checkpointSource);
      await writer.publish(candidate, signal);
      return performance.now() - started;
    } finally {
      await writer.release();
    }
  }

  return {
    indexService,
    buildIndex,

    isIndexingEnabled(): boolean {
      return indexService.isEnabled();
    },

    setIndexingEnabled(enabled: boolean): void {
      indexService.setEnabled(enabled);
    },

    /** Inspect the already published generation without opening a native process. */
    async readStatus(workspace: RepositoryWorkspace): Promise<ColgrepStatus> {
      let failure = 'The authorized worktree is unavailable.';
      try {
        await workspace.assertUnchanged();
        failure = `ColGREP assets are missing or invalid. ${REPAIR}`;
        const assets = await readAssets(deployment);
        await Promise.all([...assets.files.keys()].map((file) => regularFile(file)));
        failure = 'ColGREP could not read its AppRC index storage.';
        const store = await ColgrepIndexStore.open(cache, workspace, assets.compatibility, false);
        const published = await store?.readPublished();
        failure = 'The authorized worktree is unavailable.';
        await workspace.assertUnchanged();
        const job = indexService.status(workspace);
        return {
          ...job,
          availability: published ? 'ready' : 'not-ready',
          activity: published && job.activity === 'indexing' ? 'updating' : job.activity,
          ...(published && { generation: published.id, publishedAt: published.publishedAt }),
        };
      } catch {
        return { availability: 'unavailable', activity: 'error', diagnostic: failure };
      }
    },

    async search(
      workspace: RepositoryWorkspace,
      input: RepositorySearchRequest,
      callerSignal: AbortSignal,
      source = new RepositorySourceReader(workspace),
    ): Promise<RepositoryRetrieval> {
      callerSignal.throwIfAborted();
      if (!input.query.trim() || input.query.includes('\0') || input.pattern?.includes('\0')) {
        throw new Error('ColGREP queries and regular expressions must be nonempty text.');
      }
      // > With --pattern, ColGREP treats path-shaped query text as another search root.
      if (input.pattern && (/^[.~]/.test(input.query) || /[/\\]/.test(input.query))) {
        throw new Error(
          'Use a descriptive query and put file or directory restrictions in paths when using a regular expression.',
        );
      }
      await workspace.assertUnchanged();
      const paths = await searchPaths(workspace, input.paths ?? []);
      const limit = input.limit ?? 8;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > COLGREP_MAX_RESULTS)
        throw new Error('ColGREP result limit is outside the supported range.');
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([callerSignal, timeout]);
      const outcome = rankedResult();
      try {
        // > ColGREP also matches globs below the root. Verify exact literal scope on every hit.
        const filters = paths.some(({ filter }) => !filter) ? [] : paths;
        const candidateLimit = (filters.length ? COLGREP_MAX_RESULTS : limit) + 1;
        const assets = await loadAssets(deployment, verifiedFiles, signal);
        const store = await ColgrepIndexStore.open(cache, workspace, assets.compatibility, false);
        signal.throwIfAborted();
        const published = await store?.pinPublished();
        if (!published || !store) {
          if (options.background && input.updateIndex !== false) indexService.request(workspace);
          const job = indexService.status(workspace);
          const inProgress = ['queued', 'indexing', 'retrying'].includes(job.activity);
          outcome.value.status = inProgress ? 'indexing' : 'unavailable';
          outcome.freshness = 'unknown';
          report(
            outcome,
            inProgress ? 'indexing' : 'index-unavailable',
            job.diagnostic ?? 'ColGREP has no completed index for this worktree.',
          );
          await workspace.assertUnchanged();
          callerSignal.throwIfAborted();
          return outcome;
        }

        try {
          const args = [
            'search',
            '--json',
            '--no-update',
            '--model',
            assets.model,
            '--results',
            String(candidateLimit),
            ...(input.mode === 'semantic' ? ['--semantic-only'] : []),
            ...(input.pattern ? [`--pattern=${input.pattern}`] : []),
            ...filters.map(
              ({ filter, directory }) => `--include=${filter}${directory ? '/**' : ''}`,
            ),
            '--',
            input.query,
            workspace.root,
          ];
          await workspace.assertUnchanged();
          const result = await execute(assets, args, published.indices, signal);
          signal.throwIfAborted();
          if (result.code !== 0) {
            if (nativeIndexFailure(result.stderr)) {
              await store.invalidatePublished(published.id);
              indexService.request(workspace);
              report(
                outcome,
                'index-recovery',
                'ColGREP could not load the index. A rebuild is needed.',
              );
            }
            throw searchFailure(result.stderr, input.pattern);
          }
          await workspace.assertUnchanged();
          await normalizeResults(
            result.stdout,
            workspace,
            filters,
            limit,
            candidateLimit,
            signal,
            outcome,
            source,
          );
          if (options.background && outcome.freshness === 'stale' && input.updateIndex !== false)
            indexService.request(workspace);
        } finally {
          await published.release();
        }
      } catch (error) {
        callerSignal.throwIfAborted();
        if (error instanceof ColgrepPatternError) throw error;
        if (!outcome.value.hits.length) {
          outcome.value.status = 'unavailable';
          outcome.freshness = 'unknown';
        }
        const limitError = error instanceof ColgrepCommandLimitError ? error : undefined;
        if (limitError) outcome.truncated = true;
        report(
          outcome,
          timeout.aborted ? 'timeout' : (limitError?.code ?? 'unavailable'),
          timeout.aborted
            ? 'ColGREP exceeded its search time limit.'
            : error instanceof Error
              ? error.message
              : 'ColGREP search failed.',
        );
      }
      await workspace.assertUnchanged();
      callerSignal.throwIfAborted();
      outcome.capturedAt = new Date().toISOString();
      return outcome;
    },
  };
}

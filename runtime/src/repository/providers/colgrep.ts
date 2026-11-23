import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { REPO_SEARCH_TIMEOUT_MS } from '../../paseo-plugin/shared/workspace-tools.js';
import { isWithin } from '../../path-containment.js';

export const COLGREP_MAX_RESULTS = 20;
const MAX_EXCERPT = 2000;
const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
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
const NATIVE_RESULTS = Type.Array(
  Type.Object({
    unit: Type.Intersect([RANGE_SCHEMA, Type.Object({ file: Type.String(), code: Type.String() })]),
    matches: Type.Optional(Type.Array(RANGE_SCHEMA)),
  }),
);
export const ColgrepHitSchema = Type.Object({
  path: Type.String(),
  startLine: Type.Integer({ minimum: 1 }),
  endLine: Type.Integer({ minimum: 1 }),
  excerpt: Type.String({ maxLength: MAX_EXCERPT }),
  name: Type.Optional(Type.String()),
});

interface ColgrepOptions {
  deploymentDirectory?: string;
  cacheDirectory?: string;
  timeoutMs?: number;
}

interface RepositorySearchRequest {
  query: string;
  mode?: 'hybrid' | 'semantic';
  pattern?: string;
  paths?: string[];
  limit?: number;
}

interface VerifiedFile {
  identity: string;
  digest: string;
}

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

async function loadAssets(
  deployment: string | undefined,
  verified: Map<string, VerifiedFile>,
  signal: AbortSignal,
) {
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
    for (const [file, digest] of files) await verifyFile(file, digest, verified, signal);
    return { root, binary, library, model };
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`ColGREP assets are missing or invalid. ${repair}`, { cause: error });
  }
}

async function workspaceIdentity(root: string): Promise<string> {
  const [actual, info] = await Promise.all([realpath(root), lstat(root, { bigint: true })]).catch(
    () => [],
  );
  if (actual !== root || !info?.isDirectory())
    throw new Error('The authorized workspace is unavailable.');
  return `${info.dev}:${info.ino}`;
}

async function getIndexDirectory(
  cache: string | undefined,
  workspace: string,
  identity: string,
): Promise<string> {
  try {
    if (!cache || !path.isAbsolute(cache)) throw new Error('Missing AppRC cache path.');
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const root = await realpath(cache);
    const key = createHash('sha256').update(workspace).update('\0').update(identity).digest('hex');
    const scope = path.join(root, key);
    const indices = path.join(scope, 'indices');
    for (const directory of [scope, indices]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory)).isDirectory() || (await realpath(directory)) !== directory) {
        throw new Error('Linked index storage.');
      }
    }
    return indices;
  } catch (error) {
    throw new Error(
      'ColGREP cannot open its AppRC index storage. Check that the cache is writable.',
      {
        cause: error,
      },
    );
  }
}

interface SearchPath {
  absolute: string;
  filter: string;
  directory: boolean;
}

async function searchPaths(workspace: string, requested: string[]): Promise<SearchPath[]> {
  return Promise.all(
    requested.map(async (relative) => {
      if (/[\u0000*?{}\[\]\\:]/.test(relative) || relative.split('/').includes('..')) {
        throw new Error(
          'Search paths must be literal workspace-relative paths using forward slashes.',
        );
      }
      const candidate = path.resolve(workspace, relative);
      if (!isWithin(workspace, candidate, true) || path.isAbsolute(relative)) {
        throw new Error('Search path is outside the authorized workspace.');
      }
      const [resolved, info] = await Promise.all([realpath(candidate), lstat(candidate)]).catch(
        () => {
          throw new Error('Search path does not exist inside the authorized workspace.');
        },
      );
      if (resolved !== candidate || !(info.isDirectory() || info.isFile())) {
        throw new Error('Search paths must name regular files or directories without symlinks.');
      }
      return {
        absolute: candidate,
        filter: path.relative(workspace, candidate).split(path.sep).join('/'),
        directory: info.isDirectory(),
      };
    }),
  );
}

function execute(
  assets: Awaited<ReturnType<typeof loadAssets>>,
  args: string[],
  indices: string,
  signal: AbortSignal,
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
    const stop = (error: unknown) => {
      if (failure) return;
      failure = error;
      child.kill('SIGKILL');
    };
    const cancel = () => stop(signal.reason ?? new Error('ColGREP search was cancelled.'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (failure) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT) stop(new Error('ColGREP output exceeded its size limit.'));
      else stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (failure) return;
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAX_STDERR) {
        stop(new Error('ColGREP diagnostics exceeded their size limit.'));
        return;
      }
      stderr += chunk;
      // > Upstream falls back to host discovery when the managed library fails to load.
      if (stderr.includes('is not a loadable ONNX Runtime dylib')) {
        stop(new Error(`ColGREP could not load the managed ONNX Runtime library. ${REPAIR}`));
      }
    });
    child.once('error', (error) => {
      failure ??= new Error(`Could not launch managed ColGREP. ${REPAIR}`, { cause: error });
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
  });
}

function searchFailure(stderr: string): Error {
  if (
    /index lock|permission denied|read.only file system|not a directory|no space left/i.test(stderr)
  ) {
    return new Error(
      'ColGREP could not access its index or lock. Check AppRC cache permissions, disk space, and competing searches.',
    );
  }
  if (/regex|regular expression|look.around/i.test(stderr)) {
    return new Error(
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

function nativePath(file: string): string {
  if (process.platform !== 'win32') return file;
  if (file.startsWith('\\\\?\\UNC\\')) return '\\\\' + file.slice(8);
  return file.startsWith('\\\\?\\') ? file.slice(4) : file;
}

async function parseResults(
  stdout: string,
  workspace: string,
  paths: SearchPath[],
): Promise<Static<typeof ColgrepHitSchema>[]> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('ColGREP returned malformed JSON.');
  }
  if (!Value.Check(NATIVE_RESULTS, value)) throw new Error('ColGREP returned malformed results.');
  const results: Static<typeof ColgrepHitSchema>[] = [];
  for (const hit of value) {
    const file = nativePath(hit.unit.file);
    if (!path.isAbsolute(file) || !isWithin(workspace, file)) {
      throw new Error('ColGREP returned a path outside the authorized workspace.');
    }
    const actual = await realpath(file).catch(() => undefined);
    if (!actual || actual !== file) continue;
    const info = await lstat(actual).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (
      paths.length &&
      !paths.some(
        ({ absolute, directory }) =>
          absolute === actual || (directory && isWithin(absolute, actual)),
      )
    )
      continue;

    const best = hit.matches?.[0] ?? hit.unit;
    if (best.end_line < best.line) throw new Error('ColGREP returned an invalid line range.');
    const name = best.name.slice(0, 200);
    results.push({
      path: path.relative(workspace, actual).split(path.sep).join('/'),
      startLine: best.line,
      endLine: best.end_line,
      excerpt: hit.unit.code.slice(0, MAX_EXCERPT),
      ...(name ? { name } : {}),
    });
  }
  return results;
}

/** Search an authorized workspace, opening and refreshing its isolated index on demand. */
export function createColgrepProvider(options: ColgrepOptions = {}) {
  const verifiedFiles = new Map<string, VerifiedFile>();
  const deployment = options.deploymentDirectory ?? process.env.LTCOOK_COLGREP_DEPLOYMENT;
  const cache = options.cacheDirectory ?? process.env.LTCOOK_COLGREP_CACHE_DIR;
  return {
    async search(
      authorizedWorkspace: { readonly root: string },
      input: RepositorySearchRequest,
      callerSignal: AbortSignal,
    ) {
      if (!input.query.trim() || input.query.includes('\0') || input.pattern?.includes('\0')) {
        throw new Error('ColGREP queries and regular expressions must be nonempty text.');
      }
      // > With --pattern, ColGREP treats path-shaped query text as another search root.
      if (input.pattern && (/^[.~]/.test(input.query) || /[/\\]/.test(input.query))) {
        throw new Error(
          'Use a descriptive query and put file or directory restrictions in paths when using a regular expression.',
        );
      }
      const timeout = AbortSignal.timeout(options.timeoutMs ?? REPO_SEARCH_TIMEOUT_MS);
      const signal = AbortSignal.any([callerSignal, timeout]);
      try {
        const workspace = authorizedWorkspace.root;
        const identity = await workspaceIdentity(workspace);
        const ensureWorkspaceUnchanged = async () => {
          if ((await workspaceIdentity(workspace)) !== identity)
            throw new Error('The authorized workspace changed during repository search.');
        };
        const paths = await searchPaths(workspace, input.paths ?? []);
        const limit = Math.min(input.limit ?? 8, COLGREP_MAX_RESULTS);
        // > ColGREP also matches globs below the root. Verify exact literal scope on every hit.
        const filters = paths.some(({ filter }) => !filter) ? [] : paths;
        const assets = await loadAssets(deployment, verifiedFiles, signal);
        const indices = await getIndexDirectory(cache, workspace, identity);
        const args = [
          'search',
          '--json',
          '--model',
          assets.model,
          '--results',
          String((filters.length ? COLGREP_MAX_RESULTS : limit) + 1),
          ...(input.mode === 'semantic' ? ['--semantic-only'] : []),
          ...(input.pattern ? [`--pattern=${input.pattern}`] : []),
          ...filters.map(({ filter, directory }) => `--include=${filter}${directory ? '/**' : ''}`),
          '--',
          input.query,
          workspace,
        ];
        await ensureWorkspaceUnchanged();
        const result = await execute(assets, args, indices, signal);
        await ensureWorkspaceUnchanged();
        const capturedAt = new Date().toISOString();
        if (result.code !== 0) {
          if (
            result.stderr
              .split('\n')
              .some(
                (line) =>
                  line.trim() ===
                  'Error: colgrep index is currently being built, rely on grep for now.',
              )
          ) {
            return {
              value: { status: 'indexing' as const },
              diagnostics: [
                {
                  source: 'colgrep',
                  code: 'indexing',
                  message:
                    'Retry when indexing finishes. If this status persists, check that AppRC cache storage supports file locking.',
                },
              ],
              partial: true,
              truncated: false,
              capturedAt,
              freshness: 'stale' as const,
            };
          }
          throw searchFailure(result.stderr);
        }
        const results = await parseResults(result.stdout, workspace, paths);
        signal.throwIfAborted();
        return {
          value: { status: 'ready' as const, hits: results.slice(0, limit) },
          diagnostics: [],
          partial: false,
          truncated: results.length > limit,
          capturedAt,
          // > ColGREP may serve an existing index while another process updates it.
          freshness: 'cached' as const,
        };
      } catch (error) {
        if (timeout.aborted && !callerSignal.aborted) {
          throw new Error('ColGREP exceeded its time limit. Retry the search.');
        }
        throw error;
      }
    },
  };
}

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform, release } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { isWithin } from './path-containment.js';

export interface RiedContext {
  id: string;
  workspaceRoot: string;
}

export type RiedSection = 'repository' | 'git' | 'host' | 'recipes';
export interface RiedSnapshot {
  schemaVersion: 1;
  workspaceRoot: string;
  capturedAt: string;
  expiresAt: string;
  status: 'fresh' | 'partial' | 'stale';
  repository: {
    source: 'brief';
    languages: string[];
    manifests: { path: string; kind: string }[];
    dependencies: { name: string; scope: string }[];
    truncated: boolean;
  };
  git: {
    source: 'git';
    branch?: string;
    head?: string;
    changed: number;
    untracked: number;
    worktrees: number;
    capturedAt: string;
  };
  host: {
    source: 'node';
    os: string;
    wsl: boolean;
    architecture: string;
    tools: { name: string; available: boolean }[];
  };
  recipes: { source: 'just'; items: { name: string; module: string }[] };
  diagnostics: string[];
}

export type RiedRequest = { operation: 'summary' | 'section' | 'refresh'; section?: RiedSection };

type ProcessResult = { stdout: string; code: number };
const MAX_OUTPUT = 4 * 1024 * 1024;
const TTL_MS = 5 * 60 * 1000;
const TOOL_NAMES = ['git', 'just', 'uv', 'bun', 'node', 'python', 'podman'] as const;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 512 ? value : undefined;
}

function executable(name: string, pathValue: string, workspace: string): string | undefined {
  const extensions = platform() === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const entry of pathValue.split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    for (const extension of extensions) {
      const candidate = join(entry, `${name}${extension}`);
      try {
        const actual = realpathSync(candidate);
        if (statSync(actual).isFile() && !isWithin(workspace, actual, true)) return actual;
      } catch {
        // > An unavailable PATH entry is an observation, not a scan failure.
      }
    }
  }
  return undefined;
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  pathValue: string,
  timeout: number,
  limit = MAX_OUTPUT,
): Promise<ProcessResult> {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { PATH: pathValue, GIT_OPTIONAL_LOCKS: '0', NO_COLOR: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let bytes = 0;
    let stopped = false;
    const timer = setTimeout(() => {
      stopped = true;
      child.kill();
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) {
        stopped = true;
        child.kill();
      } else output += chunk;
    });
    child.stderr.on('data', () => undefined);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (stopped) reject(new Error('Discovery command exceeded its time or output limit'));
      else accept({ stdout: output, code: code ?? -1 });
    });
  });
}

function recipeNames(
  value: unknown,
  module: string,
  output: { name: string; module: string }[],
): void {
  const data = object(value);
  for (const name of Object.keys(object(data.recipes))) output.push({ name, module });
  for (const [name, nested] of Object.entries(object(data.modules))) {
    recipeNames(nested, module ? `${module} ${name}` : name, output);
  }
}

/** Runtime-owned, bounded discovery with one AppRC-backed cache. */
export class RiedService {
  private readonly pending = new Map<string, Promise<RiedSnapshot>>();
  constructor(
    private readonly cacheDirectory: string,
    private readonly briefExecutable: string | undefined,
    private readonly shellEnvironment: (sessionId: string) => Record<string, string> | undefined,
  ) {}

  private key(
    session: RiedContext,
    wsl: boolean,
  ): { workspace: string; pathValue: string; file: string } {
    const workspace = realpathSync(session.workspaceRoot);
    const pathValue = this.shellEnvironment(session.id)?.PATH ?? process.env.PATH ?? '';
    const digest = createHash('sha256')
      .update(JSON.stringify([workspace, pathValue, platform(), arch(), wsl, 'brief-0.16.0']))
      .digest('hex');
    return { workspace, pathValue, file: join(this.cacheDirectory, `${digest}.json`) };
  }

  private async git(workspace: string, pathValue: string): Promise<RiedSnapshot['git']> {
    const capturedAt = new Date().toISOString();
    const git = executable('git', pathValue, workspace);
    if (!git) throw new Error('Git is unavailable outside the workspace');
    const common = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];
    const [head, branch, status, worktrees] = await Promise.all([
      run(git, [...common, 'rev-parse', 'HEAD'], workspace, pathValue, 3000, 1024),
      run(git, [...common, 'branch', '--show-current'], workspace, pathValue, 3000, 1024),
      run(
        git,
        [
          ...common,
          'status',
          '--porcelain=v1',
          '--no-renames',
          '-z',
          '--untracked-files=normal',
          '--ignore-submodules=all',
        ],
        workspace,
        pathValue,
        3000,
        1024 * 1024,
      ),
      run(
        git,
        [...common, 'worktree', 'list', '--porcelain', '-z'],
        workspace,
        pathValue,
        3000,
        1024 * 1024,
      ),
    ]);
    if ([head, branch, status, worktrees].some((item) => item.code !== 0))
      throw new Error('Git discovery failed');
    const entries = status.stdout.split('\0').filter(Boolean);
    return {
      source: 'git',
      head: head.stdout.trim(),
      branch: branch.stdout.trim() || '(detached)',
      changed: entries.filter((entry) => !entry.startsWith('??')).length,
      untracked: entries.filter((entry) => entry.startsWith('??')).length,
      worktrees: worktrees.stdout.split('\0').filter((entry) => entry.startsWith('worktree '))
        .length,
      capturedAt,
    };
  }

  private async scan(workspace: string, pathValue: string, wsl: boolean): Promise<RiedSnapshot> {
    const capturedAt = new Date().toISOString();
    const diagnostics: string[] = [];
    const repository: RiedSnapshot['repository'] = {
      source: 'brief',
      languages: [],
      manifests: [],
      dependencies: [],
      truncated: false,
    };
    const git: RiedSnapshot['git'] = {
      source: 'git',
      changed: 0,
      untracked: 0,
      worktrees: 0,
      capturedAt,
    };
    const recipes: RiedSnapshot['recipes'] = { source: 'just', items: [] };
    const host: RiedSnapshot['host'] = {
      source: 'node',
      os: platform(),
      wsl,
      architecture: arch(),
      tools: TOOL_NAMES.map((name) => ({
        name,
        available: executable(name, pathValue, workspace) !== undefined,
      })),
    };
    const brief = this.briefExecutable
      ? existsSync(this.briefExecutable)
        ? this.briefExecutable
        : undefined
      : executable('brief', pathValue, workspace);
    if (!brief) diagnostics.push('brief v0.16.0 is unavailable; run LTCook setup or repair');
    else {
      try {
        const version = await run(brief, ['--version'], workspace, pathValue, 3000, 1024);
        if (version.code !== 0 || !version.stdout.includes('0.16.0'))
          throw new Error('brief version does not match v0.16.0');
        const result = await run(
          brief,
          [
            '--json',
            '--scan-depth',
            '8',
            '--scan-limit',
            '10000',
            '--line-count-timeout',
            '1s',
            workspace,
          ],
          workspace,
          pathValue,
          20000,
        );
        if (result.code !== 0) throw new Error('brief discovery failed');
        const data = object(JSON.parse(result.stdout));
        repository.languages = (Array.isArray(data.languages) ? data.languages : [])
          .map((item) => safeString(object(item).name))
          .filter((item): item is string => item !== undefined)
          .slice(0, 100);
        repository.manifests = (Array.isArray(data.manifests) ? data.manifests : [])
          .map((item) => object(item))
          .flatMap((item) => {
            const path = safeString(item.path);
            return path && !isAbsolute(path) && !path.split(/[\\/]/).includes('..')
              ? [{ path, kind: safeString(item.kind) ?? 'unknown' }]
              : [];
          })
          .slice(0, 1000);
        repository.dependencies = (Array.isArray(data.dependencies) ? data.dependencies : [])
          .map((item) => object(item))
          .flatMap((item) => {
            const name = safeString(item.name);
            return name ? [{ name, scope: safeString(item.scope) ?? 'unknown' }] : [];
          })
          .slice(0, 1000);
        repository.truncated = object(data.stats).scan_truncated === true;
        if (repository.truncated) diagnostics.push('brief scan reached its configured limit');
      } catch (error) {
        diagnostics.push(
          error instanceof SyntaxError
            ? 'brief returned malformed JSON'
            : error instanceof Error
              ? error.message
              : 'brief discovery failed',
        );
      }
    }
    try {
      Object.assign(git, await this.git(workspace, pathValue));
    } catch {
      diagnostics.push('Git status is unavailable or exceeded its limit');
    }
    const just = executable('just', pathValue, workspace);
    if (!just) diagnostics.push('Just is unavailable outside the workspace');
    else {
      try {
        const result = await run(
          just,
          ['--dump', '--dump-format', 'json', '--no-dotenv'],
          workspace,
          pathValue,
          3000,
          1024 * 1024,
        );
        if (result.code !== 0) throw new Error('Just metadata failed');
        recipeNames(JSON.parse(result.stdout), '', recipes.items);
        recipes.items = recipes.items.slice(0, 1000);
      } catch {
        diagnostics.push('Just metadata is unavailable or exceeded its limit');
      }
    }
    return {
      schemaVersion: 1,
      workspaceRoot: workspace,
      capturedAt,
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
      status: diagnostics.length ? 'partial' : 'fresh',
      repository,
      git,
      host,
      recipes,
      diagnostics,
    };
  }

  async get(session: RiedContext, request: RiedRequest): Promise<unknown> {
    const wsl =
      platform() === 'linux' &&
      Boolean(
        process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME || /microsoft/i.test(release()),
      );
    const { workspace, pathValue, file } = this.key(session, wsl);
    if (!statSync(workspace).isDirectory())
      throw new Error('RIED requires an existing workspace directory');
    let snapshot: RiedSnapshot | undefined;
    if (request.operation !== 'refresh') {
      try {
        const parsed = object(JSON.parse(readFileSync(file, 'utf8')));
        if (parsed.schemaVersion === 1 && parsed.workspaceRoot === workspace)
          snapshot = parsed as unknown as RiedSnapshot;
      } catch {
        /* > An absent or unsupported cache is refreshed, never migrated. */
      }
    }
    if (!snapshot || Date.parse(snapshot.expiresAt) <= Date.now()) {
      const key = basename(file);
      let pending = this.pending.get(key);
      if (!pending) {
        pending = this.scan(workspace, pathValue, wsl);
        this.pending.set(key, pending);
      }
      try {
        snapshot = await pending;
        mkdirSync(this.cacheDirectory, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.partial`;
        writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, file);
      } catch (error) {
        if (!snapshot) throw error;
        snapshot = {
          ...snapshot,
          status: 'stale',
          diagnostics: [...snapshot.diagnostics, 'RIED refresh failed'],
        };
      } finally {
        this.pending.delete(key);
      }
    }
    try {
      snapshot = { ...snapshot, git: await this.git(workspace, pathValue) };
    } catch {
      snapshot = {
        ...snapshot,
        status: 'partial',
        diagnostics: [...snapshot.diagnostics, 'Current Git status is unavailable'],
      };
    }
    if (request.operation === 'section') {
      if (!request.section) throw new Error('RIED section is required');
      return {
        schemaVersion: 1,
        workspaceRoot: workspace,
        capturedAt: snapshot.capturedAt,
        status: snapshot.status,
        section: request.section,
        value: snapshot[request.section],
        diagnostics: snapshot.diagnostics,
      };
    }
    if (request.operation === 'summary')
      return {
        schemaVersion: 1,
        workspaceRoot: workspace,
        capturedAt: snapshot.capturedAt,
        status: snapshot.status,
        host: { os: snapshot.host.os, wsl: snapshot.host.wsl },
        languages: snapshot.repository.languages,
        manifests: snapshot.repository.manifests.length,
        branch: snapshot.git.branch,
        changed: snapshot.git.changed,
        untracked: snapshot.git.untracked,
        recipes: snapshot.recipes.items.length,
        diagnostics: snapshot.diagnostics,
      };
    return snapshot;
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import path from 'node:path';
import { readBrief, type RepositoryInventory } from './providers/brief.js';
import { readRepositoryMap } from './filesystem.js';
import { readGit, type GitDiscovery } from './providers/git.js';
import { readRepositoryOutline } from './outline.js';
import { findRepositoryExecutable } from './process.js';
import { readRecipes, type RepositoryRecipes } from './providers/recipes.js';
import { validateRiedRequest, type RiedRequest } from './requests.js';
import type { RepositoryDiagnostic, RepositoryResult } from './results.js';
import { openRepositoryWorkspace, type RepositoryWorkspace } from './workspace.js';

interface RiedContext {
  id: string;
  workspaceRoot: string;
  boundWorkspace?: true;
}

interface HostInventory {
  source: 'node';
  os: string;
  wsl: boolean;
  architecture: string;
  tools: { name: string; available: boolean }[];
}

interface CachedDiscovery {
  version: 2;
  workspaceRoot: string;
  capturedAt: string;
  expiresAt: number;
  repository: RepositoryInventory;
  host: HostInventory;
  recipes: RepositoryRecipes;
  diagnostics: RepositoryDiagnostic[];
  partial: boolean;
  truncated: boolean;
}

export interface RiedSnapshot {
  schemaVersion: 1;
  workspaceRoot: string;
  capturedAt: string;
  expiresAt: string;
  status: 'fresh' | 'partial' | 'stale';
  repository: RepositoryInventory;
  git: GitDiscovery;
  host: HostInventory;
  recipes: RepositoryRecipes;
  diagnostics: string[];
}

const TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const tools = ['git', 'just', 'uv', 'bun', 'node', 'python', 'podman'] as const;

function hostInventory(workspace: RepositoryWorkspace, pathValue: string): HostInventory {
  return {
    source: 'node',
    os: platform(),
    wsl:
      platform() === 'linux' &&
      Boolean(
        process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME || /microsoft/i.test(release()),
      ),
    architecture: arch(),
    tools: tools.map((name) => ({
      name,
      available: findRepositoryExecutable(name, pathValue, workspace) !== undefined,
    })),
  };
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function validCache(value: unknown, root: string): value is CachedDiscovery {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CachedDiscovery>;
  return (
    record.version === 2 &&
    record.workspaceRoot === root &&
    typeof record.capturedAt === 'string' &&
    Number.isSafeInteger(record.expiresAt) &&
    typeof record.partial === 'boolean' &&
    typeof record.truncated === 'boolean' &&
    stringList(record.repository?.languages) &&
    Array.isArray(record.repository?.manifests) &&
    stringList(record.repository?.layout?.sourceDirs) &&
    stringList(record.repository?.layout?.testDirs) &&
    Array.isArray(record.recipes?.items) &&
    typeof record.host?.os === 'string' &&
    Array.isArray(record.diagnostics) &&
    record.diagnostics.every((item) => item && typeof item.message === 'string')
  );
}

/** Owns RIED's AppRC cache and composes the bounded repository providers. */
export class RiedService {
  private readonly pending = new Map<string, Promise<CachedDiscovery>>();
  constructor(
    private readonly cacheDirectory: string,
    private readonly briefExecutable: string | undefined,
    private readonly shellEnvironment: (sessionId: string) => Record<string, string> | undefined,
  ) {}

  private toolPath(context: RiedContext): string {
    return this.shellEnvironment(context.id)?.PATH ?? process.env.PATH ?? '';
  }

  private async scan(
    workspace: RepositoryWorkspace,
    pathValue: string,
    host: HostInventory,
    file: string,
  ): Promise<CachedDiscovery> {
    const capturedAt = new Date().toISOString();
    const [repository, recipes] = await Promise.all([
      readBrief(workspace, pathValue, this.briefExecutable),
      readRecipes(workspace, pathValue),
    ]);
    const result: CachedDiscovery = {
      version: 2,
      workspaceRoot: workspace.root,
      capturedAt,
      expiresAt: Date.now() + TTL_MS,
      host,
      repository: repository.value,
      recipes: recipes.value,
      diagnostics: [...repository.diagnostics, ...recipes.diagnostics],
      partial: repository.partial || recipes.partial,
      truncated: repository.truncated || recipes.truncated,
    };
    const temporary = `${file}.${randomUUID()}.partial`;
    try {
      await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      result.partial = true;
      result.diagnostics.push({
        source: 'cache',
        code: 'write-failed',
        message: 'Repository metadata could not be cached',
      });
    }
    return result;
  }

  private async metadata(workspace: RepositoryWorkspace, pathValue: string, refresh: boolean) {
    const host = hostInventory(workspace, pathValue);
    const identity = await stat(workspace.root);
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          workspace.root,
          identity.dev,
          identity.ino,
          pathValue,
          host.os,
          host.architecture,
          host.wsl,
          this.briefExecutable,
          'ried-2',
        ]),
      )
      .digest('hex');
    const file = path.join(this.cacheDirectory, `${digest}.json`);
    let cached: CachedDiscovery | undefined;
    try {
      if ((await stat(file)).size <= MAX_CACHE_BYTES) {
        const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (validCache(parsed, workspace.root)) cached = parsed;
      }
    } catch {
      // > Missing, invalid, and older cache files are rebuilt on demand.
    }

    if (!refresh && cached && cached.expiresAt > Date.now())
      return { value: cached, freshness: 'cached' as const };
    let pending = this.pending.get(file);
    if (!pending) {
      pending = this.scan(workspace, pathValue, host, file).finally(() =>
        this.pending.delete(file),
      );
      this.pending.set(file, pending);
    }
    try {
      return { value: await pending, freshness: 'current' as const };
    } catch (error) {
      if (!cached) throw error;
      return {
        value: {
          ...cached,
          diagnostics: [
            ...cached.diagnostics,
            { source: 'cache', code: 'refresh-failed', message: 'RIED refresh failed' },
          ],
        },
        freshness: 'stale' as const,
      };
    }
  }

  private async openWorkspace(context: RiedContext): Promise<RepositoryWorkspace> {
    const workspace = await openRepositoryWorkspace(context.workspaceRoot);
    if (context.boundWorkspace && path.relative(workspace.root, context.workspaceRoot) !== '') {
      throw new Error(
        'The bound repository workspace no longer resolves to its recorded directory',
      );
    }
    return workspace;
  }

  async warm(context: RiedContext): Promise<void> {
    const workspace = await this.openWorkspace(context);
    await this.metadata(workspace, this.toolPath(context), false);
  }

  async get(context: RiedContext, input: RiedRequest, workspaceFileAccess = true) {
    const request = validateRiedRequest(input);
    if (request.operation === 'outline' && !workspaceFileAccess)
      throw new Error('Source outlines require trusted workspace file-read access');

    const workspace = await this.openWorkspace(context);
    const pathValue = this.toolPath(context);
    if (request.operation === 'map') {
      const map = await readRepositoryMap(workspace, request.target ?? '.', {
        maxDepth: request.maxDepth ?? 3,
        maxEntries: request.maxEntries ?? 100,
      });
      return this.detail(workspace, 'map', map);
    }
    if (request.operation === 'outline' && request.target) {
      const outline = await readRepositoryOutline(
        workspace,
        request.target,
        pathValue,
        this.briefExecutable,
      );
      return this.detail(workspace, 'outline', outline);
    }
    if (request.operation === 'section' && request.section === 'git') {
      const git = await readGit(workspace, pathValue, {
        detailed: true,
        ...(request.base ? { base: request.base } : {}),
      });
      return { ...this.detail(workspace, 'section', git), section: 'git' };
    }

    const metadata = this.metadata(workspace, pathValue, request.operation === 'refresh');
    const gitResult = request.operation === 'section' ? undefined : readGit(workspace, pathValue);
    const [{ value: snapshot, freshness }, git] = await Promise.all([metadata, gitResult]);
    const diagnostics = [...snapshot.diagnostics, ...(git?.diagnostics ?? [])].map(
      ({ message }) => message,
    );
    const status =
      freshness === 'stale'
        ? ('stale' as const)
        : snapshot.partial || snapshot.truncated || git?.partial || git?.truncated
          ? ('partial' as const)
          : ('fresh' as const);
    const shared = {
      schemaVersion: 1 as const,
      workspaceRoot: workspace.root,
      capturedAt: snapshot.capturedAt,
      status,
      diagnostics,
    };
    if (request.operation === 'section' && request.section && request.section !== 'git')
      return { ...shared, section: request.section, value: snapshot[request.section], freshness };
    if (request.operation === 'summary' && git)
      return {
        ...shared,
        diagnostics: diagnostics.slice(0, 6),
        host: { os: snapshot.host.os, wsl: snapshot.host.wsl },
        languages: snapshot.repository.languages
          .slice(0, 12)
          .map((language) => language.slice(0, 60)),
        manifests: snapshot.repository.manifests.length,
        layout: {
          sourceDirs: snapshot.repository.layout.sourceDirs
            .slice(0, 3)
            .map((directory) => directory.slice(0, 80)),
          testDirs: snapshot.repository.layout.testDirs
            .slice(0, 3)
            .map((directory) => directory.slice(0, 80)),
        },
        branch: git.value.branch,
        changed: git.value.changed,
        untracked: git.value.untracked,
        recipes: snapshot.recipes.items.length,
      };
    if (!git) throw new Error('Invalid RIED operation');
    return {
      ...shared,
      expiresAt: new Date(snapshot.expiresAt).toISOString(),
      repository: snapshot.repository,
      git: git.value,
      host: snapshot.host,
      recipes: snapshot.recipes,
    } satisfies RiedSnapshot;
  }

  private detail<T>(
    workspace: RepositoryWorkspace,
    operation: string,
    result: RepositoryResult<T>,
  ) {
    return {
      schemaVersion: 1 as const,
      workspaceRoot: workspace.root,
      operation,
      capturedAt: result.capturedAt,
      freshness: result.freshness,
      partial: result.partial,
      truncated: result.truncated,
      status: result.partial || result.truncated ? ('partial' as const) : ('fresh' as const),
      diagnostics: result.diagnostics.map(({ message }) => message),
      value: result.value,
    };
  }
}

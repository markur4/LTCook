import { mkdir, mkdtemp, opendir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertRepositoryPathVisible, readBoundedFile } from '../filesystem.js';
import {
  findRepositoryExecutable,
  RepositoryCommandError,
  runRepositoryCommand,
} from '../process.js';
import type { RepositoryResult } from '../results.js';
import { openRepositoryWorkspace, type RepositoryWorkspace } from '../workspace.js';
import type { RepositoryFilter } from '../filter.js';

export type RepositoryRecipes = { source: 'just'; items: { name: string; module: string }[] };

const MAX_SOURCES = 64;
const MAX_SOURCE_BYTES = 1024 * 1024;
const JUSTFILE_NAMES = new Set(['justfile', '.justfile']);

class JustSourceError extends Error {
  constructor(
    readonly code: 'source-scope' | 'source-limit',
    message: string,
  ) {
    super(message);
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function recipeSource(workspace: RepositoryWorkspace, relative: string) {
  return workspace.resolvePath(relative, { allowRoot: true }).catch(() => undefined);
}

async function justfiles(
  workspace: RepositoryWorkspace,
  relative: string,
  includeModFile: boolean,
  budget: { entries: number },
  filter?: RepositoryFilter,
  onFilteredFile?: () => void,
): Promise<string[]> {
  if (filter && !filter.allowsDirectory(relative)) return [];
  const directory = await recipeSource(workspace, relative);
  if (directory?.kind !== 'directory') return [];
  const output: string[] = [];
  for await (const entry of await opendir(directory.absolute)) {
    if (--budget.entries < 0)
      throw new JustSourceError('source-limit', 'Justfile lookup reached its directory limit');
    if (
      !JUSTFILE_NAMES.has(entry.name.toLowerCase()) &&
      !(includeModFile && entry.name === 'mod.just')
    )
      continue;
    const file = path.posix.join(relative, entry.name);
    if (filter && !filter.allowsPath(file)) {
      if (entry.isFile()) onFilteredFile?.();
      continue;
    }
    if (entry.isSymbolicLink())
      throw new JustSourceError('source-scope', 'Just discovery omits linked source files');
    if (entry.isFile()) output.push(file);
  }
  return output;
}

// > Just compiles imports and modules even for --dump. Only stage literal, in-scope sources.
function justSources(source: Buffer, relative: string) {
  const imports: { path: string; module: boolean; implicit: boolean; optional: boolean }[] = [];
  for (const line of new TextDecoder('utf-8', { fatal: true }).decode(source).split(/\r?\n/)) {
    if (!/^(?:import|mod)(?![\w-])/.test(line) || /^(?:import|mod)[ \t]*:/.test(line)) continue;
    const imported = /^import[ \t]*(\?)?[ \t]*(['"])([^'"\\\0]+)\2[ \t]*(?:#.*)?$/.exec(line);
    const module =
      /^mod[ \t]*(\?)?[ \t]+([\w-]+)(?:[ \t]+(['"])([^'"\\\0]+)\3)?[ \t]*(?:#.*)?$/.exec(line);
    const input = imported?.[3] ?? module?.[4] ?? module?.[2];
    if (
      !input ||
      input.startsWith('~') ||
      path.isAbsolute(input) ||
      path.win32.isAbsolute(input) ||
      /^[a-z]:/i.test(input)
    ) {
      throw new JustSourceError(
        'source-scope',
        'Just imports and modules must use workspace-relative literal paths',
      );
    }
    const resolved = path.posix.join(path.posix.dirname(relative), input);
    if (resolved === '..' || resolved.startsWith('../')) {
      throw new JustSourceError(
        'source-scope',
        'Just imports and modules must stay inside the workspace',
      );
    }
    imports.push({
      path: resolved,
      module: Boolean(module),
      implicit: Boolean(module && !module[4]),
      optional: Boolean(imported?.[1] || module?.[1]),
    });
    if (imports.length > MAX_SOURCES)
      throw new JustSourceError('source-limit', 'Justfile references reached their source limit');
  }
  return imports;
}

async function stageJustSources(
  workspace: RepositoryWorkspace,
  stage: string,
  filter?: RepositoryFilter,
): Promise<{ found: boolean; missingFilteredDependency: boolean }> {
  const budget = { entries: 10000, references: MAX_SOURCES };
  const files = new Set(await justfiles(workspace, '.', false, budget, filter));
  if (!files.size) return { found: false, missingFilteredDependency: false };
  let remaining = MAX_SOURCE_BYTES;
  let missingFilteredDependency = false;
  for (const relative of files) {
    if (files.size > MAX_SOURCES)
      throw new JustSourceError('source-limit', 'Justfiles reached their source limit');
    assertRepositoryPathVisible(relative);
    const source = await workspace.resolvePath(relative, { kind: 'file' });
    const data = await readBoundedFile(source.absolute, remaining);
    if (!data) throw new JustSourceError('source-limit', 'Justfiles reached their input limit');
    remaining -= data.length;
    for (const entry of justSources(data, relative)) {
      if (--budget.references < 0)
        throw new JustSourceError('source-limit', 'Justfile references reached their source limit');
      const candidate = await recipeSource(
        workspace,
        entry.implicit ? `${entry.path}.just` : entry.path,
      );
      let filtered = false;
      let available = false;
      if (candidate?.kind === 'file') {
        if (filter && !filter.allowsPath(candidate.relative)) filtered = true;
        else {
          available = true;
          files.add(candidate.relative);
        }
      }
      if (entry.module && (entry.implicit || candidate?.kind !== 'file')) {
        if (filter && !filter.allowsDirectory(entry.path)) filtered = true;
        else {
          const modules = await justfiles(workspace, entry.path, true, budget, filter, () => {
            filtered = true;
          });
          available ||= modules.length > 0;
          for (const module of modules) files.add(module);
        }
      }
      missingFilteredDependency ||= filtered && !available && !entry.optional;
    }
    const destination = path.join(stage, source.relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data, { flag: 'wx', mode: 0o600 });
  }
  return { found: true, missingFilteredDependency };
}

export async function readRecipes(
  workspace: RepositoryWorkspace,
  pathValue: string,
  filter?: RepositoryFilter,
): Promise<RepositoryResult<RepositoryRecipes>> {
  const result: RepositoryResult<RepositoryRecipes> = {
    provider: 'just',
    value: { source: 'just', items: [] },
    diagnostics: [],
    partial: false,
    truncated: false,
    capturedAt: new Date().toISOString(),
    freshness: 'current',
  };
  const executable = findRepositoryExecutable('just', pathValue, workspace);
  if (!executable) {
    result.partial = true;
    result.diagnostics.push({
      source: 'just',
      code: 'unavailable',
      message: 'Just is unavailable outside the workspace',
    });
    return result;
  }
  let stage: string | undefined;
  try {
    stage = await mkdtemp(path.join(tmpdir(), 'ltcook-just-'));
    const staged = await openRepositoryWorkspace(stage);
    const stagedSources = await stageJustSources(workspace, staged.root, filter);
    if (!stagedSources.found) return result;
    if (stagedSources.missingFilteredDependency) {
      result.partial = true;
      result.diagnostics.push({
        source: 'just',
        code: 'filtered-source-dependency',
        message: 'Recipe discovery omitted imports or modules excluded by the path filter.',
      });
      return result;
    }
    const listing = await runRepositoryCommand(
      executable,
      ['--dump', '--dump-format', 'json', '--no-dotenv'],
      staged,
      '',
      { timeoutMs: 3000, maxBytes: 1024 * 1024, env: { JUST_CEILING: staged.root } },
    );
    if (listing.code !== 0) throw new Error('Just metadata failed');
    const modules = [{ value: object(JSON.parse(listing.stdout)), name: '' }];
    for (const { value, name: module } of modules) {
      for (const name of Object.keys(object(value.recipes))) {
        if (result.value.items.length >= 1000) {
          result.truncated = true;
          break;
        }
        if (name.length <= 256) result.value.items.push({ name, module });
      }
      if (result.truncated) break;
      for (const [name, nested] of Object.entries(object(value.modules))) {
        const qualified = module ? `${module} ${name}` : name;
        if (qualified.length <= 256) modules.push({ value: object(nested), name: qualified });
      }
    }
    if (result.truncated)
      result.diagnostics.push({
        source: 'just',
        code: 'recipe-limit',
        message: 'Just recipe listing reached its limit',
      });
  } catch (error) {
    result.partial = true;
    result.truncated =
      (error instanceof RepositoryCommandError && error.code === 'output-limit') ||
      (error instanceof JustSourceError && error.code === 'source-limit');
    result.diagnostics.push({
      source: 'just',
      code: error instanceof JustSourceError ? error.code : 'metadata-unavailable',
      message:
        error instanceof JustSourceError
          ? error.message
          : 'Just metadata is unavailable or exceeded its limit',
    });
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
  return result;
}

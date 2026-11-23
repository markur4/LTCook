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
): Promise<string[]> {
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
    if (entry.isSymbolicLink())
      throw new JustSourceError('source-scope', 'Just discovery omits linked source files');
    if (entry.isFile()) output.push(path.posix.join(relative, entry.name));
  }
  return output;
}

// > Just compiles imports and modules even for --dump. Only stage literal, in-scope sources.
function justSources(source: Buffer, relative: string) {
  const imports: { path: string; module: boolean; implicit: boolean }[] = [];
  for (const line of new TextDecoder('utf-8', { fatal: true }).decode(source).split(/\r?\n/)) {
    if (!/^(?:import|mod)(?![\w-])/.test(line) || /^(?:import|mod)[ \t]*:/.test(line)) continue;
    const imported = /^import[ \t]*\??[ \t]*(['"])([^'"\\\0]+)\1[ \t]*(?:#.*)?$/.exec(line);
    const module = /^mod[ \t]*\??[ \t]+([\w-]+)(?:[ \t]+(['"])([^'"\\\0]+)\2)?[ \t]*(?:#.*)?$/.exec(
      line,
    );
    const input = imported?.[2] ?? module?.[3] ?? module?.[1];
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
      implicit: Boolean(module && !module[3]),
    });
    if (imports.length > MAX_SOURCES)
      throw new JustSourceError('source-limit', 'Justfile references reached their source limit');
  }
  return imports;
}

async function stageJustSources(workspace: RepositoryWorkspace, stage: string): Promise<boolean> {
  const budget = { entries: 10000, references: MAX_SOURCES };
  const files = new Set(await justfiles(workspace, '.', false, budget));
  if (!files.size) return false;
  let remaining = MAX_SOURCE_BYTES;
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
      if (candidate?.kind === 'file') files.add(candidate.relative);
      if (entry.module && (entry.implicit || candidate?.kind !== 'file')) {
        for (const module of await justfiles(workspace, entry.path, true, budget))
          files.add(module);
      }
    }
    const destination = path.join(stage, source.relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data, { flag: 'wx', mode: 0o600 });
  }
  return true;
}

export async function readRecipes(
  workspace: RepositoryWorkspace,
  pathValue: string,
): Promise<RepositoryResult<RepositoryRecipes>> {
  const result: RepositoryResult<RepositoryRecipes> = {
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
    if (!(await stageJustSources(workspace, staged.root))) return result;
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

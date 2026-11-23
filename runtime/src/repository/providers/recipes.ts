import {
  findRepositoryExecutable,
  RepositoryCommandError,
  runRepositoryCommand,
} from '../process.js';
import type { RepositoryResult } from '../results.js';
import type { RepositoryWorkspace } from '../workspace.js';

export type RepositoryRecipes = { source: 'just'; items: { name: string; module: string }[] };

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  try {
    const listing = await runRepositoryCommand(
      executable,
      ['--dump', '--dump-format', 'json', '--no-dotenv'],
      workspace,
      pathValue,
      { timeoutMs: 3000, maxBytes: 1024 * 1024, env: { JUST_CEILING: workspace.root } },
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
    result.truncated = error instanceof RepositoryCommandError && error.code === 'output-limit';
    result.diagnostics.push({
      source: 'just',
      code: 'metadata-unavailable',
      message: 'Just metadata is unavailable or exceeded its limit',
    });
  }
  return result;
}

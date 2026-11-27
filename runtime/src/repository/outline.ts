import { resolveBrief } from './providers/brief.js';
import { stageRepositoryFiles } from './filesystem.js';
import type { RepositoryFilter } from './filter.js';
import { RepositoryCommandError, runRepositoryCommand } from './process.js';
import type { RepositoryDiagnostic, RepositoryResult } from './results.js';
import type { RepositoryWorkspace } from './workspace.js';

const extensions = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.go',
  '.h',
  '.hpp',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.mjs',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.swift',
  '.ts',
  '.tsx',
  '.vue',
]);
const maxFiles = 12;
const maxCharacters = 12000;

export async function readRepositoryOutline(
  workspace: RepositoryWorkspace,
  target: string,
  pathValue: string,
  configuredBrief?: string,
  filter?: RepositoryFilter,
): Promise<RepositoryResult<{ target: string; outline: string }>> {
  const selected = await workspace.resolvePath(target, { allowRoot: true });
  const capturedAt = new Date().toISOString();
  const diagnostics: RepositoryDiagnostic[] = [];
  let outline = '';
  let truncated = false;

  try {
    const brief = await resolveBrief(workspace, pathValue, configuredBrief);
    const staged = await stageRepositoryFiles(workspace, {
      target,
      maxDepth: 5,
      maxEntries: 1000,
      maxFiles,
      maxFileBytes: 32 * 1024,
      maxBytes: 384 * 1024,
      extensions,
      filter,
    });
    try {
      truncated = staged.truncated;
      if (staged.partial)
        diagnostics.push({
          source: 'filesystem',
          code: 'unreadable',
          message: 'Some source files could not be read',
        });
      if (staged.fileCount === 0) {
        diagnostics.push({
          source: 'brief',
          code: 'no-source',
          message: 'No supported source files fit the outline limits',
        });
      } else {
        const result = await runRepositoryCommand(
          brief,
          ['outline', '-max-files', String(maxFiles), '-max-file-size', '32768', '.'],
          staged.workspace,
          '',
          { timeoutMs: 5000, maxBytes: 512 * 1024 },
        );
        if (result.code !== 0) throw new Error('brief outline failed');
        outline = result.stdout.trimEnd();
        if (outline.length > maxCharacters) {
          truncated = true;
          outline = outline.slice(0, maxCharacters);
        }
      }
    } finally {
      await staged.dispose();
    }
  } catch (error) {
    if (error instanceof RepositoryCommandError && error.code === 'output-limit') truncated = true;
    diagnostics.push({
      source: 'brief',
      code: 'outline-unavailable',
      message:
        error instanceof RepositoryCommandError
          ? error.message
          : 'brief outline is unavailable for the selected target',
    });
  }
  if (truncated)
    diagnostics.push({
      source: 'brief',
      code: 'outline-limit',
      message: 'Source outline reached its file, scan, or output limit',
    });
  return {
    provider: 'brief',
    value: { target: selected.relative, outline },
    capturedAt,
    freshness: 'current',
    partial: diagnostics.some(({ code }) => code !== 'outline-limit'),
    truncated,
    ...(filter && { filter: filter.report(truncated) }),
    diagnostics,
  };
}

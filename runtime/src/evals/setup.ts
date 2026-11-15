import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EvalSetup } from './contracts.js';

export const EVAL_MODEL = 'ltcook-spark-x2.6-4b-q8_0-ctx8192:latest';
export const FIXTURE_REVISION = 'agent-evals-v3';
export const EVAL_COMPACTION = { enabled: true, reserveTokens: 2048, keepRecentTokens: 1024 };
export const EVAL_MODEL_COMPAT = { supportsDeveloperRole: false };
export const EVALUATION_EXECUTION_CONTEXT = `# Disposable evaluation execution scope
The authenticated LTCook runtime has authorized the predefined scenario in the Session and Pass below. Within this disposable scope, scheduling and execution use the existing runtime authorization without interactive Design/Plan approval. Do not request or fabricate user answers or approvals. Interactive Plan approval is outside this evaluation's coverage.
Keep all full standing instructions and member restrictions. Follow the assigned scheduling handoff and scenario; runtime tool authorization remains authoritative. This scope grants no permission in other Sessions or Passes.`;
export type EvaluationContext = {
  teamSelection: string;
  guidanceDirectory: string;
  webConfiguration: Record<string, unknown>;
  limitations: string[];
};
export type SnapshotEntry = { path: string; included: boolean; reason?: string; sha256?: string };
const secret =
  /(^|\/)(\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|.*\.(?:pem|key)|\.ssh|\.aws|\.azure|\.gnupg)(\/|$)/i;
const debris = /(^|\/)(\.git|\.ltcook-evals|node_modules|\.venv|__pycache__|\.cache)(\/|$)/;
const relevantIgnored =
  /(^|\/)(AGENTS\.md|CLAUDE\.md|\.pi\/(?:skills|rules|prompts)\/|\.ltcook\/(?:rules|skills)\/)/;
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Copies file contents, never worktree links or credential-bearing repository metadata. */
export async function snapshotWorkspace(
  source: string | undefined,
  destination: string,
): Promise<SnapshotEntry[]> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (!source) return [];
  const root = await realpath(source);
  if (root === path.parse(root).root)
    throw new Error('Filesystem roots cannot be evaluation workspaces');
  const entries: SnapshotEntry[] = [];
  const ignored = spawnSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1' },
    },
  );
  const ignoredPaths = new Set(
    ignored.status === 0 ? ignored.stdout.split('\0').filter(Boolean) : [],
  );
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (secret.test(name) || debris.test(name)) {
        entries.push({ path: name, included: false, reason: 'credential or generated state' });
        continue;
      }
      if (entry.isSymbolicLink()) {
        entries.push({ path: name, included: false, reason: 'symbolic link excluded' });
        continue;
      }
      if (entry.isDirectory()) {
        try {
          await lstat(path.join(root, name, '.git'));
          entries.push({ path: name, included: false, reason: 'nested repository excluded' });
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await walk(name);
        continue;
      }
      if (!entry.isFile()) {
        entries.push({ path: name, included: false, reason: 'special file excluded' });
        continue;
      }
      if (ignoredPaths.has(name) && !relevantIgnored.test(name)) {
        entries.push({ path: name, included: false, reason: 'unselected ignored file' });
        continue;
      }
      const content = await readFile(path.join(root, name));
      await mkdir(path.dirname(path.join(destination, name)), { recursive: true });
      await writeFile(path.join(destination, name), content, {
        mode: (await lstat(path.join(root, name))).mode & 0o777,
      });
      entries.push({ path: name, included: true, sha256: hash(content) });
    }
  };
  await walk('');
  return entries;
}

export async function copyGuidance(source: string, destination: string): Promise<SnapshotEntry[]> {
  await mkdir(destination, { recursive: true });
  const entries: SnapshotEntry[] = [];
  if (!source) return entries;
  const walk = async (relative: string): Promise<void> => {
    const file = path.join(source, relative);
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink() || secret.test(relative)) {
      entries.push({
        path: relative,
        included: false,
        reason: 'credential or symbolic link excluded',
      });
      return;
    }
    if (info.isDirectory()) {
      for (const name of await readdir(file)) await walk(path.posix.join(relative, name));
    } else if (info.isFile()) {
      const content = await readFile(file);
      await mkdir(path.dirname(path.join(destination, relative)), { recursive: true });
      await writeFile(path.join(destination, relative), content, { mode: info.mode & 0o777 });
      entries.push({ path: relative, included: true, sha256: hash(content) });
    } else entries.push({ path: relative, included: false, reason: 'special file excluded' });
  };
  await walk('rules');
  await walk('skills');
  return entries;
}

/** Only allowlisted resolved settings cross into the evaluation environment. */
export function resolveEvaluationContext(input: {
  python: string;
  setup: EvalSetup;
  workspaceRoot?: string;
  teamSelection: string;
}): EvaluationContext {
  if (input.setup === 'synthetic')
    return {
      teamSelection: 'default-minimal',
      guidanceDirectory: '',
      webConfiguration: {},
      limitations: [],
    };
  const args = ['-m', 'ltcook.launch', 'evaluation-context'];
  if (input.setup === 'current' && input.workspaceRoot)
    args.push('--workspace', input.workspaceRoot);
  const child = spawnSync(input.python, args, {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  if (child.status !== 0)
    throw new Error(
      'Could not resolve evaluation configuration; verify the registered AppRC workspace.',
    );
  const context = JSON.parse(child.stdout) as EvaluationContext;
  if (
    !context ||
    typeof context.guidanceDirectory !== 'string' ||
    typeof context.teamSelection !== 'string' ||
    !context.webConfiguration
  )
    throw new Error('Evaluation configuration is invalid');
  if (context.teamSelection !== input.teamSelection)
    context.limitations.push(
      'Workspace team selection differs from the active runtime; using the active runtime team.',
    );
  return { ...context, teamSelection: input.teamSelection };
}

/** Preserve the loader-relative resource identity without publishing host paths. */
export function resourceIdentity(
  resource: { scope: string; path: string; name: string },
  workspace: string,
  guidance: string,
): string {
  const root =
    resource.scope === 'project' ? workspace : resource.scope === 'user' ? guidance : undefined;
  const relative = root ? path.relative(root, resource.path) : resource.name;
  const safe =
    !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
      ? relative
      : path.basename(resource.path);
  return `${resource.scope}/${safe.split(path.sep).join('/')}`;
}

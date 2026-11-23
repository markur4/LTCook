import { realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { isWithin } from '../../path-containment.js';
import {
  findRepositoryExecutable,
  RepositoryCommandError,
  runRepositoryCommand,
} from '../process.js';
import type { RepositoryResult } from '../results.js';
import type { RepositoryWorkspace } from '../workspace.js';

export interface GitChangedFile {
  path: string;
  indexStatus?: string;
  worktreeStatus?: string;
}

export interface GitWorktree {
  path: string;
  head?: string;
  branch?: string;
  detached?: true;
  bare?: true;
}

export interface GitDiscovery {
  source: 'git';
  branch?: string;
  head?: string;
  changed: number;
  untracked: number;
  worktrees: number;
  capturedAt: string;
  upstream?: string;
  defaultBranch?: string;
  defaultBranchRef?: string;
  remotes?: string[];
  worktreeEntries?: GitWorktree[];
  changedFiles?: GitChangedFile[];
  untrackedFiles?: string[];
  base?: {
    reference: string;
    commit: string;
    changedFiles: { path: string; status: string }[];
  };
}

interface GitQueryOptions {
  maxBytes?: number;
  acceptedExitCodes?: readonly number[];
  config?: string[];
}

type GitQuery = (
  operation: string,
  args: string[],
  options?: GitQueryOptions,
) => Promise<string | undefined>;

const MAX_DETAIL_ENTRIES = 128;
const MAX_DETAIL_BYTES = 16 * 1024;
const MAX_FILTER_DRIVERS = 24;
const GIT_CONFIG = [
  `core.attributesFile=${devNull}`,
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  `diff.orderFile=${devNull}`,
  'protocol.allow=never',
  'submodule.recurse=false',
];
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function line(output: string | undefined): string | undefined {
  return output?.replace(/\n$/, '') || undefined;
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

function workspaceRelative(path: string, prefix: string): string | undefined {
  if (!path.startsWith(prefix)) return undefined;
  const relativePath = path.slice(prefix.length);
  if (!relativePath || isAbsolute(relativePath) || relativePath.split('/').includes('..'))
    return undefined;
  if (sep === '\\' && relativePath.includes('\\')) return undefined;
  return relativePath;
}

function parseStatus(output: string, prefix: string) {
  const changedFiles: GitChangedFile[] = [];
  const untrackedFiles: string[] = [];
  for (const record of output.split('\0')) {
    if (record[2] !== ' ') continue;
    const path = workspaceRelative(record.slice(3), prefix);
    if (!path) continue;
    const [indexStatus, worktreeStatus] = record;
    if (indexStatus === '?' && worktreeStatus === '?') {
      untrackedFiles.push(path);
    } else {
      changedFiles.push({
        path,
        ...(indexStatus === ' ' ? {} : { indexStatus }),
        ...(worktreeStatus === ' ' ? {} : { worktreeStatus }),
      });
    }
  }
  return { changedFiles, untrackedFiles };
}

function parseWorktrees(output: string): GitWorktree[] {
  const entries: GitWorktree[] = [];
  let entry: GitWorktree | undefined;
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      entry = { path: field.slice('worktree '.length) };
      entries.push(entry);
    } else if (entry && field.startsWith('HEAD ')) {
      entry.head = field.slice('HEAD '.length);
    } else if (entry && field.startsWith('branch ')) {
      entry.branch = branchName(field.slice('branch '.length));
    } else if (entry && field === 'detached') {
      entry.detached = true;
    } else if (entry && field === 'bare') {
      entry.bare = true;
    } else if (!field) {
      entry = undefined;
    }
  }
  return entries;
}

function parseBaseChanges(output: string) {
  const changes: { path: string; status: string }[] = [];
  const fields = output.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i];
    const path = workspaceRelative(fields[i + 1] ?? '', '');
    if (status && path) changes.push({ path, status });
  }
  return changes;
}

function locallyKnownDefaultBranch(output: string, upstreamRemote: string | undefined) {
  const defaults = new Map<string, { branch: string; ref: string }>();
  for (const record of output.split('\n')) {
    const [head, ref] = record.split('\0');
    const remote = /^refs\/remotes\/(.+)\/HEAD$/.exec(head ?? '')?.[1];
    if (!remote || !ref) continue;
    const prefix = `refs/remotes/${remote}/`;
    if (ref.startsWith(prefix)) defaults.set(remote, { branch: ref.slice(prefix.length), ref });
  }
  return (
    (upstreamRemote ? defaults.get(upstreamRemote) : undefined) ??
    defaults.get('origin') ??
    (defaults.size === 1 ? defaults.values().next().value : undefined)
  );
}

async function readStatus(
  query: GitQuery,
  detailed: boolean,
  prefix: string,
  report: (code: string, message: string) => void,
) {
  // > Status can invoke configured clean filters when it compares tracked file content.
  const filterKeys = await query(
    'filters',
    ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$'],
    { acceptedExitCodes: [0, 1], maxBytes: 4096 },
  );
  if (filterKeys === undefined) return;
  const drivers = new Set(
    filterKeys
      .split('\0')
      .filter(Boolean)
      .map((key) => key.slice(0, key.lastIndexOf('.'))),
  );
  if (drivers.size > MAX_FILTER_DRIVERS) {
    report(
      'status-filter-limit',
      'Git status skipped because too many configured filters must be disabled',
    );
    return;
  }
  if ([...drivers].some((driver) => /[=\r\n]/.test(driver))) {
    report(
      'status-filter-name',
      'Git status skipped because a configured filter cannot be disabled',
    );
    return;
  }
  if (drivers.size) {
    report(
      'filters-disabled',
      'Git status may differ because configured content filters were disabled',
    );
  }
  const config = [...drivers].flatMap((driver) => [
    `${driver}.clean=`,
    `${driver}.process=`,
    `${driver}.required=false`,
  ]);
  const output = await query(
    'status',
    [
      'status',
      '--porcelain=v1',
      '--no-renames',
      '-z',
      detailed ? '--untracked-files=all' : '--untracked-files=normal',
      '--ignore-submodules=all',
      '--',
      '.',
    ],
    { config },
  );
  if (output !== undefined) return parseStatus(output, prefix);
}

async function compareBase(
  query: GitQuery,
  reference: string,
  head: string | undefined,
  report: (code: string, message: string) => void,
) {
  if (!head) {
    report('base-missing-head', 'Git base comparison requires a current commit');
    return;
  }
  if (
    !reference ||
    reference.length > 512 ||
    reference.startsWith('-') ||
    reference.includes('\0')
  ) {
    report('invalid-base', 'Git base must be a valid local ref name or object ID');
    return;
  }
  const validation = await query('base-reference', [
    'check-ref-format',
    '--allow-onelevel',
    reference,
  ]);
  if (validation === undefined) return;
  const commit = line(
    await query('base-commit', [
      'rev-parse',
      '--quiet',
      '--verify',
      '--end-of-options',
      `${reference}^{commit}`,
    ]),
  );
  if (!commit || !OBJECT_ID.test(commit)) return;
  const output = await query('base-changes', [
    'diff',
    '--name-status',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--ignore-submodules=none',
    '--relative',
    '-z',
    commit,
    head,
    '--',
    '.',
  ]);
  if (output === undefined) return;
  return { reference, commit, changedFiles: parseBaseChanges(output) };
}

/** Read Git metadata for this workspace. Working-tree records stay relative to the workspace. */
export async function readGit(
  workspace: RepositoryWorkspace,
  pathValue: string,
  { detailed = false, base }: { detailed?: boolean; base?: string } = {},
): Promise<RepositoryResult<GitDiscovery>> {
  const capturedAt = new Date().toISOString();
  const value: GitDiscovery = {
    source: 'git',
    changed: 0,
    untracked: 0,
    worktrees: 0,
    capturedAt,
  };
  const result: RepositoryResult<GitDiscovery> = {
    value,
    diagnostics: [],
    partial: false,
    truncated: false,
    capturedAt,
    freshness: 'current',
  };
  function report(code: string, message: string) {
    result.diagnostics.push({ source: 'git', code, message });
    result.partial = true;
  }
  function bounded<T>(items: T[], operation: string): T[] {
    const output: T[] = [];
    let bytes = 0;
    for (const item of items) {
      bytes += Buffer.byteLength(JSON.stringify(item));
      if (output.length === MAX_DETAIL_ENTRIES || bytes > MAX_DETAIL_BYTES) {
        result.truncated = true;
        report(`${operation}-limited`, 'Git detail reached its configured entry or byte limit');
        break;
      }
      output.push(item);
    }
    return output;
  }

  const git = findRepositoryExecutable('git', pathValue, workspace);
  if (!git) {
    report('git-unavailable', 'Git is unavailable outside the workspace');
    return result;
  }
  const query: GitQuery = async (operation, args, options = {}) => {
    const config = [...GIT_CONFIG, ...(options.config ?? [])];
    try {
      const output = await runRepositoryCommand(
        git,
        ['--no-pager', ...config.flatMap((value) => ['-c', value]), ...args],
        workspace,
        pathValue,
        {
          timeoutMs: 3000,
          maxBytes: options.maxBytes ?? 1024 * 1024,
          env: {
            GIT_ATTR_NOSYSTEM: '1',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: devNull,
            GIT_OPTIONAL_LOCKS: '0',
            GIT_NO_LAZY_FETCH: '1',
            GIT_NO_REPLACE_OBJECTS: '1',
            GIT_ALLOW_PROTOCOL: '',
            GIT_TERMINAL_PROMPT: '0',
          },
        },
      );
      if ((options.acceptedExitCodes ?? [0]).includes(output.code)) return output.stdout;
      report(`${operation}-unavailable`, `Git ${operation} is unavailable`);
    } catch (error) {
      if (error instanceof RepositoryCommandError && error.code === 'output-limit') {
        result.truncated = true;
        report(`${operation}-limited`, `Git ${operation} exceeded its output limit`);
      } else {
        report(`${operation}-unavailable`, `Git ${operation} failed or exceeded its time limit`);
      }
    }
  };

  const topLevel = line(
    await query('workspace', ['rev-parse', '--show-toplevel'], { maxBytes: 8192 }),
  );
  if (!topLevel) return result;
  const root =
    isAbsolute(topLevel) && isWithin(topLevel, workspace.root, true)
      ? await realpath(topLevel).catch(() => undefined)
      : undefined;
  if (!root || !isWithin(root, workspace.root, true)) {
    report('workspace-outside-worktree', 'Git worktree does not contain this workspace');
    return result;
  }
  const nested = relative(root, workspace.root) !== '';
  // > Use Git's spelling of the prefix because Git for macOS can precompose Unicode names.
  const prefix = nested
    ? line(await query('workspace-prefix', ['rev-parse', '--show-prefix'], { maxBytes: 8192 }))
    : '';
  if (nested && !prefix?.endsWith('/')) {
    report('invalid-workspace-prefix', 'Git could not identify the workspace within its worktree');
    return result;
  }
  const [head, branch, status, worktrees] = await Promise.all([
    query('head', ['rev-parse', '--quiet', '--verify', 'HEAD'], {
      acceptedExitCodes: [0, 1],
      maxBytes: 256,
    }),
    query('branch', ['symbolic-ref', '--quiet', 'HEAD'], {
      acceptedExitCodes: [0, 1],
      maxBytes: 8192,
    }),
    readStatus(query, detailed, prefix ?? '', report),
    query('worktrees', ['worktree', 'list', '--porcelain', '-z']),
  ]);
  const objectId = line(head);
  if (objectId && OBJECT_ID.test(objectId)) value.head = objectId;
  const branchRef = line(branch);
  if (branchRef) value.branch = branchName(branchRef);
  else if (branch !== undefined && value.head) value.branch = '(detached)';
  if (status) {
    value.changed = status.changedFiles.length;
    value.untracked = status.untrackedFiles.length;
  }
  const worktreeEntries = parseWorktrees(worktrees ?? '');
  value.worktrees = worktreeEntries.length;

  if (detailed) {
    value.changedFiles = bounded(status?.changedFiles ?? [], 'changed-files');
    value.untrackedFiles = bounded(status?.untrackedFiles ?? [], 'untracked-files');
    value.worktreeEntries = nested ? [] : bounded(worktreeEntries, 'worktree-entries');
    if (nested && worktreeEntries.length) {
      report('worktree-paths-outside-workspace', 'The workspace excludes worktree root paths');
    }
    const [remotes, primaryRefs, upstream] = await Promise.all([
      query('remotes', ['remote']),
      query('default-branch', [
        'for-each-ref',
        '--format=%(refname)%00%(symref)',
        'refs/remotes/*/HEAD',
      ]),
      branchRef
        ? query('upstream', [
            'for-each-ref',
            '--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)',
            '--',
            branchRef,
          ])
        : undefined,
    ]);
    value.remotes = bounded(remotes?.split('\n').filter(Boolean) ?? [], 'remote-entries');
    const [, upstreamRef, upstreamRemote] =
      upstream
        ?.split('\n')
        .map((record) => record.split('\0'))
        .find(([ref]) => ref === branchRef) ?? [];
    if (upstreamRef) value.upstream = upstreamRef;
    const defaultBranch = locallyKnownDefaultBranch(primaryRefs ?? '', upstreamRemote);
    if (defaultBranch) {
      value.defaultBranch = defaultBranch.branch;
      value.defaultBranchRef = defaultBranch.ref;
    }
  }
  if (base !== undefined) {
    const comparison = await compareBase(query, base, value.head, report);
    if (comparison) {
      value.base = { ...comparison, changedFiles: bounded(comparison.changedFiles, 'base-files') };
    }
  }
  result.diagnostics.sort((first, second) => first.code.localeCompare(second.code));
  return result;
}

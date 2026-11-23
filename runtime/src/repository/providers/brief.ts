import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isWithin } from '../../path-containment.js';
import { stageRepositoryFiles } from '../filesystem.js';
import {
  findRepositoryExecutable,
  RepositoryCommandError,
  runRepositoryCommand,
} from '../process.js';
import type { RepositoryDiagnostic, RepositoryResult } from '../results.js';
import type { RepositoryWorkspace } from '../workspace.js';

const BRIEF_VERSION = '0.16.0';
const SCAN_DEPTH = 8;
const SCAN_ENTRIES = 10000;
const MAX_PROJECTION_STRING_BYTES = 48 * 1024;
const TOOL_CATEGORIES = ['test', 'lint', 'format', 'typecheck', 'build', 'docs', 'ci'] as const;
const RESOURCE_PATHS = ['readme', 'changelog', 'roadmap', 'license'] as const;
const RESOURCE_GROUPS = ['legal', 'community', 'security', 'metadata', 'agents'] as const;

type ToolCategory = (typeof TOOL_CATEGORIES)[number];
type ResourcePath = (typeof RESOURCE_PATHS)[number];
type ResourceGroup = (typeof RESOURCE_GROUPS)[number];

interface BriefTool {
  name: string;
  confidence?: string;
  command?: { run: string; source?: string; alternatives: string[]; inferredTool?: string };
  configFiles: string[];
}

type BriefResources = Partial<Record<ResourcePath, string>> &
  Partial<Record<ResourceGroup, Record<string, string>>> & {
    licenseType?: string;
    templates?: { issues: string[]; pullRequests: string[]; config?: string };
  };

export interface RepositoryInventory {
  source: 'brief';
  languages: string[];
  manifests: { path: string; kind: string }[];
  dependencies: { name: string; scope: string }[];
  layout: { sourceDirs: string[]; testDirs: string[]; mirrorsSource?: boolean };
  packageManagers: BriefTool[];
  tools: Partial<Record<ToolCategory, BriefTool[]>>;
  scripts: { name: string; run: string; source?: string }[];
  resources: BriefResources;
  skills: { name: string; path: string; format?: string }[];
  conventions: {
    indentation?: string;
    indentSource?: string;
    lineEnding?: string;
    trailingNewline?: boolean;
  };
  platforms: {
    runtimeVersionFiles: Record<string, string>;
    ciMatrixVersions: Record<string, string[]>;
    ciMatrixOS: string[];
  };
  truncated: boolean;
}

function blankInventory(): RepositoryInventory {
  return {
    source: 'brief',
    languages: [],
    manifests: [],
    dependencies: [],
    layout: { sourceDirs: [], testDirs: [] },
    packageManagers: [],
    tools: {},
    scripts: [],
    resources: {},
    skills: [],
    conventions: {},
    platforms: { runtimeVersionFiles: {}, ciMatrixVersions: {}, ciMatrixOS: [] },
    truncated: false,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function observation(
  value: RepositoryInventory,
  capturedAt: string,
  diagnostics: RepositoryDiagnostic[],
): RepositoryResult<RepositoryInventory> {
  return {
    provider: value.source,
    value,
    capturedAt,
    diagnostics,
    partial: diagnostics.length > 0,
    truncated: value.truncated,
    freshness: 'current',
  };
}

class Projection {
  truncated = false;
  invalid = false;
  private stringBytes = 0;

  text(value: unknown, maxLength = 256): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.includes('\0')) {
      this.invalid = true;
      return undefined;
    }
    if (value.length > maxLength) {
      this.truncated = true;
      return undefined;
    }
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (this.stringBytes + bytes > MAX_PROJECTION_STRING_BYTES) {
      this.truncated = true;
      return undefined;
    }
    this.stringBytes += bytes;
    return value;
  }

  boolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (value !== undefined && value !== null) this.invalid = true;
    return undefined;
  }

  relativePath(value: unknown): string | undefined {
    const name = this.text(value, 512);
    if (
      name &&
      (path.isAbsolute(name) ||
        path.win32.isAbsolute(name) ||
        /^[a-z]:/i.test(name) ||
        name.split(/[\\/]/).includes('..'))
    ) {
      this.invalid = true;
      return undefined;
    }
    return name;
  }

  object(value: unknown): Record<string, unknown> {
    const result = record(value);
    if (!result && value !== undefined && value !== null) this.invalid = true;
    return result ?? {};
  }

  list<T>(value: unknown, limit: number, project: (item: unknown) => T | undefined): T[] {
    if (!Array.isArray(value)) {
      if (value !== undefined && value !== null) this.invalid = true;
      return [];
    }
    if (value.length > limit) this.truncated = true;
    return value.slice(0, limit).flatMap((item: unknown) => {
      const projected = project(item);
      return projected === undefined ? [] : [projected];
    });
  }

  map<T>(
    value: unknown,
    limit: number,
    project: (item: unknown) => T | undefined,
    projectKey: (key: string) => string | undefined = (key) => this.text(key),
  ): Record<string, T> {
    const entries = Object.entries(this.object(value));
    if (entries.length > limit) this.truncated = true;
    return Object.fromEntries(
      entries.slice(0, limit).flatMap(([key, item]) => {
        const mappedKey = projectKey(key);
        const mappedItem = project(item);
        return mappedKey && mappedItem !== undefined ? [[mappedKey, mappedItem] as const] : [];
      }),
    );
  }

  paths(value: unknown, limit: number): string[] {
    return this.list(value, limit, (item) => this.relativePath(item));
  }

  tool(value: unknown): BriefTool | undefined {
    const tool = this.object(value);
    const name = this.text(tool.name);
    if (!name) return undefined;
    const command = this.object(tool.command);
    const run = this.text(command.run, 768);
    return {
      name,
      confidence: this.text(tool.confidence),
      configFiles: this.paths(tool.config_files, 8),
      command: run
        ? {
            run,
            source: this.text(command.source),
            inferredTool: this.text(command.inferred_tool),
            alternatives: this.list(command.alternatives, 3, (item) => this.text(item, 768)),
          }
        : undefined,
    };
  }

  resources(value: unknown): BriefResources {
    const input = this.object(value);
    const result: BriefResources = {};
    for (const key of RESOURCE_PATHS) {
      const item = this.relativePath(input[key]);
      if (item) result[key] = item;
    }
    for (const group of RESOURCE_GROUPS) {
      const items = this.map(input[group], 12, (item) => this.relativePath(item));
      if (Object.keys(items).length) result[group] = items;
    }
    const licenseType = this.text(input.license_type);
    if (licenseType) result.licenseType = licenseType;
    if (input.templates) {
      const templates = this.object(input.templates);
      result.templates = {
        issues: this.paths(templates.issue, 12),
        pullRequests: this.paths(templates.pull_request, 12),
        config: this.relativePath(templates.config),
      };
    }
    return result;
  }
}

function diagnostic(code: string, message: string): RepositoryDiagnostic {
  return { source: 'brief', code, message };
}

/** Validate the brief 0.16.0 report boundary and project repository metadata. */
export function parseBriefInventory(
  value: unknown,
  capturedAt = new Date().toISOString(),
): RepositoryResult<RepositoryInventory> {
  const input = record(value);
  const stats = record(input?.stats);
  if (
    !input ||
    !stats ||
    (input.version !== undefined && input.version !== BRIEF_VERSION) ||
    (input.languages !== null && !Array.isArray(input.languages))
  ) {
    return observation(blankInventory(), capturedAt, [
      diagnostic('malformed-report', 'brief returned a malformed inventory report'),
    ]);
  }

  const read = new Projection();
  const layout = read.object(input.layout);
  const platforms = read.object(input.platforms);
  const style = read.object(input.style);
  const tools = read.object(input.tools);
  const scanTruncated = read.boolean(stats.scan_truncated) === true;
  const inventory: RepositoryInventory = {
    source: 'brief',
    languages: read.list(input.languages, 32, (item) => read.text(read.object(item).name)),
    manifests: read.list(input.manifests, 128, (item) => {
      const manifest = read.object(item);
      const file = read.relativePath(manifest.path);
      return file ? { path: file, kind: read.text(manifest.kind) ?? 'unknown' } : undefined;
    }),
    layout: {
      sourceDirs: read.paths(layout.source_dirs, 32),
      testDirs: read.paths(layout.test_dirs, 32),
      mirrorsSource: read.boolean(layout.mirrors_source),
    },
    packageManagers: read.list(input.package_managers, 8, (item) => read.tool(item)),
    tools: Object.fromEntries(
      TOOL_CATEGORIES.flatMap((category) => {
        const entries = read.list(tools[category], 12, (item) => read.tool(item));
        return entries.length ? [[category, entries] as const] : [];
      }),
    ),
    scripts: read.list(input.scripts, 48, (item) => {
      const script = read.object(item);
      const name = read.text(script.name);
      const run = read.text(script.run, 768);
      return name && run ? { name, run, source: read.text(script.source) } : undefined;
    }),
    resources: read.resources(input.resources),
    skills: read.list(input.skills, 16, (item) => {
      const skill = read.object(item);
      const name = read.text(skill.name);
      const file = read.relativePath(skill.path);
      return name && file ? { name, path: file, format: read.text(skill.format) } : undefined;
    }),
    conventions: {
      indentation: read.text(style.indentation),
      indentSource: read.text(style.indent_source),
      lineEnding: read.text(style.line_ending),
      trailingNewline: read.boolean(style.trailing_newline),
    },
    platforms: {
      runtimeVersionFiles: read.map(
        platforms.runtime_version_files,
        12,
        (item) => read.text(item),
        (key) => read.relativePath(key),
      ),
      ciMatrixVersions: read.map(platforms.ci_matrix_versions, 12, (items) =>
        read.list(items, 12, (item) => read.text(item)),
      ),
      ciMatrixOS: read.list(platforms.ci_matrix_os, 12, (item) => read.text(item)),
    },
    dependencies: read.list(input.dependencies, 128, (item) => {
      const dependency = read.object(item);
      const name = read.text(dependency.name);
      return name ? { name, scope: read.text(dependency.scope) ?? 'unknown' } : undefined;
    }),
    truncated: read.truncated || scanTruncated,
  };

  const diagnostics: RepositoryDiagnostic[] = [];
  if (scanTruncated)
    diagnostics.push(diagnostic('scan-limit', 'brief scan reached its configured limit'));
  if (read.truncated)
    diagnostics.push(diagnostic('report-limit', 'brief inventory reached its display limits'));
  if (read.invalid)
    diagnostics.push(diagnostic('invalid-metadata', 'brief omitted invalid metadata or paths'));
  return observation(inventory, capturedAt, diagnostics);
}

class BriefAvailabilityError extends Error {
  constructor(
    readonly code: 'unavailable' | 'version-mismatch',
    message: string,
  ) {
    super(message);
  }
}

export async function resolveBrief(
  workspace: RepositoryWorkspace,
  pathValue: string,
  configuredExecutable?: string,
): Promise<string> {
  let executable: string | undefined;
  if (configuredExecutable === undefined) {
    executable = findRepositoryExecutable('brief', pathValue, workspace);
  } else {
    if (
      path.isAbsolute(configuredExecutable) &&
      !isWithin(workspace.root, configuredExecutable, true)
    ) {
      try {
        const resolved = await realpath(configuredExecutable);
        if (!isWithin(workspace.root, resolved, true) && (await stat(resolved)).isFile()) {
          if (process.platform !== 'win32') await access(resolved, constants.X_OK);
          executable = resolved;
        }
      } catch {
        // > A missing configured tool must not silently select a different executable.
      }
    }
  }
  if (!executable) {
    throw new BriefAvailabilityError(
      'unavailable',
      `brief v${BRIEF_VERSION} is unavailable; run LTCook setup or repair`,
    );
  }
  const version = await runRepositoryCommand(executable, ['--version'], workspace, '', {
    timeoutMs: 3000,
    maxBytes: 1024,
  });
  if (version.code !== 0 || version.stdout.trim() !== `brief ${BRIEF_VERSION}`) {
    throw new BriefAvailabilityError(
      'version-mismatch',
      `brief version does not match v${BRIEF_VERSION}`,
    );
  }
  return executable;
}

export async function readBrief(
  workspace: RepositoryWorkspace,
  pathValue: string,
  configuredExecutable?: string,
): Promise<RepositoryResult<RepositoryInventory>> {
  const capturedAt = new Date().toISOString();
  try {
    const brief = await resolveBrief(workspace, pathValue, configuredExecutable);
    // > Stage regular files because brief's CLI can follow intermediate links when probing a path.
    const stage = await stageRepositoryFiles(workspace, {
      maxDepth: SCAN_DEPTH,
      maxEntries: SCAN_ENTRIES,
      maxFiles: SCAN_ENTRIES,
      maxFileBytes: 4 * 1024 * 1024,
      maxBytes: 24 * 1024 * 1024,
    });
    try {
      // > Use a local argument and an empty PATH so brief cannot start Git, scc or tokei.
      const result = await runRepositoryCommand(
        brief,
        [
          '--json',
          '--scan-depth',
          String(SCAN_DEPTH),
          '--scan-limit',
          String(SCAN_ENTRIES),
          '--line-count-timeout',
          '1s',
          '.',
        ],
        stage.workspace,
        '',
        {
          timeoutMs: 20000,
          maxBytes: 4 * 1024 * 1024,
          env: { NoDefaultCurrentDirectoryInExePath: '1' },
        },
      );
      if (result.code !== 0) {
        return observation(blankInventory(), capturedAt, [
          diagnostic('scan-failed', 'brief discovery failed'),
        ]);
      }
      const parsed: unknown = JSON.parse(result.stdout);
      const report = parseBriefInventory(parsed, capturedAt);
      if (stage.truncated)
        report.diagnostics.push(
          diagnostic('workspace-limit', 'brief workspace capture reached its limits'),
        );
      if (stage.partial)
        report.diagnostics.push(
          diagnostic('workspace-partial', 'brief omitted unavailable workspace files'),
        );
      return observation(
        { ...report.value, truncated: report.truncated || stage.truncated },
        capturedAt,
        report.diagnostics,
      );
    } finally {
      await stage.dispose();
    }
  } catch (error) {
    if (error instanceof BriefAvailabilityError)
      return observation(blankInventory(), capturedAt, [diagnostic(error.code, error.message)]);
    if (error instanceof RepositoryCommandError)
      return observation(
        { ...blankInventory(), truncated: error.code === 'output-limit' },
        capturedAt,
        [diagnostic(error.code, error.message)],
      );
    if (error instanceof SyntaxError)
      return observation(blankInventory(), capturedAt, [
        diagnostic('malformed-json', 'brief returned malformed JSON'),
      ]);
    return observation(blankInventory(), capturedAt, [
      diagnostic('scan-failed', 'brief discovery was unavailable'),
    ]);
  }
}

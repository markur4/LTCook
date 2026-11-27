import { RE2JS } from 're2js';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const pathRules = Type.Optional(
  Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 12 }),
);
const textRules = Type.Optional(
  Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 12 }),
);

export const RepositoryFilterSchema = Type.Object(
  {
    includePaths: pathRules,
    excludePaths: pathRules,
    includeText: textRules,
    excludeText: textRules,
    includeRegex: textRules,
    excludeRegex: textRules,
  },
  { additionalProperties: false },
);

export type RepositoryFilterInput = Static<typeof RepositoryFilterSchema>;

export class RepositoryFilterError extends Error {}

export function invalidRepositoryFilterArgument(input: unknown): RepositoryFilterError | undefined {
  if (!input || typeof input !== 'object' || !('filter' in input)) return;
  const error = Value.Errors(RepositoryFilterSchema, input.filter)[0];
  if (!error) return;
  const [, field, index] = error.instancePath.split('/');
  if (field && !Object.hasOwn(RepositoryFilterSchema.properties, field))
    return new RepositoryFilterError('Use only the six include and exclude fields in filter.');
  const location = field ? `filter.${field}${index ? `[${index}]` : ''}` : 'filter';
  return new RepositoryFilterError(`${location} ${error.message}.`);
}

export const RepositoryFilterReportSchema = Type.Object({
  effective: RepositoryFilterSchema,
  rejectedPaths: Type.Integer({ minimum: 0 }),
  rejectedUnits: Type.Integer({ minimum: 0 }),
  budgetExhausted: Type.Boolean(),
  providerPruning: Type.Optional(Type.Literal('count-unavailable')),
});

export type RepositoryFilterReport = Static<typeof RepositoryFilterReportSchema>;

type GlobSegment = '**' | { literal: string } | { pattern: RE2JS; hidden: boolean };
type PathRule = { glob: string; prefix: string; segments: GlobSegment[] };
const MAX_FILTER_BYTES = 32 * 1024 * 1024;

export function escapeFilterRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileSegment(segment: string): GlobSegment {
  if (segment === '**') return '**';
  if (!/[*?]/.test(segment)) return { literal: segment };
  const pattern = [...segment]
    .map((part) => (part === '*' ? '[^/]*' : part === '?' ? '[^/]' : escapeFilterRegex(part)))
    .join('');
  return { pattern: RE2JS.compile(`^${pattern}\\z`), hidden: segment.startsWith('.') };
}

function compilePaths(values: string[] | undefined, field: string): PathRule[] {
  return [...new Set(values)].map((value, index) => {
    const glob = value.replace(/^\.\//, '');
    const segments = glob.split('/');
    if (
      !glob ||
      /[\u0000-\u001f\\:[\]{}]/u.test(glob) ||
      /[@+?!*]\(/.test(glob) ||
      segments.some(
        (segment) =>
          !segment ||
          segment === '.' ||
          segment === '..' ||
          (segment.includes('**') && segment !== '**'),
      ) ||
      segments.filter((segment) => segment === '**').length > 4 ||
      (glob.match(/[*?]/g)?.length ?? 0) > 24
    ) {
      throw new RepositoryFilterError(
        `filter.${field}[${index}] must be a workspace-relative glob using /, *, ? or **.`,
      );
    }
    const wildcard = segments.findIndex((segment) => /[*?]/.test(segment));
    const prefix = wildcard < 0 ? glob : segments.slice(0, wildcard).join('/');
    return { glob, prefix, segments: segments.map(compileSegment) };
  });
}

function compileRegex(values: string[] | undefined, field: string): RE2JS[] {
  return [...new Set(values)].map((value, index) => {
    try {
      return RE2JS.compile(value);
    } catch {
      throw new RepositoryFilterError(
        `filter.${field}[${index}] must be a valid RE2 regular expression. Use a literal text filter for plain text.`,
      );
    }
  });
}

function pathMatches(parts: readonly string[], { segments }: PathRule): boolean {
  let reachable = new Set([0]);
  for (const segment of segments) {
    const next = new Set<number>();
    for (let index = 0; index <= parts.length; index++) {
      const part = parts[index];
      if (segment === '**') {
        if (reachable.has(index)) next.add(index);
        if (part !== undefined && !part.startsWith('.') && next.has(index)) next.add(index + 1);
      } else if (part !== undefined && reachable.has(index)) {
        const matches =
          'literal' in segment
            ? part === segment.literal
            : (segment.hidden || !part.startsWith('.')) && segment.pattern.test(part);
        if (matches) next.add(index + 1);
      }
    }
    if (!next.size) return false;
    reachable = next;
  }
  return reachable.has(parts.length);
}

function within(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent + '/');
}

export class RepositoryFilter {
  private readonly includedPaths: PathRule[];
  private readonly excludedPaths: PathRule[];
  private readonly includedRegex: RE2JS[];
  private readonly excludedRegex: RE2JS[];
  private readonly rejected = new Set<string>();
  private rejectedUnits = 0;
  private testedBytes = 0;
  private exhausted = false;
  private prunedByProvider = false;
  readonly effective: RepositoryFilterInput;

  constructor(input: RepositoryFilterInput) {
    this.includedPaths = compilePaths(input.includePaths, 'includePaths');
    this.excludedPaths = compilePaths(input.excludePaths, 'excludePaths');
    this.includedRegex = compileRegex(input.includeRegex, 'includeRegex');
    this.excludedRegex = compileRegex(input.excludeRegex, 'excludeRegex');
    this.effective = {
      ...(this.includedPaths.length && {
        includePaths: this.includedPaths.map(({ glob }) => glob),
      }),
      ...(this.excludedPaths.length && {
        excludePaths: this.excludedPaths.map(({ glob }) => glob),
      }),
      ...(input.includeText?.length && { includeText: [...new Set(input.includeText)] }),
      ...(input.excludeText?.length && { excludeText: [...new Set(input.excludeText)] }),
      ...(input.includeRegex?.length && { includeRegex: [...new Set(input.includeRegex)] }),
      ...(input.excludeRegex?.length && { excludeRegex: [...new Set(input.excludeRegex)] }),
    };
  }

  get hasPathRules(): boolean {
    return this.includedPaths.length > 0 || this.excludedPaths.length > 0;
  }

  get hasContentRules(): boolean {
    const { includeText, excludeText, includeRegex, excludeRegex } = this.effective;
    return Boolean(includeText || excludeText || includeRegex || excludeRegex);
  }

  get exhaustedContentBudget(): boolean {
    return this.exhausted;
  }

  get includeRoots(): { path: string; subtree: boolean }[] | undefined {
    if (!this.includedPaths.length || this.includedPaths.some(({ prefix }) => !prefix)) return;
    return this.includedPaths.map(({ glob, prefix }) => ({
      path: prefix,
      subtree: glob !== prefix,
    }));
  }

  private excludesPath(path: string): boolean {
    if (!this.excludedPaths.length) return false;
    const segments = path.split('/');
    for (let length = segments.length; length > 0; length--) {
      const ancestor = segments.slice(0, length);
      if (this.excludedPaths.some((rule) => pathMatches(ancestor, rule))) return true;
    }
    return false;
  }

  private recordPath(path: string, allowed: boolean): boolean {
    if (!allowed) this.rejected.add(path);
    return allowed;
  }

  matchesPath(path: string): boolean {
    const parts = path.split('/');
    return (
      !this.excludesPath(path) &&
      (!this.includedPaths.length || this.includedPaths.some((rule) => pathMatches(parts, rule)))
    );
  }

  allowsPath(path: string): boolean {
    return this.recordPath(path, this.matchesPath(path));
  }

  allowsDirectory(path: string): boolean {
    return this.recordPath(
      path,
      !this.excludesPath(path) &&
        (path === '.' ||
          !this.includedPaths.length ||
          this.includedPaths.some(
            ({ glob, prefix }) =>
              !prefix || within(prefix, path) || (glob !== prefix && within(path, prefix)),
          )),
    );
  }

  allowsText(text: string): boolean {
    if (!this.hasContentRules) return true;
    this.testedBytes += Buffer.byteLength(text);
    if (this.testedBytes > MAX_FILTER_BYTES) {
      this.exhausted = true;
      return false;
    }
    const { includeText, excludeText } = this.effective;
    const allowed =
      !excludeText?.some((literal) => text.includes(literal)) &&
      !this.excludedRegex.some((regex) => regex.test(text)) &&
      (!includeText || includeText.some((literal) => text.includes(literal))) &&
      (!this.includedRegex.length || this.includedRegex.some((regex) => regex.test(text)));
    if (!allowed) this.rejectedUnits++;
    return allowed;
  }

  noteProviderPruning(): void {
    this.prunedByProvider = true;
  }

  report(budgetExhausted = false): RepositoryFilterReport {
    return {
      effective: this.effective,
      rejectedPaths: this.rejected.size,
      rejectedUnits: this.rejectedUnits,
      budgetExhausted: budgetExhausted || this.exhausted,
      ...(this.prunedByProvider && { providerPruning: 'count-unavailable' }),
    };
  }
}

export function compileRepositoryFilter(
  input: RepositoryFilterInput | undefined,
  operation: string,
  supported: 'all' | 'paths' | 'none' = 'all',
): RepositoryFilter | undefined {
  if (input === undefined) return;
  const unsupported = Object.keys(input).filter(
    (field) =>
      supported === 'none' ||
      (supported === 'paths' && field !== 'includePaths' && field !== 'excludePaths'),
  );
  if (supported === 'none' || unsupported.length)
    throw new RepositoryFilterError(
      `${operation} does not support ${unsupported.map((field) => 'filter.' + field).join(', ') || 'filter'}.`,
    );
  return new RepositoryFilter(input);
}

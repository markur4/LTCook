import { posix } from 'node:path';
import { RE2JS } from 're2js';
import { Type, type Static } from 'typebox';

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

export const RepositoryFilterReportSchema = Type.Object({
  effective: RepositoryFilterSchema,
  rejectedPaths: Type.Integer({ minimum: 0 }),
  rejectedUnits: Type.Integer({ minimum: 0 }),
  budgetExhausted: Type.Boolean(),
});

export type RepositoryFilterReport = Static<typeof RepositoryFilterReportSchema>;

type PathRule = { glob: string; prefix: string };
const MAX_FILTER_BYTES = 32 * 1024 * 1024;

function compilePaths(values: string[] | undefined, field: string): PathRule[] {
  return [...new Set(values)].map((value, index) => {
    const glob = value.replace(/^\.\//, '');
    const segments = glob.split('/');
    if (
      !glob ||
      /[\u0000-\u001f\\:[\]{}]/u.test(glob) ||
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
      throw new Error(
        `filter.${field}[${index}] must be a workspace-relative glob using /, *, ? or **.`,
      );
    }
    const wildcard = segments.findIndex((segment) => /[*?]/.test(segment));
    const prefix = wildcard < 0 ? glob : segments.slice(0, wildcard).join('/');
    return { glob, prefix };
  });
}

function compileRegex(values: string[] | undefined, field: string): RE2JS[] {
  return [...new Set(values)].map((value, index) => {
    try {
      return RE2JS.compile(value);
    } catch {
      throw new Error(
        `filter.${field}[${index}] must be a valid RE2 regular expression. Use a literal text filter for plain text.`,
      );
    }
  });
}

function pathMatches(path: string, glob: string): boolean {
  return (
    posix.matchesGlob(path, glob) ||
    (glob.endsWith('/**') && posix.matchesGlob(path, glob.slice(0, -3)))
  );
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

  private excludesPath(path: string): boolean {
    if (!this.excludedPaths.length) return false;
    const segments = path.split('/');
    for (let length = segments.length; length > 0; length--) {
      const ancestor = segments.slice(0, length).join('/');
      if (this.excludedPaths.some(({ glob }) => pathMatches(ancestor, glob))) return true;
    }
    return false;
  }

  private recordPath(path: string, allowed: boolean): boolean {
    if (!allowed) this.rejected.add(path);
    return allowed;
  }

  allowsPath(path: string): boolean {
    return this.recordPath(
      path,
      !this.excludesPath(path) &&
        (!this.includedPaths.length ||
          this.includedPaths.some(({ glob }) => pathMatches(path, glob))),
    );
  }

  allowsDirectory(path: string): boolean {
    return this.recordPath(
      path,
      !this.excludesPath(path) &&
        (path === '.' ||
          !this.includedPaths.length ||
          this.includedPaths.some(
            ({ prefix }) => !prefix || within(path, prefix) || within(prefix, path),
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

  report(budgetExhausted = false): RepositoryFilterReport {
    return {
      effective: this.effective,
      rejectedPaths: this.rejected.size,
      rejectedUnits: this.rejectedUnits,
      budgetExhausted: budgetExhausted || this.exhausted,
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
    throw new Error(
      `${operation} does not support ${unsupported.map((field) => 'filter.' + field).join(', ') || 'filter'}.`,
    );
  return new RepositoryFilter(input);
}

import { parse, type ParserPlugin } from '@babel/parser';
import {
  getBindingIdentifiers,
  traverseFast,
  type ArrowFunctionExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type Node,
  type Program,
} from '@babel/types';
import { parser as pythonParser } from '@lezer/python';
import { posix } from 'node:path';
import { sourceExcerpt, type RepositorySourceReader, type SourceSnapshot } from './evidence.js';
import type { RepositoryHit } from './results.js';

type LineRange = Pick<RepositoryHit, 'startLine' | 'endLine'>;
type SourceBlock = LineRange & { kind: 'function' | 'class' | 'test' };
const MAX_PARSABLE_LENGTH = 512 * 1024;
const MAX_CONNECTION_LINES = 8;

export type SourceConnection = {
  kind: 'import' | 're-export' | 'wrapper';
  from: RepositoryHit;
  to: RepositoryHit;
};

function callName(node: Node): string | undefined {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'CallExpression') return callName(node.callee);
  if (node.type === 'MemberExpression' && !node.computed) return callName(node.object);
}

function jsBlock(node: Node): SourceBlock['kind'] | undefined {
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'ClassMethod':
    case 'ClassPrivateMethod':
    case 'ObjectMethod':
      return 'function';
    case 'ClassDeclaration':
    case 'ClassExpression':
      return 'class';
    case 'VariableDeclaration':
      if (
        node.declarations.length === 1 &&
        ['ArrowFunctionExpression', 'FunctionExpression'].includes(
          node.declarations[0]?.init?.type ?? '',
        )
      )
        return 'function';
      break;
    case 'ExpressionStatement':
      if (
        node.expression.type === 'CallExpression' &&
        /^(?:it|test|describe|suite|beforeEach|afterEach|beforeAll|afterAll)$/.test(
          callName(node.expression.callee) ?? '',
        ) &&
        node.expression.arguments.some(
          (arg) => arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression',
        )
      )
        return 'test';
      break;
  }
}

function pythonBlock(
  source: SourceSnapshot,
  line: number,
  maxLines: number,
): SourceBlock | undefined {
  const offsets = [0];
  for (const text of source.lines) offsets.push(offsets.at(-1)! + text.length + 1);
  const lineAt = (offset: number) => {
    let low = 0;
    let high = offsets.length;
    while (high - low > 1) {
      const mid = (low + high) >>> 1;
      if (offsets[mid]! <= offset) low = mid;
      else high = mid;
    }
    return low + 1;
  };
  const anchor = offsets[line - 1]!;
  const blocks: SourceBlock[] = [];
  pythonParser.parse(source.text).iterate({
    from: anchor,
    to: anchor + source.lines[line - 1]!.length,
    enter(node) {
      if (!['FunctionDefinition', 'ClassDefinition', 'DecoratedStatement'].includes(node.name))
        return;
      const definition =
        node.name === 'DecoratedStatement'
          ? (node.node.getChild('FunctionDefinition') ?? node.node.getChild('ClassDefinition'))
          : node.node;
      if (
        !definition ||
        (definition.parent?.name === 'DecoratedStatement' && node.name !== 'DecoratedStatement')
      )
        return;
      let malformed = false;
      node.node.cursor().iterate((child) => {
        malformed ||= child.type.isError;
        return !malformed;
      });
      if (malformed) return;
      const name = definition.getChild('VariableName');
      const kind =
        definition.name === 'ClassDefinition'
          ? 'class'
          : name && source.text.slice(name.from, name.to).startsWith('test_')
            ? 'test'
            : 'function';
      blocks.push({
        kind,
        startLine: lineAt(node.from),
        endLine: lineAt(Math.max(node.from, node.to - 1)),
      });
    },
  });
  return smallestBlock(blocks, line, maxLines);
}

function smallestBlock(blocks: SourceBlock[], line: number, maxLines: number) {
  const containing = blocks.filter(
    ({ startLine, endLine }) => startLine <= line && line <= endLine,
  );
  containing.sort(
    (first, second) =>
      first.endLine - first.startLine - (second.endLine - second.startLine) ||
      first.startLine - second.startLine,
  );
  return containing.find((block) => block.endLine - block.startLine < maxLines) ?? containing[0];
}

function declarationNames(node: Node): string[] {
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSEnumDeclaration':
      return node.id ? [node.id.name] : [];
    case 'VariableDeclaration':
      return node.declarations.flatMap((decl) => Object.keys(getBindingIdentifiers(decl.id)));
    default:
      return [];
  }
}

type Edge = {
  kind: SourceConnection['kind'];
  from: LineRange;
  target: { range: LineRange } | { module: string; name: string };
};
type Callable = ArrowFunctionExpression | FunctionDeclaration | FunctionExpression;

function rangeOf(node: Node): LineRange | undefined {
  if (node.loc) return { startLine: node.loc.start.line, endLine: node.loc.end.line };
}

function wrapperTarget(node: Callable): string | undefined {
  let value;
  if (node.body.type === 'BlockStatement') {
    const [statement] = node.body.body;
    if (
      node.body.directives.length ||
      node.body.body.length !== 1 ||
      statement?.type !== 'ReturnStatement'
    )
      return;
    value = statement.argument;
  } else {
    value = node.body;
  }
  const call = value?.type === 'AwaitExpression' ? value.argument : value;
  if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier') return;
  const name = call.callee.name;
  if (
    (node.type === 'ArrowFunctionExpression' || node.id?.name !== name) &&
    !node.params.some((param) => Object.hasOwn(getBindingIdentifiers(param), name))
  )
    return name;
}

function wrapper(node: Node, symbol: string): Callable | undefined {
  if (node.type === 'FunctionDeclaration' && node.id?.name === symbol) return node;
  if (node.type !== 'VariableDeclaration' || node.kind !== 'const') return;
  for (const { id, init } of node.declarations) {
    if (id.type !== 'Identifier' || id.name !== symbol) continue;
    if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression')
      return init;
  }
}

function shortRange(range: LineRange, line = range.startLine): LineRange {
  return range.endLine - range.startLine < MAX_CONNECTION_LINES
    ? range
    : { startLine: line, endLine: line };
}

function modulePaths(from: string, module: string): string[] {
  if (!/^\.\.?\//.test(module) || module.includes('\\')) return [];
  const base = posix.join(posix.dirname(from), module);
  if (base === '..' || base.startsWith('../')) return [];
  const extension = posix.extname(base);
  if (extension) {
    const replacements: Record<string, string[]> = {
      '.js': ['.ts', '.tsx'],
      '.jsx': ['.tsx'],
      '.mjs': ['.mts'],
      '.cjs': ['.cts'],
    };
    return [
      base,
      ...(replacements[extension] ?? []).map((ext) => base.slice(0, -extension.length) + ext),
    ];
  }
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs'];
  return [
    ...extensions.map((extension) => base + extension),
    ...extensions.map((extension) => posix.join(base, 'index' + extension)),
  ];
}

/** Navigate only source that can be checked against this request's workspace snapshots. */
export function createSourceNavigation(
  reader: RepositorySourceReader,
  signal: AbortSignal,
  allows: (path: string) => boolean,
) {
  const programs = new WeakMap<SourceSnapshot, Program | undefined>();
  function program(source: SourceSnapshot) {
    if (programs.has(source)) return programs.get(source);
    let parsed: Program | undefined;
    if (source.text.length <= MAX_PARSABLE_LENGTH && /\.[cm]?[jt]sx?$/.test(source.path)) {
      const plugins: ParserPlugin[] = [];
      if (/\.[cm]?tsx?$/.test(source.path)) plugins.push('typescript');
      if (/\.(?:[cm]?js|jsx|tsx)$/.test(source.path)) plugins.push('jsx');
      try {
        parsed = parse(source.text, { sourceType: 'unambiguous', plugins }).program;
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof RangeError)) throw error;
      }
    }
    programs.set(source, parsed);
    return parsed;
  }

  function enclosingBlock(source: SourceSnapshot, line: number, maxLines: number) {
    if (source.text.length > MAX_PARSABLE_LENGTH) return;
    if (/\.pyi?$/.test(source.path)) return pythonBlock(source, line, maxLines);
    const parsed = program(source);
    if (!parsed) return;
    const blocks: SourceBlock[] = [];
    traverseFast(parsed, (node) => {
      const declaration =
        node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'
          ? node.declaration
          : node;
      if (!declaration) return;
      const kind = jsBlock(declaration);
      const range = node.loc;
      if (!kind || !range) return;
      if (range.start.line <= line && range.end.line >= line)
        blocks.push({ kind, startLine: range.start.line, endLine: range.end.line });
    });
    return smallestBlock(blocks, line, maxLines);
  }

  function open(source: SourceSnapshot, line: number, maxLines: number) {
    if (line > source.lines.length) throw new Error('The source line is outside the file.');
    const block = enclosingBlock(source, line, maxLines);
    let startLine = Math.max(block?.startLine ?? 1, line - Math.floor(maxLines / 2));
    let endLine = Math.min(block?.endLine ?? source.lines.length, startLine + maxLines - 1);
    if (block && block.endLine - block.startLine < maxLines) {
      startLine = block.startLine;
      endLine = block.endLine;
    }
    let evidence = sourceExcerpt(source, { startLine, endLine });
    // > A single long preceding line must not clip away the requested anchor.
    while (evidence.excerptTruncated && evidence.excerpt.split('\n').length <= line - startLine) {
      startLine++;
      evidence = sourceExcerpt(source, { startLine, endLine });
    }
    return {
      ...evidence,
      anchorLine: line,
      ...(block ? { block } : {}),
      complete:
        !!block &&
        startLine === block.startLine &&
        endLine === block.endLine &&
        !evidence.excerptTruncated,
    };
  }

  function exports(parsed: Program, name: string): number | undefined {
    const lines: number[] = [];
    for (const node of parsed.body) {
      if (node.type === 'ExportDefaultDeclaration' && name === 'default') {
        if (node.loc) lines.push(node.loc.start.line);
      } else if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration && declarationNames(node.declaration).includes(name) && node.loc)
          lines.push(node.loc.start.line);
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ExportSpecifier' || !specifier.loc) continue;
          const exported = specifier.exported;
          if ((exported.type === 'Identifier' ? exported.name : exported.value) === name)
            lines.push(specifier.loc.start.line);
        }
      }
    }
    if (lines.length === 1) return lines[0];
  }

  function edges(parsed: Program, symbol: string, hit: RepositoryHit): Edge[] {
    const candidates: Edge[] = [];
    const bindings = new Map<string, LineRange[]>();
    const localEdges: { kind: 'wrapper' | 're-export'; from: LineRange; name: string }[] = [];

    function bind(name: string, range: LineRange) {
      const entries = bindings.get(name) ?? [];
      entries.push(range);
      bindings.set(name, entries);
    }

    for (const node of parsed.body) {
      const range = rangeOf(node);
      if (!range) continue;
      if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
        for (const specifier of node.specifiers) {
          if (!specifier.loc || specifier.type === 'ImportNamespaceSpecifier') continue;
          if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue;
          const imported = specifier.type === 'ImportSpecifier' ? specifier.imported : undefined;
          const name = !imported
            ? 'default'
            : imported.type === 'Identifier'
              ? imported.name
              : imported.value;
          const line = specifier.loc.start.line;
          bind(specifier.local.name, shortRange(range, line));
          if (specifier.local.name === symbol || (name === symbol && line === hit.startLine))
            candidates.push({
              kind: 'import',
              from: range,
              target: { module: node.source.value, name },
            });
        }
      }
      if (node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type') {
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ExportSpecifier' || !specifier.loc) continue;
          const name = specifier.local.name;
          const exported = specifier.exported;
          const exportName = exported.type === 'Identifier' ? exported.name : exported.value;
          if (exportName !== symbol && name !== symbol) continue;
          const from = range;
          if (node.source)
            candidates.push({
              kind: 're-export',
              from,
              target: { module: node.source.value, name },
            });
          else if (exportName !== name) localEdges.push({ kind: 're-export', from, name });
        }
      }
      const declaration =
        node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'
          ? node.declaration
          : node;
      if (!declaration) continue;
      for (const name of declarationNames(declaration)) bind(name, shortRange(range));
      const callback = wrapper(declaration, symbol);
      const name = callback && wrapperTarget(callback);
      if (name && name !== symbol) localEdges.push({ kind: 'wrapper', from: range, name });
    }

    for (const { kind, from, name } of localEdges) {
      const matches = bindings.get(name);
      if (matches?.length === 1) candidates.push({ kind, from, target: { range: matches[0]! } });
    }
    return candidates;
  }

  async function importedSource(from: SourceSnapshot, module: string, name: string) {
    const paths = modulePaths(from.path, module);
    let match: SourceSnapshot | undefined;
    for (const [index, path] of paths.entries()) {
      const candidate = await reader.read(path, signal, allows);
      if (candidate === 'source-missing') continue;
      if (typeof candidate === 'string' || match) return;
      match = candidate;
      if (index === 0 && posix.extname(module)) break;
    }
    if (!match) return;
    const parsed = program(match);
    const line = parsed ? exports(parsed, name) : undefined;
    if (line) return sourceExcerpt(match, { startLine: line, endLine: line });
  }

  async function connections(symbol: string, hits: RepositoryHit[]): Promise<SourceConnection[]> {
    const seen = new Set<string>();
    for (const hit of hits) {
      if (!allows(hit.path)) continue;
      const source = await reader.read(hit.path, signal);
      if (typeof source === 'string') continue;
      const parsed = program(source);
      if (!parsed) continue;
      for (const { kind, from, target } of edges(parsed, symbol, hit)) {
        if (from.endLine - from.startLine >= MAX_CONNECTION_LINES) continue;
        const key = JSON.stringify([source.path, from, kind, target]);
        if (seen.has(key)) continue;
        seen.add(key);
        const destination =
          'module' in target
            ? await importedSource(source, target.module, target.name)
            : sourceExcerpt(source, target.range);
        const origin = sourceExcerpt(source, from);
        if (!destination || origin.excerptTruncated || destination.excerptTruncated) continue;
        const [checkedFrom, checkedTo] = await Promise.all(
          [origin, destination].map((hit) =>
            reader.verify({ path: hit.path, excerpt: hit.excerpt, ranges: [hit] }, signal),
          ),
        );
        if (
          checkedFrom &&
          checkedTo &&
          typeof checkedFrom !== 'string' &&
          typeof checkedTo !== 'string'
        )
          return [{ kind, from: checkedFrom, to: checkedTo }];
      }
    }
    return [];
  }
  return { open, connections };
}

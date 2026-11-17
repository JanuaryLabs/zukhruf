import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import tseslint from 'typescript-eslint';

import { isAstNode, isType } from '../authoring/ast.ts';
import { isRecord } from '../unknown-values.ts';

interface Parsed {
  readonly mtimeMs: number;
  readonly specifiers: readonly string[];
}

// Keyed by absolute path. A changed mtime re-parses, so a long-lived ESLint
// process (an editor) sees an edit.
const parsedByFile = new Map<string, Parsed>();

function literalString(node: unknown): string | undefined {
  return isType(node, 'Literal') && typeof node['value'] === 'string'
    ? node['value']
    : undefined;
}

// A value import, a re-export or an `import()` of a literal loads the module
// when the file runs; `import type` and `export type` are erased first.
function loadedSpecifier(node: Record<string, unknown>): string | undefined {
  switch (node['type']) {
    case 'ImportDeclaration':
      return node['importKind'] === 'type'
        ? undefined
        : literalString(node['source']);
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
      return node['exportKind'] === 'type'
        ? undefined
        : literalString(node['source']);
    case 'ImportExpression':
      return literalString(node['source']);
    default:
      return undefined;
  }
}

function collect(node: unknown, into: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, into);
    return;
  }
  if (!isAstNode(node)) return;
  const specifier = loadedSpecifier(node);
  if (specifier !== undefined) into.push(specifier);
  for (const [key, child] of Object.entries(node)) {
    if (key !== 'parent' && isRecord(child)) collect(child, into);
  }
}

/** The module specifiers that `file` loads when Node runs it; none when it does not parse. */
export function loadedSpecifiers(file: string): readonly string[] {
  const { mtimeMs } = statSync(file);
  const cached = parsedByFile.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached.specifiers;
  const specifiers: string[] = [];
  try {
    collect(
      tseslint.parser.parseForESLint(readFileSync(file, 'utf8')).ast,
      specifiers,
    );
  } catch (error) {
    // typescript-estree throws a TSError with a lineNumber on a syntax
    // error; a file Node cannot parse fails on its own, not on a missing build.
    if (!(isRecord(error) && typeof error['lineNumber'] === 'number')) {
      throw error;
    }
  }
  parsedByFile.set(file, { mtimeMs, specifiers });
  return specifiers;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/**
 * The file that a relative specifier names: Node's exact path, then the
 * TypeScript file behind a `.js` name and the extensionless forms that tsx
 * resolves.
 */
export function relativeModule(
  from: string,
  specifier: string,
): string | undefined {
  const base = resolve(dirname(from), specifier);
  return [
    base,
    base.replace(/\.(c|m)?js$/, '.$1ts'),
    `${base}.ts`,
    `${base}.js`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.js'),
  ].find(isFile);
}

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { isNodeFlagSet } from 'ts-api-utils';
import * as ts from 'typescript';

interface Parsed {
  readonly mtimeMs: number;
  readonly specifiers: readonly string[];
}

// Keyed by absolute path. A changed mtime re-parses, so a long-lived ESLint
// process (an editor) sees an edit.
const parsedByFile = new Map<string, Parsed>();

function stringText(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteral(node) ? node.text : undefined;
}

// A value import, a re-export or an `import()` of a literal loads the module
// when the file runs; `import type` and `export type` are erased first.
function loadedSpecifier(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node)) {
    return node.importClause &&
      ts.isTypeOnlyImportDeclaration(node.importClause)
      ? undefined
      : stringText(node.moduleSpecifier);
  }
  if (ts.isExportDeclaration(node)) {
    return node.isTypeOnly ? undefined : stringText(node.moduleSpecifier);
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    return stringText(node.arguments[0]);
  }
  return undefined;
}

// False when a node carries a parse error: a file Node cannot parse fails on
// its own, not on a missing build.
function collect(node: ts.Node, into: string[]): boolean {
  if (isNodeFlagSet(node, ts.NodeFlags.ThisNodeHasError)) return false;
  const specifier = loadedSpecifier(node);
  if (specifier !== undefined) into.push(specifier);
  const brokenChild = ts.forEachChild(node, (child) =>
    collect(child, into) ? undefined : child,
  );
  return brokenChild === undefined;
}

/** The module specifiers that `file` loads when Node runs it; none when it does not parse. */
export function loadedSpecifiers(file: string): readonly string[] {
  const { mtimeMs } = statSync(file);
  const cached = parsedByFile.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached.specifiers;
  // The TypeScript parser alone: an ESLint parse (ESTree, tokens, scopes)
  // costs nine times as much and none of it names a module.
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const specifiers = collect(source, found) ? found : [];
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

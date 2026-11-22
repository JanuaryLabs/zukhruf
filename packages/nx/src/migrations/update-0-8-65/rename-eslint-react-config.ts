import { posix } from 'node:path';

import {
  ChangeType,
  type StringChange,
  type Tree,
  applyChangesToString,
  formatFiles,
  logger,
  visitNotIgnoredFiles,
} from '@nx/devkit';
import * as ts from 'typescript';

const ESLINT_CONFIG = /^eslint\.config\.[cm]?[jt]s$/;

/**
 * #5263: @zukhruf/eslint renamed its kit config from `react` to `shadcn`
 * (#4990, its ADR 0011) and keeps `react` as a deprecated alias for one
 * release. In each eslint.config of the repo, `configs['react']` and
 * `configs.react` of the default import of `@zukhruf/eslint` become
 * `configs['shadcn']`, and `'zukhruf/react'` in an `extends` array becomes
 * `'zukhruf/shadcn'`. `@zukhruf/eslint/react`, the community React preset, is
 * another export and stays.
 */
export default async function renameEslintReactConfig(
  tree: Tree,
): Promise<void> {
  visitNotIgnoredFiles(tree, '', (path) => {
    if (!ESLINT_CONFIG.test(posix.basename(path))) return;
    const before = tree.read(path, 'utf8');
    if (before === null) return;
    const edits = renames(path, before);
    if (edits.length === 0) return;
    tree.write(
      path,
      applyChangesToString(
        before,
        edits.flatMap(({ start, from, to }): StringChange[] => [
          { type: ChangeType.Delete, start, length: from.length },
          { type: ChangeType.Insert, index: start, text: to },
        ]),
      ),
    );
    for (const { line, from, to } of edits) {
      logger.info(
        `rename-eslint-react-config: ${path}:${line} ${from} -> ${to}`,
      );
    }
  });
  await formatFiles(tree);
}

/** One rename: the text at `start` (on 1-based `line`) and its replacement. */
interface Edit {
  start: number;
  line: number;
  from: string;
  to: string;
}

function renames(path: string, text: string): Edit[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const plugin = defaultImportOf(source, '@zukhruf/eslint');
  const edits: Edit[] = [];
  const replace = (node: ts.Node, to: string) => {
    const start = node.getStart(source);
    edits.push({
      start,
      line: source.getLineAndCharacterOfPosition(start).line + 1,
      from: node.getText(source),
      to,
    });
  };
  const visit = (node: ts.Node): void => {
    if (plugin !== undefined && isReactConfigAccess(node, plugin)) {
      replace(node, `${plugin}.configs['shadcn']`);
      return;
    }
    if (isExtendsArray(node)) {
      for (const element of node.elements) {
        if (isText(element) && element.text === 'zukhruf/react') {
          replace(element, `'zukhruf/shadcn'`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edits;
}

/** The local name of `import name from 'module'`. */
function defaultImportOf(
  source: ts.SourceFile,
  module: string,
): string | undefined {
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === module &&
      statement.importClause?.name !== undefined
    ) {
      return statement.importClause.name.text;
    }
  }
  return undefined;
}

/** `plugin.configs.react`, `plugin.configs['react']` or `plugin.configs["react"]`. */
function isReactConfigAccess(node: ts.Node, plugin: string): boolean {
  const configs = reactOf(node);
  return (
    configs !== undefined &&
    ts.isPropertyAccessExpression(configs) &&
    configs.name.text === 'configs' &&
    ts.isIdentifier(configs.expression) &&
    configs.expression.text === plugin
  );
}

/** `x` of `x.react` or `x['react']`. */
function reactOf(node: ts.Node): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === 'react' ? node.expression : undefined;
  }
  if (
    ts.isElementAccessExpression(node) &&
    isText(node.argumentExpression) &&
    node.argumentExpression.text === 'react'
  ) {
    return node.expression;
  }
  return undefined;
}

/** The value of `extends: [...]` or `'extends': [...]`. */
function isExtendsArray(node: ts.Node): node is ts.ArrayLiteralExpression {
  if (!ts.isArrayLiteralExpression(node)) return false;
  const { parent } = node;
  if (!ts.isPropertyAssignment(parent) || parent.initializer !== node) {
    return false;
  }
  const key = parent.name;
  return (ts.isIdentifier(key) || isText(key)) && key.text === 'extends';
}

function isText(
  node: ts.Node,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

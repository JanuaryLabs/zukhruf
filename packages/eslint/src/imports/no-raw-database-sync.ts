import type { Rule } from 'eslint';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
} from '../authoring/ast.ts';

const SQLITE = 'node:sqlite';

function propertyName(node: AstNode, key: string): string | undefined {
  const value = node[key];
  return isType(value, 'Literal') && typeof value['value'] === 'string'
    ? value['value']
    : identifierName(value);
}

// `require('node:sqlite')` or `await import('node:sqlite')`.
function loadsSqlite(node: unknown): boolean {
  const call = isType(node, 'AwaitExpression') ? node['argument'] : node;
  if (isType(call, 'ImportExpression'))
    return (
      isType(call['source'], 'Literal') && call['source']['value'] === SQLITE
    );
  if (!isType(call, 'CallExpression')) return false;
  const [argument] = Array.isArray(call['arguments']) ? call['arguments'] : [];
  return (
    identifierName(call['callee']) === 'require' &&
    isType(argument, 'Literal') &&
    argument['value'] === SQLITE
  );
}

/**
 * Each `new DatabaseSync` set up its connection in its own way: its busy
 * timeout, its journal, and which errors mean that the file is missing or
 * denied. `open` of `@zukhruf/sqlite-open` does that setup in one place. The
 * rule follows the bindings of the file: a named import under any local name,
 * a namespace or default import, and `require` or `import()` of `node:sqlite`.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow new DatabaseSync of node:sqlite; use open of @zukhruf/sqlite-open',
    },
    schema: [],
    messages: {
      matched:
        'Open SQLite with `open(path, options)` from @zukhruf/sqlite-open, which takes the options of new DatabaseSync: a reader is `open(path, { readOnly: true })`. It sets the journal, the busy timeout and the errors of an unavailable file in one place.',
    },
  },
  create(context) {
    const constructors = new Set<string>();
    const modules = new Set<string>();

    function bindPattern(pattern: unknown): void {
      const name = identifierName(pattern);
      if (name !== undefined) {
        modules.add(name);
        return;
      }
      if (!isType(pattern, 'ObjectPattern')) return;
      const properties = Array.isArray(pattern['properties'])
        ? pattern['properties']
        : [];
      for (const property of properties) {
        if (!isType(property, 'Property')) continue;
        if (propertyName(property, 'key') !== 'DatabaseSync') continue;
        const local = identifierName(property['value']);
        if (local !== undefined) constructors.add(local);
      }
    }

    function isDatabaseSync(callee: unknown): boolean {
      const name = identifierName(callee);
      if (name !== undefined) return constructors.has(name);
      if (!isType(callee, 'MemberExpression')) return false;
      if (propertyName(callee, 'property') !== 'DatabaseSync') return false;
      const object = callee['object'];
      const objectName = identifierName(object);
      return objectName !== undefined
        ? modules.has(objectName)
        : loadsSqlite(object);
    }

    return {
      ImportDeclaration(node: Rule.Node) {
        if (!isAstNode(node) || node['importKind'] === 'type') return;
        if (!isAstNode(node['source']) || node['source']['value'] !== SQLITE)
          return;
        const specifiers = Array.isArray(node['specifiers'])
          ? node['specifiers']
          : [];
        for (const specifier of specifiers) {
          if (!isAstNode(specifier) || specifier['importKind'] === 'type')
            continue;
          const local = identifierName(specifier['local']);
          if (local === undefined) continue;
          if (specifier.type !== 'ImportSpecifier') modules.add(local);
          else if (propertyName(specifier, 'imported') === 'DatabaseSync')
            constructors.add(local);
        }
      },
      VariableDeclarator(node: Rule.Node) {
        if (isAstNode(node) && loadsSqlite(node['init']))
          bindPattern(node['id']);
      },
      NewExpression(node: Rule.Node) {
        if (isAstNode(node) && isDatabaseSync(node['callee']))
          context.report({ node, messageId: 'matched' });
      },
    };
  },
};

export default rule;

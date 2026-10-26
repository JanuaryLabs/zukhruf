import type { Rule } from 'eslint';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
} from '../authoring/ast.ts';

const FS = new Set(['fs', 'node:fs']);
const FS_PROMISES = new Set(['fs/promises', 'node:fs/promises']);
const MKDTEMP = new Set([
  'mkdtemp',
  'mkdtempSync',
  'mkdtempDisposable',
  'mkdtempDisposableSync',
]);

function importedName(specifier: AstNode): string | undefined {
  const imported = specifier['imported'];
  return isType(imported, 'Literal') && typeof imported['value'] === 'string'
    ? imported['value']
    : identifierName(imported);
}

function memberName(member: AstNode): string | undefined {
  const property = member['property'];
  if (member['computed'] !== true) return identifierName(property);
  return isType(property, 'Literal') && typeof property['value'] === 'string'
    ? property['value']
    : undefined;
}

/**
 * Each test that makes its own temporary directory picks its own cleanup, and
 * the copies drift: one forgets the retry that Windows needs for a file that
 * is still open, another compares the path with what a child process reports,
 * which on macOS is the real path behind the `/var` symlink. `TemporaryFiles`
 * of `@zukhruf/testing/fs` gives the real path and removes the directory with
 * the retry. Only the calls of `node:fs` and `node:fs/promises` are reported:
 * the rule follows the imports of the file, not a value passed in.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a raw temporary directory in tests; use TemporaryFiles',
    },
    schema: [],
    messages: {
      matched:
        'Use `await using dir = await new TemporaryFiles().directory(prefix)` from @zukhruf/testing/fs: one standard temp directory for tests, at its real path, removed with a retry for Windows.',
    },
  },
  create(context) {
    const functions = new Set<string>();
    const fsModules = new Set<string>();
    const promiseModules = new Set<string>();

    function isPromisesObject(node: unknown): boolean {
      const name = identifierName(node);
      if (name !== undefined) return promiseModules.has(name);
      if (!isType(node, 'MemberExpression')) return false;
      const object = identifierName(node['object']);
      return (
        object !== undefined &&
        fsModules.has(object) &&
        memberName(node) === 'promises'
      );
    }

    function isMkdtemp(callee: unknown): boolean {
      const name = identifierName(callee);
      if (name !== undefined) return functions.has(name);
      if (!isType(callee, 'MemberExpression')) return false;
      const property = memberName(callee);
      if (property === undefined || !MKDTEMP.has(property)) return false;
      const object = callee['object'];
      const objectName = identifierName(object);
      return (
        (objectName !== undefined && fsModules.has(objectName)) ||
        isPromisesObject(object)
      );
    }

    return {
      ImportDeclaration(node: Rule.Node) {
        if (!isAstNode(node) || !isAstNode(node['source'])) return;
        const source = node['source']['value'];
        if (typeof source !== 'string') return;
        const isFs = FS.has(source);
        if (!isFs && !FS_PROMISES.has(source)) return;
        const specifiers = node['specifiers'];
        if (!Array.isArray(specifiers)) return;
        for (const specifier of specifiers) {
          if (!isAstNode(specifier)) continue;
          const local = identifierName(specifier['local']);
          if (local === undefined) continue;
          if (specifier.type !== 'ImportSpecifier') {
            (isFs ? fsModules : promiseModules).add(local);
            continue;
          }
          const imported = importedName(specifier);
          if (imported !== undefined && MKDTEMP.has(imported)) {
            functions.add(local);
          } else if (isFs && imported === 'promises') {
            promiseModules.add(local);
          }
        }
      },
      CallExpression(node: Rule.Node) {
        if (isAstNode(node) && isMkdtemp(node['callee'])) {
          context.report({ node, messageId: 'matched' });
        }
      },
    };
  },
};

export default rule;

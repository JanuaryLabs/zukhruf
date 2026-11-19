import { dirname } from 'node:path';

import type { Rule } from 'eslint';

import { identifierName, isType } from '../authoring/ast.ts';
import { workspacePackageNames } from '../workspace/workspace-packages.ts';
import { workspaceRootOf } from '../workspace/workspace-root.ts';

/** The methods that replace a module, by the object they are called on. */
const MODULE_MOCKS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['vi', new Set(['mock', 'doMock'])],
  ['jest', new Set(['mock', 'doMock', 'unstable_mockModule'])],
]);

/** `vi.mock`, `jest.mock` and the other MODULE_MOCKS, and node:test's `mock.module` or `t.mock.module`. */
function isModuleMock(callee: unknown): boolean {
  if (!isType(callee, 'MemberExpression') || callee['computed'] !== false) {
    return false;
  }
  const method = identifierName(callee['property']);
  const owner = callee['object'];
  if (method === 'module') {
    return (
      identifierName(owner) === 'mock' ||
      (isType(owner, 'MemberExpression') &&
        owner['computed'] === false &&
        identifierName(owner['property']) === 'mock')
    );
  }
  const name = identifierName(owner);
  return (
    method !== undefined &&
    name !== undefined &&
    MODULE_MOCKS.get(name)?.has(method) === true
  );
}

/** The module a mock names: a string, or Vitest's `vi.mock(import('./x.ts'))`. */
function specifierOf(argument: unknown): string | undefined {
  const literal = isType(argument, 'ImportExpression')
    ? argument['source']
    : argument;
  return isType(literal, 'Literal') && typeof literal['value'] === 'string'
    ? literal['value']
    : undefined;
}

/** `@scope/name` of `@scope/name/sub`, `name` of `name/sub`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return parts.slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
}

/**
 * A module mock replaces a module by its path. Of a module the workspace owns
 * (a relative path, or a package of the same workspace), it binds the test to
 * where that code lives today: when the code moves, the mock silently stops
 * applying and the test keeps passing on the real code, asserting nothing.
 * Drive the real module instead, and replace only what lies outside the
 * workspace (HTTP with msw, a native addon or electron with a module mock).
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a module mock of a relative path or of a package of the same workspace',
    },
    schema: [],
    messages: {
      own: "'{{specifier}}' is code of this workspace. A mock of it binds the test to its path, and the mock stops applying, with the test still passing, when the code moves. Run the real module and replace only what lies outside the workspace: HTTP with msw, a database with a real one, the data the module reads through its inputs.",
    },
  },
  create(context) {
    const root = workspaceRootOf(dirname(context.physicalFilename));
    const isOwn = (specifier: string) =>
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      (root !== undefined &&
        workspacePackageNames(root).has(packageOf(specifier)));
    return {
      CallExpression(node) {
        if (!isModuleMock(node.callee)) return;
        const specifier = specifierOf(node.arguments[0]);
        if (specifier !== undefined && isOwn(specifier)) {
          context.report({ node, messageId: 'own', data: { specifier } });
        }
      },
    };
  },
};

export default rule;

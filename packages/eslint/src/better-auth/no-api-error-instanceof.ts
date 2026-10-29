import {
  ESLintUtils,
  type TSESLint,
  type TSESTree,
} from '@typescript-eslint/utils';

import { eslintRule } from '../authoring/rule-module.ts';

const SOURCES = new Set([
  'better-auth',
  'better-auth/api',
  '@better-auth/core/error',
  'better-call',
  'better-call/error',
]);

function importOf(
  scope: TSESLint.Scope.Scope,
  node: TSESTree.Node,
): TSESTree.Node | undefined {
  const definition = scope.references.find(
    (reference) => reference.identifier === node,
  )?.resolved?.defs[0];
  return definition?.type === 'ImportBinding' &&
    definition.parent.type === 'ImportDeclaration' &&
    SOURCES.has(definition.parent.source.value)
    ? definition.node
    : undefined;
}

function isApiErrorClass(
  scope: TSESLint.Scope.Scope,
  right: TSESTree.Expression,
): boolean {
  if (
    right.type === 'MemberExpression' &&
    !right.computed &&
    right.property.type === 'Identifier' &&
    right.property.name === 'APIError'
  ) {
    return importOf(scope, right.object)?.type === 'ImportNamespaceSpecifier';
  }
  const node = importOf(scope, right);
  return (
    node?.type === 'ImportSpecifier' &&
    node.imported.type === 'Identifier' &&
    node.imported.name === 'APIError'
  );
}

/**
 * better-auth's `APIError` extends better-call's, so an `APIError` that
 * better-call throws itself fails `instanceof` against better-auth's class,
 * and the error falls through to the 500 path. `isAPIError()` checks both
 * classes and the error's name, which also covers a second copy of
 * better-call (its CommonJS and ESM builds have separate classes).
 */
const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow instanceof against better-auth and better-call APIError',
    },
    schema: [],
    messages: {
      instanceof:
        "instanceof misses an APIError of another class: better-auth's APIError subclasses better-call's, so an APIError that better-call throws is not an instance of it. Use isAPIError(error) from 'better-auth/api'.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator !== 'instanceof') return;
        if (isApiErrorClass(context.sourceCode.getScope(node), node.right)) {
          context.report({ node, messageId: 'instanceof' });
        }
      },
    };
  },
});

export default eslintRule(rule);

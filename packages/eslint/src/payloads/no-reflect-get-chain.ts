import { ASTUtils, ESLintUtils, type TSESTree } from '@typescript-eslint/utils';

import { eslintRule } from '../authoring/rule-module.ts';

/** `Reflect.get(…)`. */
function isReflectGet(node: TSESTree.Node | null | undefined): boolean {
  return (
    node?.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'Reflect' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'get'
  );
}

/** `node` without the wrappers that keep its value: `as`, `satisfies`, `!` and `Object(…)`. */
function unwrapped(node: TSESTree.Node | null | undefined) {
  let current = node;
  while (current) {
    if (
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion'
    ) {
      current = current.expression;
    } else if (
      current.type === 'CallExpression' &&
      current.callee.type === 'Identifier' &&
      current.callee.name === 'Object' &&
      current.arguments.length === 1
    ) {
      current = current.arguments[0];
    } else {
      return current;
    }
  }
  return current;
}

const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow Reflect.get on the result of another Reflect.get, which guesses the shape of data one field at a time',
    },
    schema: [],
    messages: {
      chain:
        'Do not walk a payload with Reflect.get on Reflect.get. Type the payload from the real data and read its fields directly, with optional chaining; at a boundary that nothing else validates, parse it once with a schema.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isReflectGet(node)) return;
        const target = unwrapped(node.arguments[0]);
        if (isReflectGet(target)) {
          context.report({ node, messageId: 'chain' });
          return;
        }
        if (target?.type !== 'Identifier') return;
        const definition = ASTUtils.findVariable(
          context.sourceCode.getScope(node),
          target,
        )?.defs[0];
        if (
          definition?.type === 'Variable' &&
          isReflectGet(unwrapped(definition.node.init))
        ) {
          context.report({ node, messageId: 'chain' });
        }
      },
    };
  },
});

export default eslintRule(rule);

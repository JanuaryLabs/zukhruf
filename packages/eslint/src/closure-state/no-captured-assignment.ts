import { ESLintUtils, type TSESLint } from '@typescript-eslint/utils';

import { eslintRule } from '../authoring/rule-module.ts';

/** A `let`, a `var` or a parameter: a binding that its function can assign again. */
function assignable(variable: TSESLint.Scope.Variable): boolean {
  return variable.defs.some(
    (def) =>
      def.type === 'Parameter' ||
      (def.type === 'Variable' && def.parent.kind !== 'const'),
  );
}

/**
 * `x ??= …` is a lazy memo: it sets the value one time and never clears it,
 * so after the first write every closure reads the same value.
 */
function lazyMemo(reference: TSESLint.Scope.Reference): boolean {
  const { parent } = reference.identifier;
  return (
    parent.type === 'AssignmentExpression' &&
    parent.operator === '??=' &&
    parent.left === reference.identifier
  );
}

const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a nested function that assigns a let, a var or a parameter of an enclosing function',
    },
    schema: [],
    messages: {
      capturedAssignment:
        'Do not assign `{{name}}` from a nested function: it belongs to an enclosing function, so its value depends on the order in which the closures run. Return the value, give the state to an object that owns it, or use the primitive for the job, such as Promise.withResolvers or Array.prototype.reduce.',
    },
  },
  create(context) {
    return {
      'Program:exit'() {
        for (const scope of context.sourceCode.scopeManager?.scopes ?? []) {
          for (const variable of scope.variables) {
            const owner = variable.scope.variableScope;
            if (owner.type !== 'function' || !assignable(variable)) continue;
            for (const reference of variable.references) {
              if (
                reference.isWrite() &&
                !reference.init &&
                reference.from.variableScope !== owner &&
                !lazyMemo(reference)
              ) {
                context.report({
                  node: reference.identifier,
                  messageId: 'capturedAssignment',
                  data: { name: variable.name },
                });
              }
            }
          }
        }
      },
    };
  },
});

export default eslintRule(rule);

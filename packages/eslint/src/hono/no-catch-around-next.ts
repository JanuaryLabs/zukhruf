import { ESLintUtils, type TSESTree } from '@typescript-eslint/utils';
import type { Rule } from 'eslint';

import { eslintRule } from '../authoring/rule-module.ts';
import { scopedRule } from '../authoring/scoped-rule.ts';

function isNextCall(expression: TSESTree.Expression | null): boolean {
  return (
    expression?.type === 'CallExpression' &&
    expression.callee.type === 'Identifier' &&
    expression.callee.name === 'next' &&
    expression.arguments.length === 0
  );
}

function isAwaitedNext(expression: TSESTree.Expression | null): boolean {
  return (
    expression?.type === 'AwaitExpression' && isNextCall(expression.argument)
  );
}

function onlyCallsNext([statement, ...rest]: TSESTree.Statement[]): boolean {
  if (statement === undefined || rest.length > 0) return false;
  if (statement.type === 'ExpressionStatement') {
    return isAwaitedNext(statement.expression);
  }
  return (
    statement.type === 'ReturnStatement' &&
    (isAwaitedNext(statement.argument) || isNextCall(statement.argument))
  );
}

function importsHono(context: Rule.RuleContext): boolean {
  return context.sourceCode.ast.body.some(
    (statement) =>
      statement.type === 'ImportDeclaration' &&
      /^hono(?:\/|$)/.test(String(statement.source.value)),
  );
}

/**
 * Hono's `compose()` catches an error of each handler and passes it to the
 * app's error handler, which always exists, so `await next()` never rejects
 * and a `catch` around it never runs. Translate the error where it is thrown,
 * or read `c.error` after `next()`. The rule runs only in a file that imports
 * Hono: in Koa, the same `catch` is the documented error handler.
 */
const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow a catch around only next() in Hono middleware',
    },
    schema: [],
    messages: {
      deadCatch:
        "Hono catches a handler's error before next() returns, so this catch never runs. Translate the error where it is thrown, or read c.error after next().",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      TryStatement(node) {
        if (node.handler && onlyCallsNext(node.block.body)) {
          context.report({ node: node.handler, messageId: 'deadCatch' });
        }
      },
    };
  },
});

export default scopedRule(eslintRule(rule), importsHono);

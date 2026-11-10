import type { Rule } from 'eslint';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
} from '../authoring/ast.ts';
import { isRecord } from '../unknown-values.ts';

const DECLARATIONS = new Set(['test', 'it', 'describe', 'suite']);

/** The name at the root of `test.each(rows)` or `describe.skip`, or `test` for `t.test`. */
function declarationName(callee: unknown): string | undefined {
  if (
    isType(callee, 'MemberExpression') &&
    identifierName(callee['object']) === 't'
  ) {
    return identifierName(callee['property']);
  }
  let root = callee;
  while (isType(root, 'MemberExpression') || isType(root, 'CallExpression')) {
    root = isType(root, 'MemberExpression') ? root['object'] : root['callee'];
  }
  return identifierName(root);
}

function timeoutOption(options: AstNode): AstNode | undefined {
  const properties = Array.isArray(options['properties'])
    ? options['properties']
    : [];
  return properties.find(
    (property: unknown): property is AstNode =>
      isType(property, 'Property') &&
      identifierName(property['key']) === 'timeout',
  );
}

/**
 * The test target sets the time limit of each test. A shorter limit on one test
 * counts the work and a loaded runner together, so it fails on the runner and
 * not on the code, and a real hang fails at the target's limit anyway. The rule
 * reads an options object written in the call. A shared options object in a
 * variable is not seen. A value that is not a number literal is reported,
 * because the rule cannot prove it. It reports only with a `minimum`, because
 * that number is the limit of the repository's own test target.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow a per-test timeout option below the limit of the repository's test target",
    },
    schema: [
      {
        type: 'object',
        properties: { minimum: { type: 'number' } },
        required: ['minimum'],
        additionalProperties: false,
      },
    ],
    messages: {
      matched:
        "This limit is below the {{minimum}} ms of the test target: remove the timeout option, and let the target's limit catch a hang.",
    },
  },
  create(context) {
    const options: unknown = context.options[0];
    const minimum = isRecord(options) ? options['minimum'] : undefined;
    if (typeof minimum !== 'number') return {};
    return {
      CallExpression(node: Rule.Node) {
        if (!isAstNode(node)) return;
        const name = declarationName(node['callee']);
        if (name === undefined || !DECLARATIONS.has(name)) return;
        const args = Array.isArray(node['arguments']) ? node['arguments'] : [];
        for (const argument of args) {
          if (!isType(argument, 'ObjectExpression')) continue;
          const property = timeoutOption(argument);
          if (property === undefined) continue;
          const value = property['value'];
          const proven =
            isType(value, 'Literal') &&
            typeof value['value'] === 'number' &&
            value['value'] >= minimum;
          if (proven) continue;
          context.report({
            node: property,
            messageId: 'matched',
            data: { minimum: String(minimum) },
          });
        }
      },
    };
  },
};

export default rule;

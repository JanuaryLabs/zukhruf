import type { Rule } from 'eslint';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
} from '../authoring/ast.ts';

/** The one statement of a loop body, with or without braces. */
function onlyStatement(body: unknown): unknown {
  if (!isType(body, 'BlockStatement')) return body;
  const statements = Array.isArray(body['body']) ? body['body'] : [];
  return statements.length === 1 ? statements[0] : undefined;
}

/** The argument of `<array>.push(<argument>)`, the whole statement. */
function pushedValue(statement: unknown): AstNode | undefined {
  if (!isType(statement, 'ExpressionStatement')) return undefined;
  const call = statement['expression'];
  if (!isType(call, 'CallExpression')) return undefined;
  const callee = call['callee'];
  const args = Array.isArray(call['arguments']) ? call['arguments'] : [];
  if (
    !isType(callee, 'MemberExpression') ||
    identifierName(callee['property']) !== 'push' ||
    args.length !== 1 ||
    !isAstNode(args[0]) ||
    isType(args[0], 'SpreadElement')
  ) {
    return undefined;
  }
  return args[0];
}

/** The identifiers in `node`, a binding pattern or an expression. */
function identifiers(node: unknown): string[] {
  const name = identifierName(node);
  if (name !== undefined) return [name];
  if (!isAstNode(node)) return [];
  if (isType(node, 'MemberExpression') && node['computed'] !== true) {
    return identifiers(node['object']);
  }
  return Object.entries(node).flatMap(([key, value]) =>
    key === 'parent'
      ? []
      : Array.isArray(value)
        ? value.flatMap(identifiers)
        : identifiers(value),
  );
}

/**
 * A `for await` loop whose only statement pushes each value into an array is
 * `Array.fromAsync`, with the push's expression as its map function. A loop
 * that pushes on a condition, adds to a Set, or does more stays a loop.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow a for await loop that only collects values into an array',
    },
    schema: [],
    messages: {
      plain: 'Use Array.fromAsync(iterable).',
      mapped: 'Use Array.fromAsync(iterable, mapFn).',
    },
  },
  create(context) {
    return {
      'ForOfStatement[await=true]'(loop: Rule.Node) {
        if (!isAstNode(loop)) return;
        const left = loop['left'];
        const declarations =
          isType(left, 'VariableDeclaration') &&
          Array.isArray(left['declarations'])
            ? left['declarations']
            : [];
        const pattern =
          declarations.length === 1 && isAstNode(declarations[0])
            ? declarations[0]['id']
            : undefined;
        const value = pushedValue(onlyStatement(loop['body']));
        if (pattern === undefined || value === undefined) return;
        const bound = identifiers(pattern);
        if (
          isType(pattern, 'Identifier') &&
          identifierName(value) === bound[0]
        ) {
          context.report({ node: loop, messageId: 'plain' });
        } else if (identifiers(value).some((name) => bound.includes(name))) {
          context.report({ node: loop, messageId: 'mapped' });
        }
      },
    };
  },
};

export default rule;

import type { Rule } from 'eslint';

import { identifierName, isAstNode, isType } from '../authoring/ast.ts';
import { DECLARATIONS, rootName } from './declarations.ts';

const CASES = new Set(['test', 'it']);
const MODIFIERS = new Set(['skip', 'only', 'todo', 'each']);
const LOOPS = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement']);
const ITERATIONS = new Set(['forEach', 'map']);

/** `test`, `describe.skip`, `test.each` or `test.each(rows)`: a callee that declares, and not a call on a value named `test`. */
function declares(callee: unknown): boolean {
  if (isType(callee, 'Identifier')) {
    return DECLARATIONS.has(identifierName(callee) ?? '');
  }
  if (isType(callee, 'MemberExpression')) {
    return (
      MODIFIERS.has(identifierName(callee['property']) ?? '') &&
      declares(callee['object'])
    );
  }
  return isType(callee, 'CallExpression') && declares(callee['callee']);
}

function isFunction(node: unknown): boolean {
  return (
    isType(node, 'ArrowFunctionExpression') ||
    isType(node, 'FunctionExpression')
  );
}

/**
 * The callback of `test(…)`, `it(…)`, `test.skip(…)` or `test.each(…)`: the
 * body of a test case. A `t.test(…)` subtest is always inside one.
 */
function isTestCase(node: Rule.Node): boolean {
  const call = node.parent;
  return (
    isFunction(node) &&
    isType(call, 'CallExpression') &&
    CASES.has(rootName(call['callee']) ?? '')
  );
}

/** A for, for-in or for-of statement, or a `forEach` or `map` call whose callback `child` is. */
function isLoop(node: Rule.Node, child: Rule.Node): boolean {
  if (LOOPS.has(node.type)) return true;
  if (!isType(node, 'CallExpression') || !isFunction(child)) return false;
  const callee = node['callee'];
  const args = node['arguments'];
  return (
    isType(callee, 'MemberExpression') &&
    ITERATIONS.has(identifierName(callee['property']) ?? '') &&
    Array.isArray(args) &&
    args[0] === child
  );
}

/** The innermost loop that holds `node`, when no test case holds that loop. */
function loopOutsideTestCases(node: Rule.Node): Rule.Node | undefined {
  let loop: Rule.Node | undefined;
  for (let child = node; child.parent; child = child.parent) {
    if (isTestCase(child)) return undefined;
    loop ??= isLoop(child.parent, child) ? child.parent : undefined;
  }
  return loop;
}

/**
 * A loop that declares a test or a suite runs its cases as one block of code:
 * `test.each` or `suite.each` of `@zukhruf/testing/node` declares each case as
 * its own test, so each one has its own name and result. The rule follows
 * `jest/prefer-each` and `vitest/prefer-each`: it reports a for, for-in or
 * for-of loop, and a `forEach` or `map` callback, that calls `test`, `it`,
 * `describe` or `suite`, and not a loop inside a test case, which usually
 * checks several items of one result. Of nested loops, only the innermost one
 * that declares is reported.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Prefer test.each or suite.each of @zukhruf/testing/node over a loop that declares tests',
    },
    schema: [],
    messages: {
      preferEach:
        'Declare these cases with test.each or suite.each of @zukhruf/testing/node, not a loop: each case is then its own test, with its own name and result.',
    },
  },
  create(context) {
    const loops = new Set<Rule.Node>();
    return {
      CallExpression(node: Rule.Node) {
        if (!isAstNode(node) || !declares(node['callee'])) return;
        const loop = loopOutsideTestCases(node);
        if (loop !== undefined) loops.add(loop);
      },
      'Program:exit'() {
        for (const loop of loops) {
          context.report({ node: loop, messageId: 'preferEach' });
        }
      },
    };
  },
};

export default rule;

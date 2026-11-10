import type { Rule } from 'eslint';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
  resolvedVariable,
} from '../authoring/ast.ts';

const LOOPS = ['WhileStatement', 'DoWhileStatement', 'ForStatement'];
const ASSERT_EQUAL = new Set([
  'equal',
  'strictEqual',
  'deepEqual',
  'deepStrictEqual',
]);

/** `performance.now()` or `Date.now()`. A fake clock's `clock.performance.now()` is not a real read. */
function isClockRead(node: AstNode): boolean {
  if (!isType(node, 'CallExpression')) return false;
  const callee = node['callee'];
  if (!isType(callee, 'MemberExpression')) return false;
  if (identifierName(callee['property']) !== 'now') return false;
  const owner = identifierName(callee['object']);
  return owner === 'performance' || owner === 'Date';
}

function children(context: Rule.RuleContext, node: AstNode): AstNode[] {
  return (context.sourceCode.visitorKeys[node.type] ?? [])
    .flatMap((key) => node[key])
    .filter(isAstNode);
}

/** The values that `identifier` can hold: what its variable is written with. */
function writesOf(context: Rule.RuleContext, identifier: AstNode): AstNode[] {
  return (resolvedVariable(context, identifier)?.references ?? []).flatMap(
    ({ writeExpr }) => (isAstNode(writeExpr) ? [writeExpr] : []),
  );
}

/** Whether `node` reads the clock, or names a variable that holds a read. */
function holdsRead(context: Rule.RuleContext, node: AstNode): boolean {
  if (isClockRead(node)) return true;
  return (
    isType(node, 'Identifier') && writesOf(context, node).some(isClockRead)
  );
}

/**
 * Whether `node` is a time that has passed: a difference with a read of the
 * clock, the same in other units, or a variable that holds one.
 */
function isElapsed(context: Rule.RuleContext, node: AstNode): boolean {
  if (isType(node, 'Identifier')) {
    return writesOf(context, node).some(
      (write) => !isType(write, 'Identifier') && isElapsed(context, write),
    );
  }
  if (!isType(node, 'BinaryExpression')) return false;
  const operands = children(context, node);
  if (node['operator'] === '-') {
    return operands.some((operand) => holdsRead(context, operand));
  }
  return (
    (node['operator'] === '/' || node['operator'] === '*') &&
    operands.some((operand) => isElapsed(context, operand))
  );
}

/** The comparisons in `node`, also inside `&&` and `||`. */
function comparisonsIn(context: Rule.RuleContext, node: AstNode): AstNode[] {
  if (isType(node, 'LogicalExpression')) {
    return children(context, node).flatMap((child) =>
      comparisonsIn(context, child),
    );
  }
  return isType(node, 'BinaryExpression') ? [node] : [];
}

/** Whether `comparison` says that a time that has passed is below a limit. */
function isUpperBound(context: Rule.RuleContext, comparison: AstNode): boolean {
  const { left, right, operator } = comparison;
  if (!isAstNode(left) || !isAstNode(right)) return false;
  if (operator === '<' || operator === '<=') {
    return isElapsed(context, left);
  }
  if (operator === '>' || operator === '>=') {
    return isElapsed(context, right);
  }
  return false;
}

/** Whether a comparison in `test`, at any depth, reads the clock: the loop stops at a time. */
function comparesClock(context: Rule.RuleContext, test: AstNode): boolean {
  if (
    isType(test, 'BinaryExpression') &&
    ['<', '<=', '>', '>='].includes(String(test['operator']))
  ) {
    const { left, right } = test;
    if (
      (isAstNode(left) && hasClockRead(context, left)) ||
      (isAstNode(right) && hasClockRead(context, right))
    ) {
      return true;
    }
  }
  return children(context, test).some((child) => comparesClock(context, child));
}

function hasClockRead(context: Rule.RuleContext, node: AstNode): boolean {
  return (
    isClockRead(node) ||
    children(context, node).some((child) => hasClockRead(context, child))
  );
}

/** The expression that an assertion checks for truth: `assert(x)`, `assert.ok(x)`, `assert.equal(x, true)`. */
function assertedTrue(call: AstNode): unknown {
  const callee = call['callee'];
  const args = Array.isArray(call['arguments']) ? call['arguments'] : [];
  if (identifierName(callee) === 'assert') return args[0];
  if (!isType(callee, 'MemberExpression')) return undefined;
  const object = callee['object'];
  const fromAssert =
    identifierName(object) === 'assert' ||
    (isType(object, 'MemberExpression') &&
      identifierName(object['property']) === 'assert');
  if (!fromAssert) return undefined;
  const method = identifierName(callee['property']);
  if (method === 'ok') return args[0];
  if (method !== undefined && ASSERT_EQUAL.has(method)) {
    const expected: unknown = args[1];
    return isType(expected, 'Literal') && expected['value'] === true
      ? args[0]
      : undefined;
  }
  return undefined;
}

/**
 * A limit on real time is a claim about speed, and load breaks it: a database
 * notices a dead client when it does, and a loaded runner does everything late.
 * A loop that stops at a time is a hand-written `t.waitFor`, and an assertion
 * that an elapsed time is below a number is a speed claim. Wait for the fact
 * with `t.waitFor`, and run a timer of your own on `createClock()`. A lower
 * bound stays allowed, because load only makes it more true. The rule follows
 * variables in the same file. A time that comes from another process, or from a
 * property, is not seen.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a loop that stops at a time, and an assertion that an elapsed time is below a number',
    },
    schema: [],
    messages: {
      loop: 'This loop stops at a time on the real clock: use t.waitFor(() => { assert… }, { interval, timeout }), whose limit only catches a fact that never comes.',
      assertion:
        'This assertion claims a speed on the real clock, and load breaks it: wait for the fact with t.waitFor, or run your own timer on createClock(). A lower bound stays allowed.',
    },
  },
  create(context) {
    return {
      [LOOPS.join(',')](node: Rule.Node) {
        if (!isAstNode(node)) return;
        const test = node['test'];
        if (isAstNode(test) && comparesClock(context, test)) {
          context.report({ node, messageId: 'loop' });
        }
      },
      CallExpression(node: Rule.Node) {
        if (!isAstNode(node)) return;
        const asserted = assertedTrue(node);
        if (!isAstNode(asserted)) return;
        for (const comparison of comparisonsIn(context, asserted)) {
          if (isUpperBound(context, comparison)) {
            context.report({ node: comparison, messageId: 'assertion' });
          }
        }
      },
    };
  },
};

export default rule;

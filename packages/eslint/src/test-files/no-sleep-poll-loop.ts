import type { Rule } from 'eslint';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
} from '../authoring/ast.ts';

const TIMERS = new Set(['setTimeout', 'sleep', 'delay']);
const LOOPS = new Set(['WhileStatement', 'DoWhileStatement', 'ForStatement']);
const FUNCTIONS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

function calleeName(call: AstNode): string | undefined {
  const callee = call['callee'];
  return isType(callee, 'MemberExpression')
    ? identifierName(callee['property'])
    : identifierName(callee);
}

function isTimerCall(node: unknown): boolean {
  if (!isType(node, 'CallExpression')) return false;
  const name = calleeName(node);
  return name !== undefined && TIMERS.has(name);
}

/** `sleep(ms)`, `setTimeout(ms)` of `node:timers/promises`, or `new Promise((r) => setTimeout(r, ms))`. */
function isTimer(awaited: unknown): boolean {
  if (isTimerCall(awaited)) return true;
  if (!isType(awaited, 'NewExpression')) return false;
  const executor = Array.isArray(awaited['arguments'])
    ? awaited['arguments'][0]
    : undefined;
  const body = isAstNode(executor) ? executor['body'] : undefined;
  return (
    isTimerCall(body) ||
    (isType(body, 'BlockStatement') &&
      Array.isArray(body['body']) &&
      body['body'].some(
        (statement) =>
          isType(statement, 'ExpressionStatement') &&
          isTimerCall(statement['expression']),
      ))
  );
}

/** The loop that runs `node` again, in the same function. */
function enclosingLoop(node: AstNode): AstNode | undefined {
  let parent = node['parent'];
  while (isAstNode(parent) && !FUNCTIONS.has(parent.type)) {
    if (LOOPS.has(parent.type)) return parent;
    parent = parent['parent'];
  }
  return undefined;
}

/**
 * A loop that sleeps between checks is a hand-written `t.waitFor`: each copy
 * picks its own interval and deadline, and most fail with "the condition never
 * held" instead of the check's own error. `t.waitFor` of node:test retries
 * until the check passes and fails with the last error. A `for await` loop
 * and a timer awaited in a callback that the loop builds are not polls.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow a loop that sleeps between checks' },
    schema: [],
    messages: {
      matched:
        'Use t.waitFor(() => { assert… }, { interval, timeout }): it retries until the check passes and fails with the last error.',
    },
  },
  create(context) {
    const reported = new Set<AstNode>();
    return {
      AwaitExpression(node: Rule.Node) {
        if (!isAstNode(node) || !isTimer(node['argument'])) return;
        const loop = enclosingLoop(node);
        if (loop === undefined || reported.has(loop)) return;
        reported.add(loop);
        context.report({ node: loop, messageId: 'matched' });
      },
    };
  },
};

export default rule;

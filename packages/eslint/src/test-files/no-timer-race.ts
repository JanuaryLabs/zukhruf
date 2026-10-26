import type { Rule, Scope } from 'eslint';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
} from '../authoring/ast.ts';

/** Timers that take a callback: `setTimeout(() => reject(...), ms)`. */
const CALLBACK_TIMERS = new Set(['setTimeout']);
/** Timers that return a promise: `sleep(ms)`, `delay(ms)`, and `setTimeout(ms)` of `node:timers/promises`. */
const PROMISE_TIMERS = new Set(['sleep', 'delay', 'setTimeout']);

function calleeName(call: AstNode): string | undefined {
  const callee = call['callee'];
  if (isType(callee, 'MemberExpression'))
    return identifierName(callee['property']);
  return identifierName(callee);
}

function isTimerCall(node: unknown, names: Set<string>): node is AstNode {
  if (!isType(node, 'CallExpression')) return false;
  const name = calleeName(node);
  return name !== undefined && names.has(name);
}

/** Whether a reference to `variable` sits in the arguments of a callback timer. */
function calledByTimer(variable: Scope.Variable | undefined): boolean {
  return (variable?.references ?? []).some(({ identifier }) => {
    let child: unknown = identifier;
    let parent = isAstNode(child) ? child['parent'] : undefined;
    while (isAstNode(parent)) {
      if (
        isTimerCall(parent, CALLBACK_TIMERS) &&
        Array.isArray(parent['arguments']) &&
        parent['arguments'].includes(child)
      ) {
        return true;
      }
      child = parent;
      parent = parent['parent'];
    }
    return false;
  });
}

function declared(
  context: Rule.RuleContext,
  node: AstNode,
  name: string | undefined,
): Scope.Variable | undefined {
  return context.sourceCode
    .getDeclaredVariables(node)
    .find((variable) => variable.name === name);
}

/** `new Promise((_, reject) => setTimeout(() => reject(...), ms))`. */
function rejectingExecutor(context: Rule.RuleContext, node: AstNode): boolean {
  if (identifierName(node['callee']) !== 'Promise') return false;
  const executor = Array.isArray(node['arguments'])
    ? node['arguments'][0]
    : undefined;
  if (
    !isType(executor, 'ArrowFunctionExpression') &&
    !isType(executor, 'FunctionExpression')
  ) {
    return false;
  }
  const params = Array.isArray(executor['params']) ? executor['params'] : [];
  return calledByTimer(declared(context, executor, identifierName(params[1])));
}

/** `sleep(ms).then(() => { throw ... })`. */
function throwingContinuation(node: AstNode): boolean {
  const callee = node['callee'];
  if (
    !isType(callee, 'MemberExpression') ||
    identifierName(callee['property']) !== 'then' ||
    !isTimerCall(callee['object'], PROMISE_TIMERS)
  ) {
    return false;
  }
  const onFulfilled = Array.isArray(node['arguments'])
    ? node['arguments'][0]
    : undefined;
  const body = isAstNode(onFulfilled) ? onFulfilled['body'] : undefined;
  return (
    isType(body, 'BlockStatement') &&
    Array.isArray(body['body']) &&
    body['body'].some((statement) => isType(statement, 'ThrowStatement'))
  );
}

/**
 * `const { promise, reject } = Promise.withResolvers()`, or any other
 * destructured `reject`, with `reject` called by a timer.
 */
function rejectingResolvers(
  context: Rule.RuleContext,
  declarator: AstNode,
): boolean {
  const pattern = declarator['id'];
  if (!isType(pattern, 'ObjectPattern')) return false;
  const properties: unknown = pattern['properties'];
  if (!Array.isArray(properties)) return false;
  const reject: unknown = properties.find(
    (property: unknown) =>
      isType(property, 'Property') &&
      identifierName(property['key']) === 'reject',
  );
  return (
    isAstNode(reject) &&
    calledByTimer(
      declared(context, declarator, identifierName(reject['value'])),
    )
  );
}

function rejectsOnTimer(
  context: Rule.RuleContext,
  element: unknown,
  resolveBinding: boolean,
): boolean {
  if (isType(element, 'NewExpression')) {
    return rejectingExecutor(context, element);
  }
  if (isType(element, 'CallExpression')) return throwingContinuation(element);
  if (!resolveBinding || !isType(element, 'Identifier')) return false;
  const reference = context.sourceCode
    .getScope(element)
    .references.find(({ identifier }) => identifier === element);
  const definition = reference?.resolved?.defs[0];
  if (definition?.type !== 'Variable' || !isAstNode(definition.node)) {
    return false;
  }
  const declarator = definition.node;
  return isType(declarator['id'], 'Identifier')
    ? rejectsOnTimer(context, declarator['init'], false)
    : rejectingResolvers(context, declarator);
}

/**
 * A race against a timer that rejects fails the test when the promise is late,
 * with an error the test wrote itself, and leaves the promise running. A
 * timeout belongs to the test (`{ timeout }`), or to `settleWithin`, which
 * names what was late. Follows one variable: a timer built in a helper that
 * returns it is not seen. A timer that resolves a marker
 * (`sleep(ms).then(() => false)`, `delay(ms, 'pending')`) asserts that the
 * promise stays pending, which is a different check, and stays allowed.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow Promise.race against a timer that rejects',
    },
    schema: [],
    messages: {
      matched:
        'This race fails the test when the promise is late: use settleWithin(promise, label, ms) from @zukhruf/testing/async, or give the test its own { timeout }.',
    },
  },
  create(context) {
    return {
      'CallExpression[callee.object.name="Promise"][callee.property.name="race"] > ArrayExpression.arguments'(
        array: Rule.Node,
      ) {
        if (!isType(array, 'ArrayExpression')) return;
        const elements = Array.isArray(array['elements'])
          ? array['elements']
          : [];
        for (const element of elements) {
          if (isAstNode(element) && rejectsOnTimer(context, element, true)) {
            context.report({ node: element, messageId: 'matched' });
          }
        }
      },
    };
  },
};

export default rule;

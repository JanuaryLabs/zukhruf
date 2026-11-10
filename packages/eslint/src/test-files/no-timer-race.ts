import type { Rule, Scope } from 'eslint';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
  resolvedVariable,
} from '../authoring/ast.ts';

/** Timers that take a callback: `setTimeout(() => reject(...), ms)`. */
const CALLBACK_TIMERS = new Set(['setTimeout']);
/** Timers that return a promise: `sleep(ms)`, `delay(ms)`, and `setTimeout(ms)` of `node:timers/promises`. */
const PROMISE_TIMERS = new Set(['sleep', 'delay', 'setTimeout']);
const NEGATED = new Set([
  'notEqual',
  'notStrictEqual',
  'notDeepEqual',
  'notDeepStrictEqual',
]);
const COMPARISONS = new Set([
  ...NEGATED,
  'equal',
  'strictEqual',
  'deepEqual',
  'deepStrictEqual',
]);

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
  const definition = resolvedVariable(context, element)?.defs[0];
  if (definition?.type !== 'Variable' || !isAstNode(definition.node)) {
    return false;
  }
  const declarator = definition.node;
  return isType(declarator['id'], 'Identifier')
    ? rejectsOnTimer(context, declarator['init'], false)
    : rejectingResolvers(context, declarator);
}

/** The source of the value of a timer that resolves: `'pending'` of `delay(ms, 'pending')`, `false` of `sleep(ms).then(() => false)`. */
function markerOf(
  context: Rule.RuleContext,
  element: unknown,
  resolveBinding: boolean,
): string | undefined {
  if (isTimerCall(element, PROMISE_TIMERS)) {
    const value: unknown = Array.isArray(element['arguments'])
      ? element['arguments'][1]
      : undefined;
    return isAstNode(value) ? sourceOf(context, value) : 'undefined';
  }
  if (isType(element, 'CallExpression')) {
    const callee = element['callee'];
    if (
      isType(callee, 'MemberExpression') &&
      identifierName(callee['property']) === 'then' &&
      isTimerCall(callee['object'], PROMISE_TIMERS)
    ) {
      const handler: unknown = Array.isArray(element['arguments'])
        ? element['arguments'][0]
        : undefined;
      const body = isAstNode(handler) ? handler['body'] : undefined;
      return isAstNode(body) && !isType(body, 'BlockStatement')
        ? sourceOf(context, body)
        : undefined;
    }
    return undefined;
  }
  if (!resolveBinding || !isType(element, 'Identifier')) return undefined;
  const init = resolvedVariable(context, element)?.defs[0]?.node;
  return isAstNode(init) ? markerOf(context, init['init'], false) : undefined;
}

function sourceOf(context: Rule.RuleContext, node: AstNode): string {
  const value = isType(node, 'TSAsExpression') ? node['expression'] : node;
  return isAstNode(value) ? context.sourceCode.getText(value) : '';
}

/** The race itself, when `node` is that race, or an `await` of it. */
function isRace(node: unknown): node is AstNode {
  const call = isType(node, 'AwaitExpression') ? node['argument'] : node;
  if (!isType(call, 'CallExpression')) return false;
  const callee = call['callee'];
  return (
    isType(callee, 'MemberExpression') &&
    identifierName(callee['object']) === 'Promise' &&
    identifierName(callee['property']) === 'race'
  );
}

/** Each place that compares the result of `race` with a value: an assertion on the race, or on the variable that holds it. */
function comparedResults(
  context: Rule.RuleContext,
  race: AstNode,
): { actual: AstNode; assertion: AstNode }[] {
  const parent = race['parent'];
  const holder = isType(parent, 'AwaitExpression') ? parent : race;
  const declarator = holder['parent'];
  const places: AstNode[] = [holder];
  if (isType(declarator, 'VariableDeclarator')) {
    const [variable] = context.sourceCode.getDeclaredVariables(declarator);
    for (const reference of variable?.references ?? []) {
      if (isAstNode(reference.identifier) && !reference.isWrite()) {
        places.push(reference.identifier);
      }
    }
  }
  return places.flatMap((actual) => {
    const assertion = actual['parent'];
    if (!isType(assertion, 'CallExpression')) return [];
    const args = Array.isArray(assertion['arguments'])
      ? assertion['arguments']
      : [];
    if (args[0] !== actual) return [];
    const callee = assertion['callee'];
    const fromAssert =
      isType(callee, 'MemberExpression') &&
      identifierName(callee['object']) === 'assert' &&
      COMPARISONS.has(identifierName(callee['property']) ?? '');
    return fromAssert ? [{ actual, assertion }] : [];
  });
}

/**
 * A race against a timer that rejects fails the test when the promise is late,
 * with an error the test wrote itself, and leaves the promise running. A
 * timeout belongs to the test (`{ timeout }`), or to `settleWithin`, which
 * names what was late. Follows one variable: a timer built in a helper that
 * returns it is not seen. A timer that resolves a marker
 * (`sleep(ms).then(() => false)`, `delay(ms, 'pending')`) asserts that the
 * promise stays pending, which is a different check, and stays allowed, but an
 * assertion that the result is not the marker is a deadline in disguise: it
 * fails when the promise is late, so it claims a speed.
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
      deadline:
        'This race asserts that the timer lost, so it is a deadline in disguise, and load breaks it: await the promise, or wait for the fact with t.waitFor.',
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
        const markers = elements
          .map((element) => markerOf(context, element, true))
          .filter((marker) => marker !== undefined);
        const race = array['parent'];
        if (markers.length !== 1 || !isRace(race)) return;
        for (const { assertion } of comparedResults(context, race)) {
          const args = Array.isArray(assertion['arguments'])
            ? assertion['arguments']
            : [];
          const callee = assertion['callee'];
          const method = isType(callee, 'MemberExpression')
            ? identifierName(callee['property'])
            : undefined;
          const expected: unknown = args[1];
          const same =
            isAstNode(expected) && sourceOf(context, expected) === markers[0];
          const negated = method !== undefined && NEGATED.has(method);
          if (negated ? same : !same) {
            context.report({ node: assertion, messageId: 'deadline' });
          }
        }
      },
    };
  },
};

export default rule;

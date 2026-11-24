import type { Rule, Scope } from 'eslint';
import * as ts from 'typescript';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
  resolvedVariable,
} from '../authoring/ast.ts';
import { isRecord } from '../unknown-values.ts';

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
const EQUAL = new Set(['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual']);
/** The markers that are false in a condition. */
const FALSY = new Set(['false', 'null', 'undefined', '0', "''", '""']);
const FUNCTIONS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);
const CASTS = new Set(['TSAsExpression', 'TSSatisfiesExpression']);
/** The parents that give the value of their child unchanged. */
const PASS_THROUGH = new Set([
  'AwaitExpression',
  'TSNonNullExpression',
  'ChainExpression',
  ...CASTS,
]);
/** How many helpers deep the rule follows a race that a helper returns. */
const HELPER_DEPTH = 4;

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

function argumentsOf(call: AstNode): unknown[] {
  return Array.isArray(call['arguments']) ? call['arguments'] : [];
}

/** Whether a reference to `variable` sits in the arguments of a callback timer. */
function calledByTimer(variable: Scope.Variable | undefined): boolean {
  return (variable?.references ?? []).some(({ identifier }) => {
    let child: unknown = identifier;
    let parent = isAstNode(child) ? child['parent'] : undefined;
    while (isAstNode(parent)) {
      if (
        isTimerCall(parent, CALLBACK_TIMERS) &&
        argumentsOf(parent).includes(child)
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
  const executor = argumentsOf(node)[0];
  if (
    !isType(executor, 'ArrowFunctionExpression') &&
    !isType(executor, 'FunctionExpression')
  ) {
    return false;
  }
  const params = Array.isArray(executor['params']) ? executor['params'] : [];
  return calledByTimer(declared(context, executor, identifierName(params[1])));
}

/** `assert.fail(...)`, which throws. */
function isAssertFail(node: unknown): boolean {
  return isType(node, 'CallExpression') && assertMethod(node) === 'fail';
}

/** A statement or a block that throws: `throw …` or `assert.fail(…)`. */
function fails(node: unknown): boolean {
  if (isType(node, 'ThrowStatement')) return true;
  if (isType(node, 'ExpressionStatement')) {
    return isAssertFail(node['expression']);
  }
  return (
    isType(node, 'BlockStatement') &&
    Array.isArray(node['body']) &&
    node['body'].some((statement) => fails(statement))
  );
}

/** `sleep(ms).then(() => { throw … })`, or `sleep(ms).then(() => assert.fail(…))`. */
function throwingContinuation(node: AstNode): boolean {
  const callee = node['callee'];
  if (
    !isType(callee, 'MemberExpression') ||
    identifierName(callee['property']) !== 'then' ||
    !isTimerCall(callee['object'], PROMISE_TIMERS)
  ) {
    return false;
  }
  const onFulfilled = argumentsOf(node)[0];
  const body = isAstNode(onFulfilled) ? onFulfilled['body'] : undefined;
  return isAssertFail(body) || fails(body);
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

/**
 * The value that a race gives when its timer wins, as its source text
 * without spaces and casts: `{ settled: 'pending' as const }` and
 * `{settled: 'pending'}` are one marker. `member` is the marker of a property
 * of an object marker.
 */
interface Marker {
  readonly text: string;
  member(name: string): Marker | undefined;
}

/** A marker that the rule derives: the value of `result === marker` when the timer wins. */
const literalMarker = (text: string): Marker => ({
  text,
  member: () => undefined,
});

/** `text` without the spaces outside its string literals. */
function canonical(text: string): string {
  let out = '';
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (quote !== undefined) {
      out += char;
      if (char === '\\') out += text.charAt(++index);
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
    } else if (!/\s/.test(char)) {
      out += char;
    }
  }
  return out;
}

/** The canonical text from `start` to `end`, without the ranges in `cuts`. */
function textWithout(
  text: string,
  [start, end]: [number, number],
  cuts: [number, number][],
): string {
  let out = '';
  let at = start;
  for (const [from, to] of cuts.toSorted((a, b) => a[0] - b[0])) {
    if (from < at) continue;
    out += text.slice(at, from);
    at = to;
  }
  return canonical(out + text.slice(at, end));
}

function rangeOf(node: AstNode): [number, number] {
  return node.range ?? [0, 0];
}

function uncast(node: unknown): unknown {
  return isAstNode(node) && CASTS.has(node.type)
    ? uncast(node['expression'])
    : node;
}

/** The marker that a node of the linted file writes. */
function estreeMarker(context: Rule.RuleContext, node: AstNode): Marker {
  const cuts: [number, number][] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isAstNode(value)) return;
    const expression = value['expression'];
    if (CASTS.has(value.type) && isAstNode(expression)) {
      cuts.push([rangeOf(expression)[1], rangeOf(value)[1]]);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'parent') visit(child);
    }
  };
  visit(node);
  return {
    text: textWithout(context.sourceCode.text, rangeOf(node), cuts),
    member(name) {
      const object = uncast(node);
      if (!isType(object, 'ObjectExpression')) return undefined;
      const properties: unknown[] = Array.isArray(object['properties'])
        ? object['properties']
        : [];
      const property = properties.find(
        (candidate) =>
          isType(candidate, 'Property') &&
          candidate['computed'] !== true &&
          (identifierName(candidate['key']) === name ||
            (isType(candidate['key'], 'Literal') &&
              candidate['key']['value'] === name)),
      );
      const value = isAstNode(property) ? property['value'] : undefined;
      return isAstNode(value) ? estreeMarker(context, value) : undefined;
    },
  };
}

/** The marker that a node of another file of the program writes. */
function typescriptMarker(node: ts.Expression): Marker {
  const cuts: [number, number][] = [];
  const visit = (child: ts.Node) => {
    if (ts.isAsExpression(child) || ts.isSatisfiesExpression(child)) {
      cuts.push([child.expression.end, child.end]);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return {
    text: textWithout(
      node.getSourceFile().text,
      [node.getStart(), node.end],
      cuts,
    ),
    member(name) {
      let object = node;
      while (ts.isAsExpression(object) || ts.isSatisfiesExpression(object)) {
        object = object.expression;
      }
      if (!ts.isObjectLiteralExpression(object)) return undefined;
      for (const property of object.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) ||
            ts.isStringLiteral(property.name)) &&
          property.name.text === name
        ) {
          return typescriptMarker(property.initializer);
        }
      }
      return undefined;
    },
  };
}

/**
 * The value that `new Promise((resolve) => …)` resolves when a callback timer
 * calls `resolve`: `v` of `setTimeout(() => resolve(v), ms)` and of
 * `setTimeout(resolve, ms, v)`.
 */
function resolvingExecutorMarker(
  context: Rule.RuleContext,
  node: AstNode,
): Marker | undefined {
  const executor = argumentsOf(node)[0];
  if (
    identifierName(node['callee']) !== 'Promise' ||
    (!isType(executor, 'ArrowFunctionExpression') &&
      !isType(executor, 'FunctionExpression'))
  ) {
    return undefined;
  }
  const params = Array.isArray(executor['params']) ? executor['params'] : [];
  return timerResolvedMarker(
    context,
    declared(context, executor, identifierName(params[0])),
  );
}

/**
 * The value that a callback timer passes to `resolve`: `v` of
 * `setTimeout(() => resolve(v), ms)` and of `setTimeout(resolve, ms, v)`.
 */
function timerResolvedMarker(
  context: Rule.RuleContext,
  resolve: Scope.Variable | undefined,
): Marker | undefined {
  for (const { identifier } of resolve?.references ?? []) {
    const parent: unknown = isAstNode(identifier)
      ? identifier['parent']
      : undefined;
    if (!isTimerCall(parent, CALLBACK_TIMERS)) {
      const call = parent;
      if (
        !isType(call, 'CallExpression') ||
        call['callee'] !== identifier ||
        !calledByTimer(resolve)
      ) {
        continue;
      }
      const value = argumentsOf(call)[0];
      return isAstNode(value)
        ? estreeMarker(context, value)
        : literalMarker('undefined');
    }
    const args = argumentsOf(parent);
    if (args[0] !== identifier) continue;
    const value = args[2];
    return isAstNode(value)
      ? estreeMarker(context, value)
      : literalMarker('undefined');
  }
  return undefined;
}

/** The value of a timer that resolves: `'pending'` of `delay(ms, 'pending')`, `false` of `sleep(ms).then(() => false)`. */
function markerOf(
  context: Rule.RuleContext,
  element: unknown,
  resolveBinding: boolean,
): Marker | undefined {
  if (isType(element, 'NewExpression')) {
    return resolvingExecutorMarker(context, element);
  }
  if (isTimerCall(element, PROMISE_TIMERS)) {
    const value = argumentsOf(element)[1];
    return isAstNode(value)
      ? estreeMarker(context, value)
      : literalMarker('undefined');
  }
  if (isType(element, 'CallExpression')) {
    const callee = element['callee'];
    // `sleep(ms, null, { signal }).catch(…)`: the catch handles the abort
    // that ends the timer, and the timer's value stays the marker.
    if (
      isType(callee, 'MemberExpression') &&
      identifierName(callee['property']) === 'catch'
    ) {
      return markerOf(context, callee['object'], false);
    }
    if (
      isType(callee, 'MemberExpression') &&
      identifierName(callee['property']) === 'then' &&
      isTimerCall(callee['object'], PROMISE_TIMERS)
    ) {
      const handler = argumentsOf(element)[0];
      if (!isAstNode(handler) || !FUNCTIONS.has(handler.type)) return undefined;
      // A block that returns nothing resolves undefined; one that returns
      // one value resolves that value.
      const returned = returnedExpressions(handler);
      if (returned.length === 0) return literalMarker('undefined');
      return returned.length === 1 && returned[0] !== undefined
        ? estreeMarker(context, returned[0])
        : undefined;
    }
    return undefined;
  }
  if (!resolveBinding || !isType(element, 'Identifier')) return undefined;
  const declarator = resolvedVariable(context, element)?.defs[0]?.node;
  if (!isAstNode(declarator)) return undefined;
  return isType(declarator['id'], 'ObjectPattern')
    ? resolversMarker(context, declarator, element)
    : markerOf(context, declarator['init'], false);
}

/**
 * The value that a callback timer resolves the `promise` of
 * `const { promise, resolve } = Promise.withResolvers()` with. A `reject`
 * that another source calls does not change that the timer resolves.
 */
function resolversMarker(
  context: Rule.RuleContext,
  declarator: AstNode,
  element: AstNode,
): Marker | undefined {
  const init = declarator['init'];
  const callee = isType(init, 'CallExpression') ? init['callee'] : undefined;
  const pattern = declarator['id'];
  if (
    !isType(callee, 'MemberExpression') ||
    identifierName(callee['object']) !== 'Promise' ||
    identifierName(callee['property']) !== 'withResolvers' ||
    !isAstNode(pattern) ||
    !Array.isArray(pattern['properties'])
  ) {
    return undefined;
  }
  const properties: unknown[] = pattern['properties'];
  const bindingOf = (key: string): string | undefined => {
    const property = properties.find(
      (candidate) =>
        isType(candidate, 'Property') &&
        identifierName(candidate['key']) === key,
    );
    return isAstNode(property) ? identifierName(property['value']) : undefined;
  };
  if (bindingOf('promise') !== identifierName(element)) return undefined;
  return timerResolvedMarker(
    context,
    declared(context, declarator, bindingOf('resolve')),
  );
}

function isRace(node: unknown): node is AstNode {
  if (!isType(node, 'CallExpression')) return false;
  const callee = node['callee'];
  return (
    isType(callee, 'MemberExpression') &&
    identifierName(callee['object']) === 'Promise' &&
    identifierName(callee['property']) === 'race'
  );
}

function raceElements(race: AstNode): unknown[] {
  const array = argumentsOf(race)[0];
  return isType(array, 'ArrayExpression') && Array.isArray(array['elements'])
    ? array['elements']
    : [];
}

/** The marker of a race against one timer that resolves. */
function raceMarker(
  context: Rule.RuleContext,
  race: AstNode,
): Marker | undefined {
  const markers = raceElements(race)
    .filter((element) => !rejectsOnTimer(context, element, true))
    .map((element) => markerOf(context, element, true))
    .filter((marker) => marker !== undefined);
  return markers.length === 1 ? markers[0] : undefined;
}

/** The expressions that a function returns: its expression body, or the argument of each `return` of its own. */
function returnedExpressions(fn: AstNode): AstNode[] {
  const body = fn['body'];
  if (!isType(body, 'BlockStatement')) return isAstNode(body) ? [body] : [];
  const returned: AstNode[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isAstNode(value) || FUNCTIONS.has(value.type)) return;
    if (isType(value, 'ReturnStatement') && isAstNode(value['argument'])) {
      returned.push(value['argument']);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'parent') visit(child);
    }
  };
  visit(body['body']);
  return returned;
}

/** The function that `callee` names in the linted file: a declaration, or a variable that holds a function. */
function localFunction(
  context: Rule.RuleContext,
  callee: AstNode,
): AstNode | undefined {
  const definition = resolvedVariable(context, callee)?.defs[0];
  const node: unknown = definition?.node;
  if (definition?.type === 'FunctionName' && isAstNode(node)) return node;
  if (definition?.type !== 'Variable' || !isAstNode(node)) return undefined;
  const init = node['init'];
  return isAstNode(init) && FUNCTIONS.has(init.type) ? init : undefined;
}

function isProgram(value: unknown): value is ts.Program {
  return isRecord(value) && typeof value['getTypeChecker'] === 'function';
}

function isTypescriptCall(value: unknown): value is ts.CallExpression {
  return (
    isRecord(value) &&
    value['kind'] === ts.SyntaxKind.CallExpression &&
    typeof value['getSourceFile'] === 'function'
  );
}

/** The name that a call calls: `delay` of `delay(ms)` and of `timers.delay(ms)`. */
function typescriptCalleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return ts.isIdentifier(callee) ? callee.text : undefined;
}

function isTypescriptTimer(node: ts.Expression): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const name = typescriptCalleeName(node);
  return name !== undefined && PROMISE_TIMERS.has(name);
}

/** The marker of a timer that resolves, as `markerOf` reads it, in another file. */
function typescriptElementMarker(element: ts.Expression): Marker | undefined {
  if (isTypescriptTimer(element)) {
    const value = element.arguments[1];
    return value === undefined
      ? literalMarker('undefined')
      : typescriptMarker(value);
  }
  if (
    ts.isCallExpression(element) &&
    ts.isPropertyAccessExpression(element.expression) &&
    element.expression.name.text === 'catch'
  ) {
    return typescriptElementMarker(element.expression.expression);
  }
  if (
    ts.isCallExpression(element) &&
    ts.isPropertyAccessExpression(element.expression) &&
    element.expression.name.text === 'then' &&
    isTypescriptTimer(element.expression.expression)
  ) {
    const [handler] = element.arguments;
    return handler !== undefined &&
      ts.isArrowFunction(handler) &&
      !ts.isBlock(handler.body)
      ? typescriptMarker(handler.body)
      : undefined;
  }
  return undefined;
}

/** The marker of `Promise.race([...])` in another file. */
function typescriptRaceMarker(call: ts.CallExpression): Marker | undefined {
  const callee = call.expression;
  const [array] = call.arguments;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'Promise' ||
    callee.name.text !== 'race' ||
    array === undefined ||
    !ts.isArrayLiteralExpression(array)
  ) {
    return undefined;
  }
  const markers = array.elements
    .map((element) => typescriptElementMarker(element))
    .filter((marker) => marker !== undefined);
  return markers.length === 1 ? markers[0] : undefined;
}

/**
 * Reads the race that a called helper returns: in the linted file by the
 * scope of the callee, and in another file of the program through the type
 * checker, as `zukhruf/no-unhandled-readline-error` reads a helper's body.
 */
class Helpers {
  readonly #context: Rule.RuleContext;
  readonly #program: ts.Program | undefined;
  readonly #nodes: unknown;

  constructor(context: Rule.RuleContext) {
    this.#context = context;
    // A JavaScript file, or a run without type information, has no program:
    // the rule then follows only the helpers of the linted file.
    const services: unknown = context.sourceCode.parserServices;
    const program = isRecord(services) ? services['program'] : undefined;
    this.#program = isProgram(program) ? program : undefined;
    this.#nodes = isRecord(services)
      ? services['esTreeNodeToTSNodeMap']
      : undefined;
  }

  /** The marker of the race that the function `call` calls returns. */
  markerOfCall(call: AstNode, depth = 0): Marker | undefined {
    const callee = call['callee'];
    if (depth >= HELPER_DEPTH || !isType(callee, 'Identifier')) {
      return undefined;
    }
    const fn = localFunction(this.#context, callee);
    if (fn !== undefined) return this.#markerOfLocal(fn, depth);
    if (
      resolvedVariable(this.#context, callee)?.defs[0]?.type !==
        'ImportBinding' ||
      !(this.#nodes instanceof WeakMap)
    ) {
      return undefined;
    }
    const tsCall: unknown = this.#nodes.get(call);
    return isTypescriptCall(tsCall)
      ? this.#markerOfImported(tsCall, depth)
      : undefined;
  }

  #markerOfLocal(fn: AstNode, depth: number): Marker | undefined {
    for (const expression of returnedExpressions(fn)) {
      const returned = isType(expression, 'AwaitExpression')
        ? expression['argument']
        : expression;
      if (!isType(returned, 'CallExpression')) continue;
      const marker = isRace(returned)
        ? raceMarker(this.#context, returned)
        : this.markerOfCall(returned, depth + 1);
      if (marker !== undefined) return marker;
    }
    return undefined;
  }

  /**
   * The marker of the race that the body of the called function returns. A
   * function that only a declaration file declares has no body, so it does
   * not count.
   */
  #markerOfImported(
    call: ts.CallExpression,
    depth: number,
  ): Marker | undefined {
    if (depth >= HELPER_DEPTH || this.#program === undefined) return undefined;
    const declaration = this.#program
      .getTypeChecker()
      .getResolvedSignature(call)
      ?.getDeclaration();
    if (
      declaration === undefined ||
      !ts.isFunctionLike(declaration) ||
      !('body' in declaration) ||
      declaration.body === undefined
    ) {
      return undefined;
    }
    const { body } = declaration;
    const returned: ts.Expression[] = [];
    if (ts.isBlock(body)) {
      const visit = (node: ts.Node) => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isReturnStatement(node) && node.expression !== undefined) {
          returned.push(node.expression);
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(body, visit);
    } else {
      returned.push(body);
    }
    for (let expression of returned) {
      while (
        ts.isAwaitExpression(expression) ||
        ts.isParenthesizedExpression(expression)
      ) {
        expression = expression.expression;
      }
      if (!ts.isCallExpression(expression)) continue;
      const marker =
        typescriptRaceMarker(expression) ??
        this.#markerOfImported(expression, depth + 1);
      if (marker !== undefined) return marker;
    }
    return undefined;
  }
}

/** What one read of a race's result asserts. */
type Read =
  /** That the result is the marker: a late promise only makes it more true. */
  | { kind: 'pending' }
  /** That the result is not the marker: the timer must lose. */
  | { kind: 'deadline'; node: AstNode }
  /** Anything else, or nothing. */
  | { kind: 'ownLimit' }
  /** The race goes back to the caller of a helper, which is checked at each call. */
  | { kind: 'returned' };

/** The method of `assert` that `call` calls: `ok` for `assert(…)`. */
function assertMethod(call: AstNode): string | undefined {
  const callee = call['callee'];
  if (isType(callee, 'MemberExpression')) {
    return identifierName(callee['object']) === 'assert'
      ? identifierName(callee['property'])
      : undefined;
  }
  return identifierName(callee) === 'assert' ? 'ok' : undefined;
}

/**
 * Whether `node` only builds the report of a failure: the message of an
 * assertion, an argument of `assert.fail`, or what a `throw` throws. Such a
 * read runs after the check failed, so it asserts nothing.
 */
function describesFailure(node: AstNode): boolean {
  let child = node;
  let parent = node['parent'];
  while (isAstNode(parent) && !FUNCTIONS.has(parent.type)) {
    if (isType(parent, 'ThrowStatement')) return true;
    if (isType(parent, 'CallExpression') && parent['callee'] !== child) {
      const method = assertMethod(parent);
      const index = argumentsOf(parent).indexOf(child);
      if (method === 'fail') return true;
      if (method !== undefined && index >= (method === 'ok' ? 1 : 2)) {
        return true;
      }
    }
    child = parent;
    parent = parent['parent'];
  }
  return false;
}

/**
 * The reads of the value that a race, or a call of a helper that returns
 * one, gives. Each read is classified by what it asserts about the marker.
 */
class Reads {
  readonly #context: Rule.RuleContext;
  readonly #seen = new Set<Scope.Variable>();

  constructor(context: Rule.RuleContext) {
    this.#context = context;
  }

  of(node: AstNode, marker: Marker): Read[] {
    const parent = node['parent'];
    if (!isAstNode(parent)) return [{ kind: 'ownLimit' }];
    if (PASS_THROUGH.has(parent.type)) return this.of(parent, marker);
    if (isType(parent, 'MemberExpression') && parent['object'] === node) {
      const name =
        parent['computed'] === true
          ? undefined
          : identifierName(parent['property']);
      const member = name === undefined ? undefined : marker.member(name);
      return member === undefined
        ? [{ kind: 'ownLimit' }]
        : this.of(parent, member);
    }
    if (isType(parent, 'VariableDeclarator') && parent['init'] === node) {
      return this.#declared(parent, marker);
    }
    if (
      isType(parent, 'ReturnStatement') ||
      (isType(parent, 'ArrowFunctionExpression') && parent['body'] === node)
    ) {
      return [{ kind: 'returned' }];
    }
    if (isType(parent, 'CallExpression') && parent['callee'] !== node) {
      return [this.#asserted(parent, node, marker)];
    }
    if (isType(parent, 'BinaryExpression')) {
      return this.#compared(parent, node, marker);
    }
    if (isType(parent, 'UnaryExpression') && parent['operator'] === '!') {
      if (marker.text === 'true') {
        return this.of(parent, literalMarker('false'));
      }
      return FALSY.has(marker.text)
        ? this.of(parent, literalMarker('true'))
        : [{ kind: 'ownLimit' }];
    }
    if (isType(parent, 'IfStatement') && parent['test'] === node) {
      if (!fails(parent['consequent'])) return [{ kind: 'ownLimit' }];
      if (FALSY.has(marker.text)) return [{ kind: 'pending' }];
      return marker.text === 'true'
        ? [{ kind: 'deadline', node: parent }]
        : [{ kind: 'ownLimit' }];
    }
    return [{ kind: 'ownLimit' }];
  }

  /** The reads of the names that `const r = …` or `const { p } = …` binds. */
  #declared(declarator: AstNode, marker: Marker): Read[] {
    const pattern = declarator['id'];
    const variables = this.#context.sourceCode.getDeclaredVariables(declarator);
    const bindings: { name: string | undefined; marker?: Marker }[] = [];
    if (isType(pattern, 'Identifier')) {
      bindings.push({ name: identifierName(pattern), marker });
    } else if (isType(pattern, 'ObjectPattern')) {
      const properties: unknown[] = Array.isArray(pattern['properties'])
        ? pattern['properties']
        : [];
      for (const property of properties) {
        const key =
          isType(property, 'Property') && property['computed'] !== true
            ? identifierName(property['key'])
            : undefined;
        const member = key === undefined ? undefined : marker.member(key);
        if (!isType(property, 'Property') || member === undefined) {
          return [{ kind: 'ownLimit' }];
        }
        bindings.push({
          name: identifierName(property['value']),
          marker: member,
        });
      }
    } else {
      return [{ kind: 'ownLimit' }];
    }
    const reads: Read[] = [];
    for (const binding of bindings) {
      const variable = variables.find(({ name }) => name === binding.name);
      if (variable === undefined || binding.marker === undefined) {
        return [{ kind: 'ownLimit' }];
      }
      if (this.#seen.has(variable)) continue;
      this.#seen.add(variable);
      const identifiers = variable.references
        .filter((reference) => !reference.isWrite())
        .map((reference): unknown => reference.identifier)
        .filter((identifier) => isAstNode(identifier));
      if (identifiers.length === 0) return [{ kind: 'ownLimit' }];
      for (const identifier of identifiers) {
        if (!describesFailure(identifier)) {
          reads.push(...this.of(identifier, binding.marker));
        }
      }
    }
    return reads;
  }

  /** `assert.equal(r, marker)`, `assert.ok(r)` with a marker of `true`, and the assertions that the timer lost. */
  #asserted(call: AstNode, actual: AstNode, marker: Marker): Read {
    const method = assertMethod(call);
    const args = argumentsOf(call);
    if (method === 'ok' && args[0] === actual) {
      if (marker.text === 'true') return { kind: 'pending' };
      return FALSY.has(marker.text)
        ? { kind: 'deadline', node: call }
        : { kind: 'ownLimit' };
    }
    const index = args.indexOf(actual);
    const other = index === 0 ? args[1] : index === 1 ? args[0] : undefined;
    if (method === undefined || !isAstNode(other)) return { kind: 'ownLimit' };
    const same = estreeMarker(this.#context, other).text === marker.text;
    if (EQUAL.has(method)) {
      return same ? { kind: 'pending' } : { kind: 'deadline', node: call };
    }
    if (NEGATED.has(method)) {
      return same ? { kind: 'deadline', node: call } : { kind: 'pending' };
    }
    return { kind: 'ownLimit' };
  }

  /** `r === marker` is true when the timer wins, `r !== marker` is false, and a compare with another value is the reverse. */
  #compared(binary: AstNode, actual: AstNode, marker: Marker): Read[] {
    const operator = binary['operator'];
    const other = binary['left'] === actual ? binary['right'] : binary['left'];
    const equality = operator === '===' || operator === '==';
    if (
      !isAstNode(other) ||
      (!equality && operator !== '!==' && operator !== '!=')
    ) {
      return [{ kind: 'ownLimit' }];
    }
    const same = estreeMarker(this.#context, other).text === marker.text;
    return this.of(binary, literalMarker(same === equality ? 'true' : 'false'));
  }
}

/**
 * A race against a timer that rejects fails the test when the promise is late,
 * with an error the test wrote itself, and leaves the promise running. The
 * limit belongs to the test target: `untilAborted(promise, t.signal)` ends the
 * wait when the test's limit aborts `t.signal`. A race against a timer that
 * resolves a marker (`delay(ms, 'pending')`) also ends the wait at a limit of
 * its own, so it is allowed only when each read of its result asserts that
 * the result is the marker: that proves the promise stays pending, which load
 * only makes more true. A helper that returns such a race is checked at each
 * call: in the linted file by scope, and in another file through the type
 * checker when the run has type information.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow Promise.race against a timer, unless the race asserts that the timer's value won",
    },
    schema: [],
    messages: {
      matched:
        "This race fails the test when the promise is late: use untilAborted(promise, t.signal) from @zukhruf/async, which ends at the test's limit.",
      deadline:
        'This race asserts that the timer lost, so it is a deadline in disguise, and load breaks it: await the promise, or wait for the fact with waitFor(…, { signal: t.signal }).',
      ownLimit:
        "This race ends the wait at a limit of its own: await the promise through untilAborted(promise, t.signal), which ends at the test's limit; to prove that the promise stays pending, assert that the result is the timer's value.",
    },
  },
  create(context) {
    const helpers = new Helpers(context);
    const check = (result: AstNode, marker: Marker) => {
      const reads = new Reads(context).of(result, marker);
      for (const read of reads) {
        if (read.kind === 'deadline') {
          context.report({ node: read.node, messageId: 'deadline' });
        }
      }
      if (reads.some((read) => read.kind === 'ownLimit')) {
        context.report({ node: result, messageId: 'ownLimit' });
      }
    };
    return {
      CallExpression(node: Rule.Node) {
        if (!isAstNode(node)) return;
        if (!isRace(node)) {
          const marker = helpers.markerOfCall(node);
          if (marker !== undefined) check(node, marker);
          return;
        }
        for (const element of raceElements(node)) {
          if (isAstNode(element) && rejectsOnTimer(context, element, true)) {
            context.report({ node: element, messageId: 'matched' });
          }
        }
        const marker = raceMarker(context, node);
        if (marker !== undefined) check(node, marker);
      },
    };
  },
};

export default rule;

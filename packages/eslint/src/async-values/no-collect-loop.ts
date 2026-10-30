import type { Rule, Scope } from 'eslint';

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

/**
 * `out`, `this.out` or `a.b.out`: one array for every value. A conditional or
 * a computed key can pick a different array for each value, and
 * `Array.fromAsync` makes one.
 */
function oneArray(node: unknown): boolean {
  if (isType(node, 'Identifier') || isType(node, 'ThisExpression')) return true;
  return (
    isType(node, 'MemberExpression') &&
    node['computed'] !== true &&
    oneArray(node['object'])
  );
}

/** The `<array>.push(<argument>)` call that is the whole statement. */
function pushCall(statement: unknown): AstNode | undefined {
  if (!isType(statement, 'ExpressionStatement')) return undefined;
  const call = statement['expression'];
  if (!isType(call, 'CallExpression')) return undefined;
  const callee = call['callee'];
  const args = Array.isArray(call['arguments']) ? call['arguments'] : [];
  if (
    !isType(callee, 'MemberExpression') ||
    identifierName(callee['property']) !== 'push' ||
    !oneArray(callee['object']) ||
    args.length !== 1 ||
    !isAstNode(args[0]) ||
    isType(args[0], 'SpreadElement')
  ) {
    return undefined;
  }
  return call;
}

function isFunction(node: unknown): boolean {
  return (
    isType(node, 'FunctionExpression') ||
    isType(node, 'ArrowFunctionExpression') ||
    isType(node, 'FunctionDeclaration')
  );
}

/** The function whose body holds `node`, nearest first. */
function enclosingFunction(node: AstNode): AstNode | undefined {
  for (let current: unknown = node['parent']; isAstNode(current);) {
    if (isFunction(current)) return current;
    current = current['parent'];
  }
  return undefined;
}

function contains(outer: AstNode, node: unknown): boolean {
  for (let current = node; isAstNode(current); current = current['parent']) {
    if (current === outer) return true;
  }
  return false;
}

/**
 * The index of the statement in `statements` that holds `node`, or -1 when
 * `node` sits in a function, which can run at any time.
 */
function statementIndex(statements: unknown[], node: unknown): number {
  for (let current = node; isAstNode(current); current = current['parent']) {
    if (isFunction(current)) return -1;
    const index = statements.indexOf(current);
    if (index !== -1) return index;
  }
  return -1;
}

/**
 * True for `await promise;`, `await f(promise, ...);` and the same as a
 * declaration's value. A promise handed to an awaited call ends before the
 * next statement, as for a call made in place.
 */
function awaits(statement: unknown, promise: Scope.Variable): boolean {
  const declarations =
    isType(statement, 'VariableDeclaration') &&
    Array.isArray(statement['declarations'])
      ? statement['declarations']
      : [];
  const awaited = isType(statement, 'ExpressionStatement')
    ? statement['expression']
    : declarations.length === 1 && isAstNode(declarations[0])
      ? declarations[0]['init']
      : undefined;
  if (!isType(awaited, 'AwaitExpression')) return false;
  const argument = awaited['argument'];
  const operands = isType(argument, 'CallExpression')
    ? Array.isArray(argument['arguments'])
      ? argument['arguments']
      : []
    : [argument];
  return promise.references.some(({ identifier }) =>
    operands.includes(identifier),
  );
}

/**
 * The stored promise is awaited before any other code can see the array:
 * the promise's `const`, the array's `const` or `let` and the awaiting
 * statement sit in one statement list, and every other reference to the
 * array is in a later statement of that list, outside any function. A `var`,
 * or an array declared further out, outlives one run of the list, so a skipped
 * await leaves an earlier loop pushing while a later run reads.
 */
function settledBeforeRead(
  context: Rule.RuleContext,
  declarator: AstNode,
  array: Scope.Variable,
  push: AstNode,
): boolean {
  const declaration = declarator['parent'];
  const statements = isAstNode(declaration) ? declaration['parent'] : undefined;
  const body =
    isAstNode(statements) && Array.isArray(statements['body'])
      ? statements['body']
      : [];
  const arrayDeclaration = array.defs[0]?.parent;
  const [promise] = context.sourceCode.getDeclaredVariables(declarator);
  if (
    !isType(declaration, 'VariableDeclaration') ||
    declaration['kind'] !== 'const' ||
    !isType(declarator['id'], 'Identifier') ||
    promise === undefined ||
    array.defs.length !== 1 ||
    !isType(arrayDeclaration, 'VariableDeclaration') ||
    arrayDeclaration['kind'] === 'var' ||
    !body.includes(arrayDeclaration)
  ) {
    return false;
  }
  const settled = body.findIndex(
    (statement, index) =>
      index > body.indexOf(declaration) && awaits(statement, promise),
  );
  const name = array.defs[0]?.name;
  return (
    settled !== -1 &&
    array.references.every(
      ({ identifier }) =>
        identifier === name ||
        contains(push, identifier) ||
        statementIndex(body, identifier) > settled,
    )
  );
}

/**
 * Other code can read the array while the loop runs when the loop sits in a
 * function called in place whose promise is stored or returned, and the array
 * is declared outside that function, unless the stored promise is awaited
 * before any read (settledBeforeRead). `Array.fromAsync` gives the array only
 * when the iterable ends. A promise awaited in place, or handed to a call,
 * ends before the next statement reads the array, as far as the AST shows.
 */
function readWhileFilling(
  context: Rule.RuleContext,
  loop: AstNode,
  push: AstNode,
): boolean {
  const fn = enclosingFunction(loop);
  const call = fn?.['parent'];
  if (
    fn === undefined ||
    !isType(call, 'CallExpression') ||
    call['callee'] !== fn ||
    !(
      isType(call['parent'], 'VariableDeclarator') ||
      isType(call['parent'], 'AssignmentExpression') ||
      isType(call['parent'], 'ReturnStatement')
    )
  ) {
    return false;
  }
  const callee = push['callee'];
  const array = isType(callee, 'MemberExpression')
    ? callee['object']
    : undefined;
  if (!isType(array, 'Identifier')) return false;
  const variable = context.sourceCode
    .getScope(array)
    .references.find(({ identifier }) => identifier === array)?.resolved;
  if (variable === null || variable === undefined) return true;
  if (contains(fn, variable.scope.block)) return false;
  const holder = call['parent'];
  return !(
    isType(holder, 'VariableDeclarator') &&
    settledBeforeRead(context, holder, variable, push)
  );
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
 * that pushes on a condition, adds to a Set, or does more stays a loop, and so
 * does a loop whose array other code reads before the loop ends.
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
        const push = pushCall(onlyStatement(loop['body']));
        const args = Array.isArray(push?.['arguments'])
          ? push['arguments']
          : [];
        const value = args[0];
        if (
          pattern === undefined ||
          push === undefined ||
          readWhileFilling(context, loop, push)
        ) {
          return;
        }
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

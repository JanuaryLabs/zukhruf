import type { Rule } from 'eslint';

import { identifierName, isAstNode, isType } from '../authoring/ast.ts';

/** A promise made in the same expression, which nothing else can await. */
const FRESH =
  '[callee.object.type=/^(CallExpression|NewExpression|AwaitExpression)$/]';

/** A rejection callback written in place, in `.catch` or as the second argument of `.then`. */
const CALLBACKS = [
  `CallExpression[callee.property.name="catch"]${FRESH} > :matches(ArrowFunctionExpression, FunctionExpression).arguments:first-child`,
  `CallExpression[callee.property.name="then"]${FRESH} > :matches(ArrowFunctionExpression, FunctionExpression).arguments:nth-child(2)`,
];

/**
 * A value written out in full: a literal, `undefined`, `void 0`, a negative
 * number, a template with no expression, or an array or object of these.
 */
function isFallback(node: unknown): boolean {
  if (!isAstNode(node)) return false;
  switch (node['type']) {
    case 'Literal':
      return true;
    case 'Identifier':
      return identifierName(node) === 'undefined';
    case 'UnaryExpression':
      return (
        (node['operator'] === 'void' || node['operator'] === '-') &&
        isType(node['argument'], 'Literal')
      );
    case 'TemplateLiteral':
      return (
        Array.isArray(node['expressions']) && node['expressions'].length === 0
      );
    case 'ArrayExpression':
      return (
        Array.isArray(node['elements']) && node['elements'].every(isFallback)
      );
    case 'ObjectExpression':
      return (
        Array.isArray(node['properties']) &&
        node['properties'].every(
          (property: unknown) =>
            isType(property, 'Property') &&
            property['computed'] !== true &&
            isFallback(property['value']),
        )
      );
    default:
      return false;
  }
}

/** A function body that only gives back a fallback: empty, `return;`, `return [];`, or `=> []`. */
function onlyFallsBack(body: unknown): boolean {
  if (!isType(body, 'BlockStatement')) return isFallback(body);
  const statements = Array.isArray(body['body']) ? body['body'] : [];
  if (statements.length === 0) return true;
  const [statement] = statements;
  return (
    statements.length === 1 &&
    isType(statement, 'ReturnStatement') &&
    (statement['argument'] === null || isFallback(statement['argument']))
  );
}

/**
 * A catch that drops the error hides it from every reader: the test that
 * should fail passes, and the log that should explain an outage is empty. A
 * comment beside it changes nothing at run time, so it does not excuse it. A
 * rejection callback drops the error when all it does is give back a value
 * written out in full, or nothing: `() => []` turns EACCES into an empty
 * folder. A callback that reads the error, calls a function, assigns or
 * throws acts on the failure, so it is not reported, nor is a named handler
 * such as `.catch(missing)`. Test cleanup that may fail runs in `await using`
 * with `AsyncDisposableStack.defer(cleanup)`: when the test and the cleanup
 * both fail, Node throws a SuppressedError that reports both, where a plain
 * `finally` loses the test's own failure. Other code catches only the error it
 * expects, by its code, and rethrows the rest. A promise kept in a variable
 * and marked handled with `p.catch(() => {})` stays allowed: the code that
 * awaits it still sees the rejection.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a catch that drops the error: an empty catch block, or a .catch or .then rejection callback that only returns a literal fallback or nothing',
    },
    schema: [],
    messages: {
      matched:
        'This catch drops the error, so nobody sees the failure. In test cleanup, use `await using` with `AsyncDisposableStack.defer(cleanup)`: Node then reports both the test failure and the cleanup failure. Elsewhere, catch only the error you expect, by its code, and rethrow the rest.',
    },
  },
  create(context) {
    const report = (node: Rule.Node) => {
      context.report({ node, messageId: 'matched' });
    };
    return {
      'CatchClause > BlockStatement.body[body.length=0]': report,
      ...Object.fromEntries(
        CALLBACKS.map((selector) => [
          selector,
          (node: Rule.Node) => {
            if (isAstNode(node) && onlyFallsBack(node['body'])) report(node);
          },
        ]),
      ),
    };
  },
};

export default rule;

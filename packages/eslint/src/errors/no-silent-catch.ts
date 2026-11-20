import { selectorRule } from '../authoring/selector-rule.ts';

/** A callback that drops the error: an empty body, or one that returns nothing. */
const SILENT = [
  'ArrowFunctionExpression[body.type="BlockStatement"][body.body.length=0]',
  'FunctionExpression[body.body.length=0]',
  'ArrowFunctionExpression[body.type="Identifier"][body.name="undefined"]',
  'ArrowFunctionExpression[body.type="Literal"][body.raw="null"]',
  'ArrowFunctionExpression[body.type="UnaryExpression"][body.operator="void"]',
].join(', ');

/** A promise made in the same expression, which nothing else can await. */
const FRESH =
  '[callee.object.type=/^(CallExpression|NewExpression|AwaitExpression)$/]';

/**
 * A catch that drops the error hides it from every reader: the test that
 * should fail passes, and the log that should explain an outage is empty. A
 * comment beside it changes nothing at run time, so it does not excuse it. Test
 * cleanup that may fail runs in `await using` with
 * `AsyncDisposableStack.defer(cleanup)`: when the test and the cleanup both
 * fail, Node throws a SuppressedError that reports both, where a plain
 * `finally` loses the test's own failure. Other code catches only the error it
 * expects, by its code, and rethrows the rest. A promise kept in a variable and
 * marked handled with `p.catch(() => {})` stays allowed: the code that awaits
 * it still sees the rejection.
 */
export default selectorRule({
  description:
    'Disallow a catch that drops the error: an empty catch block, or a .catch or .then rejection callback that returns nothing',
  selectors: [
    'CatchClause > BlockStatement.body[body.length=0]',
    `CallExpression[callee.property.name="catch"]${FRESH} > :matches(${SILENT}).arguments:first-child`,
    `CallExpression[callee.property.name="then"]${FRESH} > :matches(${SILENT}).arguments:nth-child(2)`,
  ],
  message:
    'This catch drops the error, so nobody sees the failure. In test cleanup, use `await using` with `AsyncDisposableStack.defer(cleanup)`: Node then reports both the test failure and the cleanup failure. Elsewhere, catch only the error you expect, by its code, and rethrow the rest.',
});

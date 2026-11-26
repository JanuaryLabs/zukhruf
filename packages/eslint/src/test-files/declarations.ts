import { identifierName, isType } from '../authoring/ast.ts';

/** The functions of node:test that declare a test or a suite. */
export const DECLARATIONS: ReadonlySet<string> = new Set([
  'test',
  'it',
  'describe',
  'suite',
]);

/** The name at the root of a callee: `test` for `test`, `describe.skip` and `test.each(rows)(…)`. */
export function rootName(callee: unknown): string | undefined {
  let root = callee;
  while (isType(root, 'MemberExpression') || isType(root, 'CallExpression')) {
    root = isType(root, 'MemberExpression') ? root['object'] : root['callee'];
  }
  return identifierName(root);
}

const CASES = new Set(['test', 'it']);

/**
 * The callback of `test(…)`, `it(…)`, `test.skip(…)` or `test.each(…)`: the
 * body of a test case. A `t.test(…)` subtest is always inside one.
 */
export function isTestCase(node: unknown): boolean {
  if (
    !isType(node, 'ArrowFunctionExpression') &&
    !isType(node, 'FunctionExpression')
  ) {
    return false;
  }
  const call = node['parent'];
  return (
    isType(call, 'CallExpression') && CASES.has(rootName(call['callee']) ?? '')
  );
}

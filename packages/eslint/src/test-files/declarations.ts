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

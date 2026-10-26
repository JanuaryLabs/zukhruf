import { selectorRule } from '../authoring/selector-rule.ts';

const NODE_TEST = '/^(node:)?test$/';

/**
 * The `mock` export of node:test belongs to no test: what it patches stays
 * patched until someone calls `mock.restoreAll()`, and that call also restores
 * the mocks of every other test that runs at the same time. `t.mock` belongs to
 * the test, and node:test restores it when the test ends, also when an assert
 * fails first.
 */
export default selectorRule({
  description: 'Disallow the global mock of node:test; use t.mock',
  selectors: [
    `ImportDeclaration[source.value=${NODE_TEST}] > ImportSpecifier[imported.name="mock"]`,
    `Program:has(ImportDeclaration[source.value=${NODE_TEST}]) MemberExpression[object.name=/^(test|it)$/][property.name="mock"]`,
  ],
  message:
    'Use t.mock (the TestContext of this test): node:test restores it when the test ends, also when an assert fails.',
});

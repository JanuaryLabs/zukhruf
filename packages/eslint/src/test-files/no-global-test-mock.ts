import type { Rule } from 'eslint';

import { identifierName, isAstNode, isType } from '../authoring/ast.ts';

const NODE_TEST = '/^(node:)?test$/';

/**
 * `mock.module(...)` as a statement of the program itself, outside every
 * function, test and describe. node:test runs each test file in its own
 * process, so that mock lives as long as the file and reaches no other file.
 * A subject that binds a module when it loads needs it: a `t.mock.module`
 * made inside one test cannot reach later tests, because the ESM cache keeps
 * the first link.
 */
function isFileModuleMock(reference: unknown): boolean {
  const access = isAstNode(reference) ? reference['parent'] : undefined;
  const call = isAstNode(access) ? access['parent'] : undefined;
  return (
    isType(access, 'MemberExpression') &&
    access['object'] === reference &&
    access['computed'] === false &&
    identifierName(access['property']) === 'module' &&
    isType(call, 'CallExpression') &&
    call['callee'] === access &&
    isType(call['parent'], 'ExpressionStatement') &&
    isType(call['parent']['parent'], 'Program')
  );
}

/**
 * The `mock` export of node:test belongs to no test: what it patches stays
 * patched until someone calls `mock.restoreAll()`, and that call also restores
 * the mocks of every other test that runs at the same time. `t.mock` belongs to
 * the test, and node:test restores it when the test ends, also when an assert
 * fails first. The import is allowed only when every use of it is a
 * `mock.module(...)` statement of the program (see `isFileModuleMock`).
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow the global mock of node:test; use t.mock',
    },
    schema: [],
    messages: {
      matched:
        'Use t.mock (the TestContext of this test): node:test restores it when the test ends, also when an assert fails.',
    },
  },
  create(context) {
    const report = (node: Rule.Node) =>
      context.report({ node, messageId: 'matched' });
    return {
      [`ImportDeclaration[source.value=${NODE_TEST}] > ImportSpecifier[imported.name="mock"]`](
        specifier: Rule.Node,
      ) {
        const references = context.sourceCode
          .getDeclaredVariables(specifier)
          .flatMap((variable) => variable.references);
        if (
          references.length === 0 ||
          !references.every(({ identifier }) => isFileModuleMock(identifier))
        ) {
          report(specifier);
        }
      },
      [`Program:has(ImportDeclaration[source.value=${NODE_TEST}]) MemberExpression[object.name=/^(test|it)$/][property.name="mock"]`]:
        report,
    };
  },
};

export default rule;

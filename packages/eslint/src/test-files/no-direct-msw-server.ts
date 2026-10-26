import type { Rule, Scope } from 'eslint';

import { identifierName, isAstNode, isType } from '../authoring/ast.ts';

const parentOf = (node: unknown) =>
  isAstNode(node) ? node['parent'] : undefined;

/**
 * The calls that the references to `variable` make: `setupServer()`, or
 * `namespace.setupServer()` when the variable is the module namespace.
 */
function callsOf(variable: Scope.Variable, member?: string): Rule.Node[] {
  return variable.references.flatMap(({ identifier }) => {
    const access = parentOf(identifier);
    const callee =
      member === undefined
        ? identifier
        : isType(access, 'MemberExpression') &&
            access['computed'] === false &&
            identifierName(access['property']) === member
          ? access
          : undefined;
    const call = parentOf(callee);
    return isType(call, 'CallExpression') && call['callee'] === callee
      ? [call]
      : [];
  });
}

/**
 * A server from msw's own `setupServer` sends an unmatched request to the
 * network unless the test passes the strict option, keeps no record of what it
 * answered, and stays open when a test forgets `close()`. `Msw` of
 * `@zukhruf/testing/msw` is always strict, records each request, and closes at
 * scope end. The rule follows the binding that `msw/node` exports, aliased or
 * through a namespace, so a `setupServer` from another module is not reported.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow msw's setupServer in tests; use Msw from @zukhruf/testing/msw",
    },
    schema: [],
    messages: {
      direct:
        'Use `new Msw().intercept(...handlers)` from @zukhruf/testing/msw: it is always strict, records each request, and closes at scope end.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'msw/node') return;
        for (const specifier of node.specifiers) {
          const [variable] = context.sourceCode.getDeclaredVariables(specifier);
          if (variable === undefined) continue;
          const calls =
            specifier.type === 'ImportNamespaceSpecifier'
              ? callsOf(variable, 'setupServer')
              : specifier.type === 'ImportSpecifier' &&
                  specifier.imported.type === 'Identifier' &&
                  specifier.imported.name === 'setupServer'
                ? callsOf(variable)
                : [];
          for (const call of calls) {
            context.report({ node: call, messageId: 'direct' });
          }
        }
      },
    };
  },
};

export default rule;

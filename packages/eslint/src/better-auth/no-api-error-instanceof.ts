import type { Rule, Scope } from 'eslint';
import type { Expression, PrivateIdentifier, Super } from 'estree';

const SOURCES = new Set([
  'better-auth',
  'better-auth/api',
  '@better-auth/core/error',
  'better-call',
  'better-call/error',
]);

function importOf(
  scope: Scope.Scope,
  identifier: Expression | PrivateIdentifier | Super,
): Extract<Scope.Definition, { type: 'ImportBinding' }> | undefined {
  const variable = scope.references.find(
    (reference) => reference.identifier === identifier,
  )?.resolved;
  const definition = variable?.defs[0];
  return definition?.type === 'ImportBinding' &&
    SOURCES.has(String(definition.parent.source.value))
    ? definition
    : undefined;
}

function isApiErrorClass(
  scope: Scope.Scope,
  right: Expression | PrivateIdentifier,
): boolean {
  if (
    right.type === 'MemberExpression' &&
    !right.computed &&
    right.property.type === 'Identifier' &&
    right.property.name === 'APIError'
  ) {
    return (
      importOf(scope, right.object)?.node.type === 'ImportNamespaceSpecifier'
    );
  }
  const node = importOf(scope, right)?.node;
  return (
    node?.type === 'ImportSpecifier' &&
    node.imported.type === 'Identifier' &&
    node.imported.name === 'APIError'
  );
}

/**
 * better-auth's `APIError` extends better-call's, so an `APIError` that
 * better-call throws itself fails `instanceof` against better-auth's class,
 * and the error falls through to the 500 path. `isAPIError()` checks both
 * classes and the error's name, which also covers a second copy of
 * better-call (its CommonJS and ESM builds have separate classes).
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow instanceof against better-auth and better-call APIError',
    },
    schema: [],
    messages: {
      instanceof:
        "instanceof misses an APIError of another class: better-auth's APIError subclasses better-call's, so an APIError that better-call throws is not an instance of it. Use isAPIError(error) from 'better-auth/api'.",
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator !== 'instanceof') return;
        if (isApiErrorClass(context.sourceCode.getScope(node), node.right)) {
          context.report({ node, messageId: 'instanceof' });
        }
      },
    };
  },
};

export default rule;

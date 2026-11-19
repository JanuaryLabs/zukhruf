import type { Rule } from 'eslint';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
  resolvedVariable,
} from '../authoring/ast.ts';

const ASSERT_MODULES = new Set([
  'node:assert',
  'node:assert/strict',
  'assert',
  'assert/strict',
]);

/**
 * The import that `identifier` reads: the module it names, and the name it
 * imports (`*` for a namespace, `default` for a default import).
 */
function importOf(
  context: Rule.RuleContext,
  identifier: AstNode,
): { source: string; imported: string } | undefined {
  const definition = resolvedVariable(context, identifier)?.defs[0];
  if (definition?.type !== 'ImportBinding') return undefined;
  const source = definition.parent.source.value;
  if (typeof source !== 'string') return undefined;
  const specifier = definition.node;
  if (specifier.type === 'ImportNamespaceSpecifier') {
    return { source, imported: '*' };
  }
  if (specifier.type === 'ImportDefaultSpecifier') {
    return { source, imported: 'default' };
  }
  const imported = specifier.imported;
  return {
    source,
    imported:
      imported.type === 'Identifier' ? imported.name : String(imported.value),
  };
}

/**
 * `retryUntilReady(…)` or `namespace.retryUntilReady(…)`, imported from
 * `@zukhruf/testing/async`, or by a relative path, as the tests of
 * `@zukhruf/testing` import it.
 */
function callsRetryUntilReady(
  context: Rule.RuleContext,
  call: AstNode,
): boolean {
  const callee = call['callee'];
  const fromTesting = (source: string) =>
    source === '@zukhruf/testing/async' || source.startsWith('.');
  if (isType(callee, 'Identifier')) {
    const binding = importOf(context, callee);
    return (
      binding !== undefined &&
      binding.imported === 'retryUntilReady' &&
      fromTesting(binding.source)
    );
  }
  if (
    isType(callee, 'MemberExpression') &&
    callee['computed'] === false &&
    identifierName(callee['property']) === 'retryUntilReady' &&
    isType(callee['object'], 'Identifier')
  ) {
    const binding = importOf(context, callee['object']);
    return (
      binding !== undefined &&
      binding.imported === '*' &&
      fromTesting(binding.source)
    );
  }
  return false;
}

/** `assert(…)`, `assert.equal(…)`, `assert.strict.equal(…)` or `equal(…)`, each imported from node:assert. */
function callsAssert(context: Rule.RuleContext, call: AstNode): boolean {
  let root = call['callee'];
  while (isType(root, 'MemberExpression')) root = root['object'];
  if (!isType(root, 'Identifier')) return false;
  const binding = importOf(context, root);
  return binding !== undefined && ASSERT_MODULES.has(binding.source);
}

/** Each node below `node`, nested functions included. */
function* descendants(
  context: Rule.RuleContext,
  node: AstNode,
): Generator<AstNode> {
  for (const key of context.sourceCode.visitorKeys[node.type] ?? []) {
    const value = node[key];
    for (const child of Array.isArray(value) ? value : [value]) {
      if (!isAstNode(child)) continue;
      yield child;
      yield* descendants(context, child);
    }
  }
}

/** The value of the `shouldRetry` property of an options object literal. */
function shouldRetryOf(options: unknown): AstNode | undefined {
  if (!isType(options, 'ObjectExpression')) return undefined;
  const properties: unknown = options['properties'];
  if (!Array.isArray(properties)) return undefined;
  for (const property of properties) {
    if (
      isType(property, 'Property') &&
      property['computed'] === false &&
      identifierName(property['key']) === 'shouldRetry' &&
      isAstNode(property['value'])
    ) {
      return property['value'];
    }
  }
  return undefined;
}

/**
 * `retryUntilReady` of `@zukhruf/testing/async` waits for a service to come
 * up where no test context exists, such as the `healthy` check of a container:
 * it retries until the probe stops throwing, for at most 30 seconds by default.
 * A test that polls an assertion with it waits on a limit of its own, which a
 * loaded runner breaks. `waitFor(check, { signal: t.signal })` of the same
 * module polls until the check passes and ends at the test's limit. The rule
 * reports a `retryUntilReady` call whose function calls an assertion of
 * node:assert, nested functions included, or whose `shouldRetry` option names
 * `AssertionError`. It follows the import, aliased or through a namespace, so
 * a function of another module with the same name is not reported. The old
 * name `timebox` is not read: it no longer exists, so a repo that bumps
 * `@zukhruf/testing` renames its calls, and the rule sees them then.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow polling an assertion with retryUntilReady; use waitFor with t.signal',
    },
    schema: [],
    messages: {
      assert:
        "This retryUntilReady polls an assertion, which ends at a limit of its own: use waitFor(() => { assert… }, { signal: t.signal }) from @zukhruf/testing/async, which ends at the test's limit.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isAstNode(node) || !callsRetryUntilReady(context, node)) return;
        const [check, options]: unknown[] = Array.isArray(node['arguments'])
          ? node['arguments']
          : [];
        const assertsInCheck =
          (isType(check, 'ArrowFunctionExpression') ||
            isType(check, 'FunctionExpression')) &&
          descendants(context, check).some(
            (child) =>
              isType(child, 'CallExpression') && callsAssert(context, child),
          );
        const shouldRetry = shouldRetryOf(options);
        const namesAssertionError = (child: AstNode) =>
          identifierName(child) === 'AssertionError';
        const retriesAssertionError =
          shouldRetry !== undefined &&
          (namesAssertionError(shouldRetry) ||
            descendants(context, shouldRetry).some(namesAssertionError));
        if (assertsInCheck || retriesAssertionError) {
          context.report({ node, messageId: 'assert' });
        }
      },
    };
  },
};

export default rule;

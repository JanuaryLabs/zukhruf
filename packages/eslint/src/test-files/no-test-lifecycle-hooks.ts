import {
  ASTUtils,
  ESLintUtils,
  type TSESLint,
  type TSESTree,
} from '@typescript-eslint/utils';

import { eslintRule } from '../authoring/rule-module.ts';

const HOOKS = new Set([
  'before',
  'after',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
]);
const NODE_TEST = /^(node:)?test$/;
const TEST_FUNCTIONS = new Set(['test', 'it']);
const MODIFIERS = new Set(['only', 'skip', 'todo']);

type Resolve = (
  identifier: TSESTree.Identifier,
) => TSESLint.Scope.Variable | null;

function importClause(
  resolve: Resolve,
  node: TSESTree.Node,
): TSESTree.ImportClause | undefined {
  if (node.type !== 'Identifier') return undefined;
  const definition = resolve(node)?.defs[0];
  return definition?.type === 'ImportBinding' &&
    definition.node.type !== 'TSImportEqualsDeclaration'
    ? definition.node
    : undefined;
}

function importedName(specifier: TSESTree.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value;
}

function nodeTestImport(
  resolve: Resolve,
  node: TSESTree.Node,
): TSESTree.ImportClause | undefined {
  const clause = importClause(resolve, node);
  return clause?.parent.type === 'ImportDeclaration' &&
    NODE_TEST.test(clause.parent.source.value)
    ? clause
    : undefined;
}

function isNodeTestNamespace(resolve: Resolve, node: TSESTree.Node): boolean {
  return nodeTestImport(resolve, node)?.type === 'ImportNamespaceSpecifier';
}

/** `test` or `it` of node:test, also as `ns.test`, `test.only`, or the subtest `t.test`. */
function isTestFunction(resolve: Resolve, node: TSESTree.Node): boolean {
  if (node.type === 'Identifier') {
    const clause = nodeTestImport(resolve, node);
    return (
      clause?.type === 'ImportDefaultSpecifier' ||
      (clause?.type === 'ImportSpecifier' &&
        TEST_FUNCTIONS.has(importedName(clause)))
    );
  }
  if (node.type !== 'MemberExpression' || node.property.type !== 'Identifier') {
    return false;
  }
  const property = node.property.name;
  return (
    (MODIFIERS.has(property) && isTestFunction(resolve, node.object)) ||
    (TEST_FUNCTIONS.has(property) &&
      isNodeTestNamespace(resolve, node.object)) ||
    (property === 'test' && isTestContext(resolve, node.object))
  );
}

function isTestContextType(
  resolve: Resolve,
  annotation: TSESTree.TypeNode,
): boolean {
  if (annotation.type !== 'TSTypeReference') return false;
  const clause = nodeTestImport(resolve, annotation.typeName);
  return (
    clause?.type === 'ImportSpecifier' && importedName(clause) === 'TestContext'
  );
}

/** A parameter typed `TestContext`, or the first parameter of a test function's callback. */
function isTestContext(resolve: Resolve, node: TSESTree.Node): boolean {
  if (node.type !== 'Identifier') return false;
  const definition = resolve(node)?.defs[0];
  if (definition?.type !== 'Parameter') return false;
  const parameter = definition.name;
  if (
    parameter.typeAnnotation &&
    isTestContextType(resolve, parameter.typeAnnotation.typeAnnotation)
  ) {
    return true;
  }
  const callback = definition.node;
  const call = callback.parent;
  return (
    callback.params[0] === parameter &&
    call.type === 'CallExpression' &&
    call.arguments.some((argument) => argument === callback) &&
    isTestFunction(resolve, call.callee)
  );
}

function isHook(resolve: Resolve, callee: TSESTree.Expression): boolean {
  if (callee.type === 'Identifier') {
    const variable = resolve(callee);
    if (!variable || variable.defs.length === 0) return HOOKS.has(callee.name);
    const clause = importClause(resolve, callee);
    return (
      clause !== undefined &&
      (HOOKS.has(callee.name) ||
        (clause.type === 'ImportSpecifier' && HOOKS.has(importedName(clause))))
    );
  }
  return (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    HOOKS.has(callee.property.name) &&
    (isTestFunction(resolve, callee.object) ||
      isNodeTestNamespace(resolve, callee.object) ||
      isTestContext(resolve, callee.object))
  );
}

/**
 * A lifecycle hook moves arrange or teardown out of the test that needs it:
 * the reader no longer sees the whole test in one place, and state that one
 * test leaves behind reaches the next. A per-test `t.after()` of node:test has
 * the same cost, because the teardown is out of the test's own flow. The rule
 * reads a hook from Vitest, Jest or Mocha globals, from an import (also under
 * another name), from node:test's `test`, `it` or namespace (`test.after`), and
 * from a TestContext: the first parameter of a node:test test or subtest
 * callback, or a parameter typed `TestContext`. A function of the file that is
 * named `after` is not a hook.
 */
const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow test lifecycle hooks; each test arranges and tears down its own state',
    },
    schema: [],
    messages: {
      matched:
        'No test lifecycle hooks. Write self-contained AAA tests: inline arrange in each test and run teardown (cleanup, mock restore, resource stop) in a per-test try/finally or with `await using` a disposable.',
    },
  },
  defaultOptions: [],
  create(context) {
    const resolve: Resolve = (identifier) =>
      ASTUtils.findVariable(
        context.sourceCode.getScope(identifier),
        identifier,
      );
    return {
      CallExpression(node) {
        if (isHook(resolve, node.callee)) {
          context.report({ node, messageId: 'matched' });
        }
      },
    };
  },
});

export default eslintRule(rule);

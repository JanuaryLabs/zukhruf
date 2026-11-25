import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESLint,
  type TSESTree,
} from '@typescript-eslint/utils';

import { eslintRule } from '../authoring/rule-module.ts';
import { DECLARATIONS, rootName } from './declarations.ts';

function nameOf(node: TSESTree.Node | undefined): string | undefined {
  return node?.type === AST_NODE_TYPES.Identifier ? node.name : undefined;
}

/** `test(…)`, `describe.skip(…)`, `test.each(rows)(…)` or `t.test(…)`. */
function declares(node: TSESTree.Node | undefined): boolean {
  if (node?.type !== AST_NODE_TYPES.CallExpression) return false;
  const { callee } = node;
  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    DECLARATIONS.has(nameOf(callee.property) ?? '')
  ) {
    return true;
  }
  return DECLARATIONS.has(rootName(callee) ?? '');
}

function namesTestContext(annotation: TSESTree.TypeNode | undefined): boolean {
  if (annotation?.type !== AST_NODE_TYPES.TSTypeReference) return false;
  const name = annotation.typeName;
  const last = name.type === AST_NODE_TYPES.TSQualifiedName ? name.right : name;
  return nameOf(last) === 'TestContext';
}

function isMember(
  node: TSESTree.Node,
  object: string,
  property: string,
): boolean {
  return (
    node.type === AST_NODE_TYPES.MemberExpression &&
    nameOf(node.object) === object &&
    nameOf(node.property) === property
  );
}

type Context = Readonly<TSESLint.RuleContext<string, readonly unknown[]>>;

/** `t` of `test('x', (t) => …)`, or a parameter typed `TestContext`. */
function isDeclaredTestContext(
  context: Context,
  receiver: TSESTree.Identifier,
): boolean {
  const definition = context.sourceCode
    .getScope(receiver)
    .references.find((reference) => reference.identifier === receiver)?.resolved
    ?.defs[0];
  if (definition?.type !== 'Parameter') return false;
  const parameter = definition.name;
  if (namesTestContext(parameter.typeAnnotation?.typeAnnotation)) return true;
  const callback = definition.node;
  return (
    'params' in callback &&
    callback.params[0] === parameter &&
    declares(callback.parent)
  );
}

/**
 * A test context as the code declares it. With type information, also a value
 * whose type is `TestContext`, such as the parameter of a method that an
 * interface types.
 */
function isTestContext(context: Context, receiver: TSESTree.Node): boolean {
  if (
    receiver.type === AST_NODE_TYPES.Identifier &&
    isDeclaredTestContext(context, receiver)
  ) {
    return true;
  }
  const services = ESLintUtils.getParserServices(context, true);
  if (!services.program) return false;
  const type = services.getTypeAtLocation(receiver);
  return (type.aliasSymbol ?? type.getSymbol())?.getName() === 'TestContext';
}

/** `const signal = AbortSignal.timeout(ms)`, and the test reads `signal.reason`. */
function abortIsTheSubject(
  context: Context,
  call: TSESTree.CallExpression,
): boolean {
  const declarator = call.parent;
  if (declarator.type !== AST_NODE_TYPES.VariableDeclarator) return false;
  const [variable] = context.sourceCode.getDeclaredVariables(declarator);
  return (
    variable?.references.some((reference) => {
      const read = reference.identifier.parent;
      return (
        read.type === AST_NODE_TYPES.MemberExpression &&
        nameOf(read.property) === 'reason'
      );
    }) ?? false
  );
}

/**
 * The test target sets the time limit of each test, and `t.signal` aborts at
 * it. A wait that sets a limit of its own claims a speed, and a loaded runner
 * breaks it, while a fact that never comes fails at the test's limit anyway.
 * So a wait in a test ends on `t.signal`: an event wait through
 * `untilAborted(promise, t.signal)`, a poll through `waitFor` of
 * `@zukhruf/testing/async`. The rule reports `waitFor` on a test context, which
 * takes no signal, every `settleWithin`, whose limit is a number even by
 * default, and `AbortSignal.timeout`. A test whose subject is the abort reads
 * the reason of its signal, and that `AbortSignal.timeout` stays allowed. A
 * number in an option of the API under test (`waitAtMost`, `{ timeout }`) is
 * the input of that API, and the rule does not read it. A limit on a clock
 * that the test moves is not real time, and stays allowed. Type information is
 * optional: with it, the rule also sees a test context that an interface types.
 * `t.signal` ends at the runner's `--test-timeout`, which Node does not set:
 * the test target of `@zukhruf/nx` sets 300000, and
 * `zukhruf/no-missing-test-timeout` reports a target that runs `node --test`
 * without it.
 */
const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow a wait in a test that sets its own time limit',
    },
    schema: [],
    messages: {
      waitFor:
        "This wait takes no signal, so it ends at a limit of its own: use waitFor(() => { assert… }, { signal: t.signal }) from @zukhruf/testing/async, which ends at the test's limit (the runner's --test-timeout).",
      settleWithin:
        "settleWithin ends at a limit of its own: use untilAborted(promise, t.signal) from @zukhruf/async, which ends at the test's limit (the runner's --test-timeout).",
      signalTimeout:
        "This signal aborts at a limit of its own: pass t.signal, which aborts at the test's limit (the runner's --test-timeout). A test whose subject is the abort reads the reason of its signal.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (nameOf(callee) === 'settleWithin') {
          context.report({ node, messageId: 'settleWithin' });
          return;
        }
        if (isMember(callee, 'AbortSignal', 'timeout')) {
          if (!abortIsTheSubject(context, node)) {
            context.report({ node, messageId: 'signalTimeout' });
          }
          return;
        }
        if (
          callee.type === AST_NODE_TYPES.MemberExpression &&
          nameOf(callee.property) === 'waitFor' &&
          isTestContext(context, callee.object)
        ) {
          context.report({ node, messageId: 'waitFor' });
        }
      },
    };
  },
});

export default eslintRule(rule);

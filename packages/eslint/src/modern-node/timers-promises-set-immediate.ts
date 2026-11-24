import {
  ASTUtils,
  ESLintUtils,
  type TSESLint,
  type TSESTree,
} from '@typescript-eslint/utils';

import { eslintRule } from '../authoring/rule-module.ts';

const TIMERS_PROMISES = new Set(['timers/promises', 'node:timers/promises']);

type Executor = TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;

/** The one statement of a function body, or the expression of an arrow. */
function onlyExpression(body: Executor['body']): TSESTree.Node | undefined {
  if (body.type !== 'BlockStatement') return body;
  const [statement, ...rest] = body.body;
  return rest.length === 0 && statement?.type === 'ExpressionStatement'
    ? statement.expression
    : undefined;
}

function isFunction(node: TSESTree.Node | undefined): node is Executor {
  return (
    node?.type === 'ArrowFunctionExpression' ||
    node?.type === 'FunctionExpression'
  );
}

/** Whether `name` is not declared in `scope` or a scope around it. */
function isGlobal(scope: TSESLint.Scope.Scope, name: string): boolean {
  const variable = ASTUtils.findVariable(scope, name);
  return !variable || variable.defs.length === 0;
}

/** `resolve`, or `() => resolve()`: the callback calls resolve with no value. */
function resolvesWithNoValue(
  callback: TSESTree.Node | undefined,
  resolve: string,
): boolean {
  if (callback?.type === 'Identifier') return callback.name === resolve;
  if (!isFunction(callback) || callback.params.length > 0) return false;
  const call = onlyExpression(callback.body);
  return (
    call?.type === 'CallExpression' &&
    call.arguments.length === 0 &&
    call.callee.type === 'Identifier' &&
    call.callee.name === resolve
  );
}

/**
 * The global setImmediate call of `new Promise((resolve) =>
 * setImmediate(resolve))`. A value, as in `setImmediate(resolve, 'pending')`,
 * is left alone: it is the marker of a race, which zukhruf/no-timer-race reads.
 */
function immediateCallOf(
  sourceCode: Readonly<TSESLint.SourceCode>,
  node: TSESTree.NewExpression,
): TSESTree.CallExpression | undefined {
  const [executor, ...rest] = node.arguments;
  if (
    node.callee.type !== 'Identifier' ||
    node.callee.name !== 'Promise' ||
    rest.length > 0 ||
    !isFunction(executor) ||
    executor.params.length !== 1 ||
    executor.params[0]?.type !== 'Identifier'
  ) {
    return undefined;
  }
  const resolve = executor.params[0].name;
  const call = onlyExpression(executor.body);
  if (
    call?.type !== 'CallExpression' ||
    call.callee.type !== 'Identifier' ||
    call.callee.name !== 'setImmediate' ||
    call.arguments.length !== 1 ||
    !resolvesWithNoValue(call.arguments[0], resolve)
  ) {
    return undefined;
  }
  return isGlobal(sourceCode.getScope(node), 'Promise') &&
    isGlobal(sourceCode.getScope(call), 'setImmediate')
    ? call
    : undefined;
}

function timersPromisesImports(
  program: TSESTree.Program,
): TSESTree.ImportDeclaration[] {
  return program.body.filter(
    (statement): statement is TSESTree.ImportDeclaration =>
      statement.type === 'ImportDeclaration' &&
      statement.importKind !== 'type' &&
      TIMERS_PROMISES.has(statement.source.value),
  );
}

/** The import of setImmediate, by name or through a namespace. */
function importedImmediate(
  declarations: TSESTree.ImportDeclaration[],
): string | undefined {
  for (const { specifiers } of declarations) {
    for (const specifier of specifiers) {
      if (
        specifier.type === 'ImportSpecifier' &&
        specifier.importKind !== 'type' &&
        specifier.imported.type === 'Identifier' &&
        specifier.imported.name === 'setImmediate'
      ) {
        return specifier.local.name;
      }
      if (specifier.type === 'ImportNamespaceSpecifier') {
        return `${specifier.local.name}.setImmediate`;
      }
    }
  }
  return undefined;
}

/** Whether `name`, or the namespace object it reads, is the import at `scope`. */
function readsImport(scope: TSESLint.Scope.Scope, name: string): boolean {
  const [object = name] = name.split('.');
  const definition = ASTUtils.findVariable(scope, object)?.defs[0];
  return definition?.type === 'ImportBinding';
}

/**
 * How the sites of a file are fixed: through the import that the file has,
 * through a new import, or not at all.
 */
type FixPlan =
  | { readonly kind: 'reuse'; readonly name: string }
  | { readonly kind: 'import' }
  | { readonly kind: 'none' }
  | { readonly kind: 'globalStays' };

const IMPORT = `import { setImmediate } from 'node:timers/promises';`;

const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Use setImmediate() of node:timers/promises to wait for a turn of the event loop',
    },
    fixable: 'code',
    schema: [],
    messages: {
      oneTurn:
        'A turn of the event loop is one call: await setImmediate() of node:timers/promises.',
      immediateTaken:
        'A turn of the event loop is one call: await setImmediate() of node:timers/promises. The fix cannot import setImmediate here, because the file also calls the global setImmediate. Import setImmediate of node:timers/promises under another name, and the fix applies.',
    },
  },
  create(context) {
    const { sourceCode } = context;
    const found: {
      node: TSESTree.NewExpression;
      call: TSESTree.CallExpression;
    }[] = [];

    function importEdit(
      fixer: TSESLint.RuleFixer,
      declarations: TSESTree.ImportDeclaration[],
    ): TSESLint.RuleFix {
      const named = declarations.find(({ specifiers }) =>
        specifiers.some(({ type }) => type === 'ImportSpecifier'),
      );
      const last = named?.specifiers.at(-1);
      if (last) return fixer.insertTextAfter(last, ', setImmediate');
      const lastImport = sourceCode.ast.body.findLast(
        ({ type }) => type === 'ImportDeclaration',
      );
      return lastImport
        ? fixer.insertTextAfter(lastImport, `\n${IMPORT}`)
        : fixer.insertTextBeforeRange([0, 0], `${IMPORT}\n`);
    }

    function fixOf(
      plan: FixPlan,
      node: TSESTree.Node,
    ): TSESLint.ReportFixFunction | null {
      const fixable =
        sourceCode.ast.sourceType === 'module' &&
        found.every(
          (site) => sourceCode.getCommentsInside(site.node).length === 0,
        );
      if (!fixable || plan.kind === 'none') return null;
      if (plan.kind === 'reuse') {
        return (fixer) => fixer.replaceText(node, `${plan.name}()`);
      }
      // A site that stays would call the imported setImmediate with resolve as
      // its value, and never resolve. So one fix adds the import and replaces
      // every site; the fixes of the sites overlap, and ESLint applies one.
      return (fixer) => [
        importEdit(fixer, timersPromisesImports(sourceCode.ast)),
        ...found.map((site) => fixer.replaceText(site.node, 'setImmediate()')),
      ];
    }

    function planOf(): FixPlan {
      const name = importedImmediate(timersPromisesImports(sourceCode.ast));
      if (name !== undefined) {
        return found.every(({ node }) =>
          readsImport(sourceCode.getScope(node), name),
        )
          ? { kind: 'reuse', name }
          : { kind: 'none' };
      }
      const replaced = new Set<TSESTree.Node>(
        found.map(({ call }) => call.callee),
      );
      // A new import of setImmediate would capture each global call that the
      // fix does not replace.
      const globalStays =
        sourceCode.scopeManager?.globalScope?.through.some(
          ({ identifier }) =>
            identifier.name === 'setImmediate' && !replaced.has(identifier),
        ) ?? true;
      return globalStays ? { kind: 'globalStays' } : { kind: 'import' };
    }

    return {
      NewExpression(node) {
        const call = immediateCallOf(sourceCode, node);
        if (call) found.push({ node, call });
      },
      'Program:exit'() {
        const plan = planOf();
        for (const { node } of found) {
          if (plan.kind === 'globalStays') {
            context.report({ node, messageId: 'immediateTaken' });
          } else {
            context.report({
              node,
              messageId: 'oneTurn',
              fix: fixOf(plan, node),
            });
          }
        }
      },
    };
  },
});

export default eslintRule(rule);

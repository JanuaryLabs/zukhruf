import {
  ASTUtils,
  ESLintUtils,
  type TSESLint,
  type TSESTree,
} from '@typescript-eslint/utils';

import { eslintRule } from '../authoring/rule-module.ts';

const NODE_CRYPTO = new Set(['crypto', 'node:crypto']);

interface CryptoImport {
  readonly variable: TSESLint.Scope.Variable;
  readonly declaration: TSESTree.ImportDeclaration;
  readonly specifier: TSESTree.ImportClause;
}

interface OneShotChain {
  readonly create: TSESTree.CallExpression;
  readonly algorithm: TSESTree.Node;
  readonly data: TSESTree.Node;
  readonly encoding: TSESTree.StringLiteral | undefined;
}

function isStringLiteral(
  node: TSESTree.Node | undefined,
): node is TSESTree.StringLiteral {
  return node?.type === 'Literal' && typeof node.value === 'string';
}

function isNamedImport(
  specifier: TSESTree.ImportClause,
  name: string,
): specifier is TSESTree.ImportSpecifier {
  return (
    specifier.type === 'ImportSpecifier' &&
    specifier.imported.type === 'Identifier' &&
    specifier.imported.name === name
  );
}

function receiverOf(
  call: TSESTree.CallExpression,
  method: string,
): TSESTree.Expression | undefined {
  const { callee } = call;
  return callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    callee.property.name === method
    ? callee.object
    : undefined;
}

/**
 * The chain only when hash() gives the same bytes. `update` with any encoding
 * but UTF-8 reads other bytes than hash() does. `digest` with a value that is
 * not a known literal may be undefined at run time, which gives a Buffer from
 * `digest` and hex from hash().
 */
function oneShotChainOf(digest: TSESTree.CallExpression): OneShotChain | null {
  const update = receiverOf(digest, 'digest');
  if (update?.type !== 'CallExpression') return null;
  const create = receiverOf(update, 'update');
  if (create?.type !== 'CallExpression') return null;

  const [algorithm, options] = create.arguments;
  const [data, inputEncoding] = update.arguments;
  const [encoding] = digest.arguments;
  if (algorithm === undefined || algorithm.type === 'SpreadElement')
    return null;
  if (options !== undefined) return null;
  if (data === undefined || data.type === 'SpreadElement') return null;
  if (
    inputEncoding !== undefined &&
    !(isStringLiteral(inputEncoding) && /^utf-?8$/iu.test(inputEncoding.value))
  ) {
    return null;
  }
  if (encoding === undefined) {
    return { create, algorithm, data, encoding: undefined };
  }
  return isStringLiteral(encoding) && Buffer.isEncoding(encoding.value)
    ? { create, algorithm, data, encoding }
    : null;
}

function cryptoImportOf(
  scope: TSESLint.Scope.Scope,
  name: string,
): CryptoImport | null {
  const variable = ASTUtils.findVariable(scope, name);
  const definition = variable?.defs[0];
  if (
    !variable ||
    definition?.type !== 'ImportBinding' ||
    definition.parent.type !== 'ImportDeclaration' ||
    definition.node.type === 'TSImportEqualsDeclaration' ||
    !NODE_CRYPTO.has(definition.parent.source.value)
  ) {
    return null;
  }
  return {
    variable,
    declaration: definition.parent,
    specifier: definition.node,
  };
}

function hashImportOf(
  program: TSESTree.Program,
): TSESTree.ImportSpecifier | undefined {
  return program.body
    .flatMap((statement) =>
      statement.type === 'ImportDeclaration' &&
      NODE_CRYPTO.has(statement.source.value)
        ? statement.specifiers
        : [],
    )
    .find((specifier) => isNamedImport(specifier, 'hash'));
}

/**
 * A new import of hash is safe when the chain sees no other hash, and no code
 * reads a global hash that the import would capture. A hash in a different
 * function keeps its meaning: that function shadows the import.
 */
function isHashFree(
  sourceCode: Readonly<TSESLint.SourceCode>,
  scope: TSESLint.Scope.Scope,
): boolean {
  return (
    !ASTUtils.findVariable(scope, 'hash') &&
    !sourceCode.scopeManager?.globalScope?.through.some(
      (reference) => reference.identifier.name === 'hash',
    )
  );
}

function callText(
  sourceCode: Readonly<TSESLint.SourceCode>,
  name: string,
  { algorithm, data, encoding }: OneShotChain,
): string {
  const output =
    encoding === undefined
      ? `, 'buffer'`
      : encoding.value === 'hex'
        ? ''
        : `, ${sourceCode.getText(encoding)}`;
  return `${name}(${sourceCode.getText(algorithm)}, ${sourceCode.getText(data)}${output})`;
}

function importEdit(
  fixer: TSESLint.RuleFixer,
  sourceCode: Readonly<TSESLint.SourceCode>,
  { declaration, specifier, variable }: CryptoImport,
  hashImport: TSESTree.ImportSpecifier | undefined,
): TSESLint.RuleFix {
  const lastUse = variable.references.length === 1;
  if (hashImport === undefined) {
    return lastUse
      ? fixer.replaceText(specifier, 'hash')
      : fixer.insertTextAfter(specifier, ', hash');
  }
  // An empty edit: it makes this fix overlap the fix of each other chain, so
  // ESLint applies one fix for each pass. Then the last chain sees that it is
  // the last use, and it removes createHash from the import.
  if (!lastUse) return fixer.insertTextBefore(specifier, '');
  if (declaration.specifiers.length === 1) return fixer.remove(declaration);
  const after = sourceCode.getTokenAfter(specifier);
  if (after?.value === ',') {
    const next = sourceCode.getTokenAfter(after);
    return fixer.removeRange([
      specifier.range[0],
      next?.range[0] ?? after.range[1],
    ]);
  }
  const before = sourceCode.getTokenBefore(specifier);
  return fixer.removeRange([
    before?.range[0] ?? specifier.range[0],
    specifier.range[1],
  ]);
}

const rule = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'suggestion',
    docs: { description: 'Use hash() of node:crypto for a one-shot digest' },
    fixable: 'code',
    schema: [],
    messages: {
      oneShot:
        'A one-shot digest is one call: hash(algorithm, data, encoding) of node:crypto. Keep createHash for several updates or a stream.',
      hashTaken:
        'A one-shot digest is one call: hash(algorithm, data, encoding) of node:crypto. The fix cannot use the name of hash here, because a different hash is in scope. Rename that hash, and the fix applies.',
    },
  },
  create(context) {
    const { sourceCode } = context;

    function reportNamed(
      node: TSESTree.CallExpression,
      chain: OneShotChain,
      name: string,
    ): void {
      const scope = sourceCode.getScope(chain.create);
      const imported = cryptoImportOf(scope, name);
      if (!imported || !isNamedImport(imported.specifier, 'createHash')) return;

      const hashImport = hashImportOf(sourceCode.ast);
      const local = hashImport?.local.name ?? 'hash';
      const available =
        hashImport === undefined
          ? isHashFree(sourceCode, scope)
          : ASTUtils.findVariable(scope, local)?.defs[0]?.node === hashImport;
      if (!available) {
        context.report({ node, messageId: 'hashTaken' });
        return;
      }
      context.report({
        node,
        messageId: 'oneShot',
        fix:
          sourceCode.getCommentsInside(node).length > 0
            ? null
            : (fixer) => [
                importEdit(fixer, sourceCode, imported, hashImport),
                fixer.replaceText(node, callText(sourceCode, local, chain)),
              ],
      });
    }

    function reportMember(
      node: TSESTree.CallExpression,
      chain: OneShotChain,
      callee: TSESTree.MemberExpression,
    ): void {
      if (
        callee.computed ||
        callee.object.type !== 'Identifier' ||
        callee.property.type !== 'Identifier' ||
        callee.property.name !== 'createHash'
      ) {
        return;
      }
      const object = callee.object.name;
      const imported = cryptoImportOf(
        sourceCode.getScope(chain.create),
        object,
      );
      if (!imported) return;
      context.report({
        node,
        messageId: 'oneShot',
        fix:
          sourceCode.getCommentsInside(node).length > 0
            ? null
            : (fixer) =>
                fixer.replaceText(
                  node,
                  callText(sourceCode, `${object}.hash`, chain),
                ),
      });
    }

    return {
      CallExpression(node) {
        const chain = oneShotChainOf(node);
        if (!chain) return;
        const { callee } = chain.create;
        if (callee.type === 'Identifier') {
          reportNamed(node, chain, callee.name);
        } else if (callee.type === 'MemberExpression') {
          reportMember(node, chain, callee);
        }
      },
    };
  },
});

export default eslintRule(rule);

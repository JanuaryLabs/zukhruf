import type { Rule } from 'eslint';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
  resolvedVariable,
} from '../authoring/ast.ts';

const NODE_PROCESS = new Set(['process', 'node:process']);

/** The static key of `object.key`, `object['key']` or `` object[`key`] ``. */
function staticKey(key: unknown, computed: unknown): string | undefined {
  if (computed !== true) return identifierName(key);
  if (isType(key, 'Literal') && typeof key['value'] === 'string') {
    return key['value'];
  }
  if (isType(key, 'TemplateLiteral') && Array.isArray(key['expressions'])) {
    const [quasi] = Array.isArray(key['quasis']) ? key['quasis'] : [];
    const value: unknown = isAstNode(quasi) ? quasi['value'] : undefined;
    return key['expressions'].length === 0 &&
      value !== null &&
      typeof value === 'object' &&
      'cooked' in value &&
      typeof value.cooked === 'string'
      ? value.cooked
      : undefined;
  }
  return undefined;
}

function isMember(node: unknown, key: string): node is AstNode {
  return (
    isType(node, 'MemberExpression') &&
    staticKey(node['property'], node['computed']) === key
  );
}

/**
 * Whether `node` is the environment object: `process.env`,
 * `import.meta.env`, or a variable this file binds to one of them
 * (`const env = process.env`, `const { env } = process`, or `env` imported
 * from `node:process`).
 */
function isEnvObject(
  context: Rule.RuleContext,
  node: unknown,
  seen: Set<unknown> = new Set(),
): boolean {
  if (isMember(node, 'env')) {
    const object = node['object'];
    return (
      identifierName(object) === 'process' ||
      (isType(object, 'MetaProperty') &&
        identifierName(object['meta']) === 'import' &&
        identifierName(object['property']) === 'meta')
    );
  }
  if (!isType(node, 'Identifier') || seen.has(node)) return false;
  seen.add(node);
  const [definition] = resolvedVariable(context, node)?.defs ?? [];
  if (!definition) return false;
  const declaration: unknown = definition.node;
  if (definition.type === 'ImportBinding') {
    const source: unknown = isAstNode(definition.parent)
      ? definition.parent['source']
      : undefined;
    return (
      isType(declaration, 'ImportSpecifier') &&
      // `import { 'env' as e }` names the export with a string literal.
      (identifierName(declaration['imported']) ??
        staticKey(declaration['imported'], true)) === 'env' &&
      isType(source, 'Literal') &&
      typeof source['value'] === 'string' &&
      NODE_PROCESS.has(source['value'])
    );
  }
  if (!isType(declaration, 'VariableDeclarator')) return false;
  const { id, init } = declaration;
  if (isType(id, 'Identifier')) return isEnvObject(context, init, seen);
  // `const { env } = process`: the binding is the `env` property's value.
  return (
    isType(id, 'ObjectPattern') &&
    identifierName(init) === 'process' &&
    Array.isArray(id['properties']) &&
    id['properties'].some(
      (property: unknown) =>
        isType(property, 'Property') &&
        property['value'] === definition.name &&
        staticKey(property['key'], property['computed']) === 'env',
    )
  );
}

/**
 * Whether the member is only set (`=`) or deleted: a write sets NODE_ENV for a
 * tool and decides nothing.
 */
function isWrite(node: AstNode): boolean {
  const parent: unknown = node.parent;
  return (
    (isType(parent, 'AssignmentExpression') &&
      parent['left'] === node &&
      parent['operator'] === '=') ||
    (isType(parent, 'UnaryExpression') && parent['operator'] === 'delete')
  );
}

/**
 * NODE_ENV is `production` on a laptop, in CI and in production, so a branch on
 * it takes the same path everywhere, and the behaviour it was meant to switch
 * never switches. A setting that differs between setups is its own variable.
 * Tools still read NODE_ENV and targets still set it for them, so the rule
 * reports reads in code only: a write (`process.env.NODE_ENV = …`), a
 * `delete`, a key of an env object handed to a child process, and NODE_ENV
 * inside a string, a template's text or a comment pass.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow reading NODE_ENV' },
    schema: [],
    messages: {
      nodeEnv:
        "NODE_ENV is production everywhere and decides nothing. Read an explicit setting instead, such as ALLOWED_ORIGINS, LOG_LEVEL or the feature's own variable.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (
          isMember(node, 'NODE_ENV') &&
          isEnvObject(context, node.object) &&
          !isWrite(node)
        ) {
          context.report({ node, messageId: 'nodeEnv' });
        }
      },
      ObjectPattern(node) {
        const { parent } = node;
        let source: unknown;
        if (parent.type === 'VariableDeclarator' && parent.id === node) {
          source = parent.init;
        } else if (
          parent.type === 'AssignmentExpression' &&
          parent.left === node
        ) {
          source = parent.right;
        }
        if (!source || !isEnvObject(context, source)) return;
        for (const property of node.properties) {
          if (
            property.type === 'Property' &&
            staticKey(property.key, property.computed) === 'NODE_ENV'
          ) {
            context.report({ node: property, messageId: 'nodeEnv' });
          }
        }
      },
    };
  },
};

export default rule;

import type { Rule } from 'eslint';

import {
  type AstNode,
  identifierName,
  isType,
  stringsAt,
} from '../authoring/ast.ts';

/**
 * A server that sets `ignoreChanges` is one whose replacement someone already
 * feared: it keeps state on its local disk. `protect: true` makes a routine
 * `pulumi up` that plans a replacement fail instead of destroying that state.
 * `resources` lists the `module.Class` names the rule checks.
 */

function memberName(callee: unknown): string | undefined {
  if (!isType(callee, 'MemberExpression')) {
    return undefined;
  }
  const object = callee['object'];
  const property = callee['property'];
  if (
    isType(object, 'Identifier') &&
    isType(property, 'Identifier') &&
    callee['computed'] !== true
  ) {
    const objectName = identifierName(object);
    const propertyName = identifierName(property);
    return objectName && propertyName
      ? `${objectName}.${propertyName}`
      : undefined;
  }
  return undefined;
}

function findProperty(
  objectExpression: AstNode,
  key: string,
): AstNode | undefined {
  const properties = objectExpression['properties'];
  if (!Array.isArray(properties)) {
    return undefined;
  }
  for (const property of properties) {
    if (
      isType(property, 'Property') &&
      identifierName(property['key']) === key
    ) {
      return property;
    }
  }
  return undefined;
}

function hasSpreadElement(objectExpression: AstNode): boolean {
  const properties = objectExpression['properties'];
  return (
    Array.isArray(properties) &&
    properties.some((property) => isType(property, 'SpreadElement'))
  );
}

function isExplicitlyDisabled(node: unknown): boolean {
  if (isType(node, 'Literal')) {
    return !node['value'];
  }
  return identifierName(node) === 'undefined';
}

function unwrapToObjectExpression(node: unknown): AstNode | undefined {
  let current = node;
  while (
    isType(current, 'TSAsExpression') ||
    isType(current, 'TSSatisfiesExpression') ||
    isType(current, 'TSNonNullExpression')
  ) {
    current = current['expression'];
  }
  return isType(current, 'ObjectExpression') ? current : undefined;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'require a replace guard (protect: true) on stateful Pulumi server resources that declare ignoreChanges',
    },
    messages: {
      missingProtect:
        'A {{resource}} that sets `ignoreChanges` is replace-sensitive (it holds state on local disk). Add `protect: true` to its resource options so a routine `pulumi up` hard-fails instead of silently replacing — and destroying — it. Remove protect deliberately to rebuild.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          resources: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    ],
    defaultOptions: [{ resources: ['hcloud.Server'] }],
  },
  create(context) {
    const resources = stringsAt(context.options[0], 'resources');

    return {
      NewExpression(node: Rule.Node) {
        if (!isType(node, 'NewExpression')) {
          return;
        }
        const resourceName = memberName(node['callee']);
        if (!resourceName || !resources.includes(resourceName)) {
          return;
        }

        const args = node['arguments'];
        if (!Array.isArray(args) || args.length < 3) {
          return;
        }

        const options = unwrapToObjectExpression(args[2]);
        if (!options) {
          return;
        }

        if (!findProperty(options, 'ignoreChanges')) {
          return;
        }

        if (hasSpreadElement(options)) {
          return;
        }

        const protect = findProperty(options, 'protect');
        if (protect && !isExplicitlyDisabled(protect['value'])) {
          return;
        }

        context.report({
          node: protect ?? options,
          messageId: 'missingProtect',
          data: { resource: resourceName },
        });
      },
    };
  },
};

export default rule;

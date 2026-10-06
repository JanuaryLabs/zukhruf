import type { Rule } from 'eslint';

import {
  type AstNode,
  identifierName,
  isType,
  stringsAt,
} from '../authoring/ast.ts';

const BANNED_METHODS = [
  'default',
  'optional',
  'transform',
  'catch',
  'nullable',
];
const SCHEMA_VARIABLE = 'env';

// Resolve the object literal of the startup schema, i.e. the `{...}` in
// `const env = z.object({...})`. Keyed on the `.object(...)` call shape rather
// than the `z` identifier, so an aliased zod import still resolves.
function schemaObjectLiteral(init: unknown): AstNode | undefined {
  if (!isType(init, 'CallExpression')) {
    return undefined;
  }
  const callee = init['callee'];
  if (
    !isType(callee, 'MemberExpression') ||
    identifierName(callee['property']) !== 'object'
  ) {
    return undefined;
  }
  const args = init['arguments'];
  const schema: unknown = Array.isArray(args) ? args[0] : undefined;
  return isType(schema, 'ObjectExpression') ? schema : undefined;
}

function propertyKeyName(property: AstNode): string | undefined {
  if (property['computed'] === true) {
    return undefined;
  }
  const key = property['key'];
  const name = identifierName(key);
  if (name !== undefined) {
    return name;
  }
  if (isType(key, 'Literal') && typeof key['value'] === 'string') {
    return key['value'];
  }
  return undefined;
}

function bannedMethodInChain(value: unknown): string | undefined {
  let current = value;
  while (isType(current, 'CallExpression')) {
    const callee = current['callee'];
    if (
      isType(callee, 'MemberExpression') &&
      BANNED_METHODS.includes(identifierName(callee['property']) ?? '')
    ) {
      return identifierName(callee['property']);
    }
    current = isType(callee, 'MemberExpression') ? callee['object'] : undefined;
  }
  return undefined;
}

/**
 * A deployment path (a data directory, a socket) is backed by a volume mount
 * the deployment declares. A code default lets the two drift apart silently:
 * the app writes to a path nothing mounts. Each key listed in `pathEnvKeys`
 * must therefore be a required `z.string()` in the startup schema.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow code defaults/optional/transform on deployment-path env vars in the startup zod schema — the deployment owns the path',
    },
    messages: {
      noDefault:
        'Env var "{{key}}" is a deployment path — it must be a required `z.string()` with no `.{{method}}()`. A code default lets the path drift from the volume mount that backs it; the deployment must own and set it explicitly.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          pathEnvKeys: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    ],
    defaultOptions: [{ pathEnvKeys: [] }],
  },
  create(context) {
    const pathEnvKeys = new Set(stringsAt(context.options[0], 'pathEnvKeys'));
    if (pathEnvKeys.size === 0) {
      return {};
    }

    return {
      VariableDeclarator(node) {
        if (!isType(node, 'VariableDeclarator')) {
          return;
        }
        if (identifierName(node['id']) !== SCHEMA_VARIABLE) {
          return;
        }
        const schema = schemaObjectLiteral(node['init']);
        if (!schema) {
          return;
        }
        const properties = schema['properties'];
        if (!Array.isArray(properties)) {
          return;
        }
        for (const property of properties) {
          if (!isType(property, 'Property')) {
            continue;
          }
          const key = propertyKeyName(property);
          if (!key || !pathEnvKeys.has(key)) {
            continue;
          }
          const method = bannedMethodInChain(property['value']);
          if (method) {
            context.report({
              node: property,
              messageId: 'noDefault',
              data: { key, method },
            });
          }
        }
      },
    };
  },
};

export default rule;

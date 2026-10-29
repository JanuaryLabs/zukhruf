import type { Rule } from 'eslint';

import { type AstNode, isType } from '../authoring/ast.ts';

/** The npm registry stores at most this many characters of a description. */
const LIMIT = 255;

/**
 * The value of the manifest's top-level `name` field. npm reads package.json
 * with `JSON.parse`, so every key is a quoted string.
 */
function fieldValue(manifest: AstNode, name: string): unknown {
  const properties = manifest['properties'];
  const property: unknown = Array.isArray(properties)
    ? properties.find(
        (entry: unknown) =>
          isType(entry, 'JSONProperty') &&
          isType(entry['key'], 'JSONLiteral') &&
          entry['key']['value'] === name,
      )
    : undefined;
  return isType(property, 'JSONProperty') ? property['value'] : undefined;
}

/**
 * The npm registry cuts a package's `description` to 255 characters, so the
 * rest never shows in `npm view` or in a search. npm does not publish a
 * manifest with `"private": true`, so the rule does not check it.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a description that the npm registry cuts, in a package.json that npm can publish',
    },
    schema: [],
    messages: {
      truncated:
        'The description has {{length}} characters. The npm registry stores at most {{limit}}, so it cuts the rest. Keep the key fact here and move the detail to the README.',
    },
  },
  create(context) {
    return {
      'JSONExpressionStatement > JSONObjectExpression'(manifest: Rule.Node) {
        if (!isType(manifest, 'JSONObjectExpression')) return;
        const isPrivate = fieldValue(manifest, 'private');
        if (isType(isPrivate, 'JSONLiteral') && isPrivate['value'] === true) {
          return;
        }
        const description = fieldValue(manifest, 'description');
        if (!isType(description, 'JSONLiteral')) return;
        const text = description['value'];
        if (typeof text !== 'string' || text.length <= LIMIT) return;
        context.report({
          node: description,
          messageId: 'truncated',
          data: { length: String(text.length), limit: String(LIMIT) },
        });
      },
    };
  },
};

export default rule;

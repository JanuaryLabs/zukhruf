import type { Rule } from 'eslint';

import { identifierName, isType, resolvedVariable } from '../authoring/ast.ts';
import { isRecord } from '../unknown-values.ts';

/** Whether `node` names the JSDOM class that the `jsdom` package exports. */
function isJsdomClass(context: Rule.RuleContext, node: unknown): boolean {
  if (!isType(node, 'Identifier')) return false;
  return (
    resolvedVariable(context, node)?.defs.some(
      (def) =>
        def.type === 'ImportBinding' &&
        isType(def.node, 'ImportSpecifier') &&
        identifierName(def.node['imported']) === 'JSDOM' &&
        isType(def.parent, 'ImportDeclaration') &&
        isRecord(def.parent['source']) &&
        def.parent['source']['value'] === 'jsdom',
    ) ?? false
  );
}

/** Whether `options` is an object literal that sets `virtualConsole`. */
function setsVirtualConsole(options: unknown): boolean {
  if (!isType(options, 'ObjectExpression')) return false;
  const properties = options['properties'];
  return (
    Array.isArray(properties) &&
    properties.some(
      (property) =>
        isType(property, 'Property') &&
        property['computed'] === false &&
        isRecord(property['key']) &&
        property['key']['name'] === 'virtualConsole',
    )
  );
}

/**
 * jsdom's default virtual console forwards a page's errors, such as a
 * stylesheet it cannot parse, to the host's console.error: an indirect console
 * write that no-console cannot see. Library code gives each JSDOM its own
 * VirtualConsole in the options literal, where this rule can see it.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a JSDOM in library code to have its own virtual console',
    },
    schema: [],
    messages: {
      virtualConsole:
        "Pass virtualConsole: new VirtualConsole() in the options literal, so jsdom does not write a page's errors to the host's console.",
    },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (!isJsdomClass(context, node.callee)) return;
        if (setsVirtualConsole(node.arguments[1])) return;
        context.report({ node, messageId: 'virtualConsole' });
      },
    };
  },
};

export default rule;

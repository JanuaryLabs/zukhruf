import type { Rule } from 'eslint';

import { isType } from './ast.ts';

export interface ImportBan {
  readonly description: string;
  readonly message: string;
  /** Package names; each also bans its subpaths (`name/…`). */
  readonly packages: readonly string[];
}

/**
 * A ban that used to be one pattern group of `no-restricted-imports`, as a rule
 * of its own, so a repo's own import bans cannot replace it. Covers static
 * imports, re-exports and literal dynamic imports, type-only ones included.
 */
export function importBanRule({
  description,
  message,
  packages,
}: ImportBan): Rule.RuleModule {
  const isBanned = (source: unknown) =>
    typeof source === 'string' &&
    packages.some((name) => source === name || source.startsWith(`${name}/`));

  return {
    meta: {
      type: 'problem',
      docs: { description },
      schema: [],
      messages: { banned: message },
    },
    create(context) {
      const check = (node: Rule.Node, source: unknown) => {
        if (isType(source, 'Literal') && isBanned(source['value'])) {
          context.report({ node, messageId: 'banned' });
        }
      };
      return {
        ImportDeclaration: (node) => check(node, node.source),
        ExportNamedDeclaration: (node) => check(node, node.source),
        ExportAllDeclaration: (node) => check(node, node.source),
        ImportExpression: (node) => check(node, node.source),
      };
    },
  };
}

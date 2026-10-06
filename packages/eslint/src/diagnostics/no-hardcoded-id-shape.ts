import type { Rule } from 'eslint';

import { identifierName, isType } from '../authoring/ast.ts';

/**
 * Entity ids are a schema decision, not a text format. One table declares
 * `id String @id @default(cuid())`, another takes its ids from `randomUUID()`.
 * A regex that hardcodes one of those shapes keeps compiling, keeps passing a
 * test whose fixture uses the matching shape, and silently stops matching the
 * moment the shape changes. A parser that matched a UUID shape against a cuid
 * column never matched in production, while its test stayed green on a UUID
 * fixture.
 *
 * Anchor on the surrounding literal text instead: `/created\s+(\S+)/` cares
 * about the sentence the program prints, which is a contract you own, rather
 * than the id format, which the schema owns.
 */

/** `[0-9a-f]{8}-[0-9a-f]{4}` and its case/shorthand variants. */
const UUID_SHAPE = /\[[^\]]{2,}\]\{8\}-\[[^\]]{2,}\]\{4\}/;

/** `c[a-z0-9]{24}`, `[a-z0-9]{25}`, `[a-z0-9]{20,32}`: cuid/cuid2 lengths. */
const CUID_SHAPE = /\[a-z0-9\]\{2\d(?:,\d*)?\}/i;

function idShapeOf(pattern: string): 'uuid' | 'cuid' | undefined {
  if (UUID_SHAPE.test(pattern)) return 'uuid';
  if (CUID_SHAPE.test(pattern)) return 'cuid';
  return undefined;
}

/** `/…/` literals carry `regex`; string and bigint literals do not. */
function regexPatternOf(node: Rule.Node): string | undefined {
  return 'regex' in node ? node.regex.pattern : undefined;
}

/** The string a `new RegExp('…')` / `RegExp('…')` compiles, when it is literal. */
function regExpSourceArgument(node: {
  readonly callee: unknown;
  readonly arguments: readonly unknown[];
}): string | undefined {
  if (identifierName(node.callee) !== 'RegExp') return undefined;
  const [first] = node.arguments;
  return isType(first, 'Literal') && typeof first['value'] === 'string'
    ? first['value']
    : undefined;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow regexes that hardcode an entity-id shape (uuid/cuid); anchor on surrounding text instead.',
    },
    schema: [],
    messages: {
      idShape:
        'This regex hardcodes a {{shape}} id shape. Ids are a schema decision (`@default(cuid())` / `randomUUID()`), so a shape change silently stops the match. Anchor on the surrounding literal text (e.g. /created\\s+(\\S+)/) instead.',
    },
  },
  create(context) {
    function report(node: Rule.Node, pattern: string | undefined) {
      if (pattern === undefined) return;
      const shape = idShapeOf(pattern);
      if (shape) {
        context.report({ node, messageId: 'idShape', data: { shape } });
      }
    }

    return {
      Literal(node) {
        report(node, regexPatternOf(node));
      },
      CallExpression(node) {
        report(node, regExpSourceArgument(node));
      },
      NewExpression(node) {
        report(node, regExpSourceArgument(node));
      },
    };
  },
};

export default rule;

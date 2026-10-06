import type { Rule } from 'eslint';

import {
  type AstNode,
  identifierName,
  isAstNode,
  isType,
} from '../authoring/ast.ts';

/**
 * Log event names are a query surface, not free text. A codebase that runs two
 * conventions at once, dotted-lowercase in one service and snake_case in
 * another, gives the same failure two names (`chat.run.failed` and
 * `chat_run_failed`), and an alert or dashboard written against one name is
 * blind to the other.
 *
 * Dotted-lowercase wins because it is hierarchical: `dashboard.*` and
 * `*.failed` are prefix filters, and it matches OpenTelemetry's dotted
 * attribute keys.
 *
 * Segments allow internal hyphens (`data-source.staged-file.cleanup.failed`,
 * `auto-update.staged`) because some domains are genuinely two words.
 */

const EVENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

/** `event` written bare or quoted. */
function isEventKey(node: unknown): boolean {
  if (identifierName(node) === 'event') return true;
  return isType(node, 'Literal') && node['value'] === 'event';
}

function literalString(node: unknown): string | undefined {
  if (!isType(node, 'Literal')) return undefined;
  const value = node['value'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Both arms of `cond ? 'a' : 'b'`, so a ternary event name is still checked.
 *
 * Takes `unknown` like the helpers in ast.ts: an ESTree `Expression` has no
 * `parent`, so it is not assignable to `Rule.Node`. For the same reason a
 * ternary's branches cannot be passed to `context.report`, and the report is
 * anchored on the property instead.
 */
function candidateValues(node: unknown): AstNode[] {
  if (isType(node, 'ConditionalExpression')) {
    const consequent = node['consequent'];
    const alternate = node['alternate'];
    return [consequent, alternate].filter((v): v is AstNode => isAstNode(v));
  }
  return isAstNode(node) ? [node] : [];
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require log event names to be dotted-lowercase, so one failure has one name everywhere it is logged.',
    },
    schema: [],
    messages: {
      badName:
        "Log event '{{name}}' is not dotted-lowercase. Event names are a query surface: two naming conventions give the same failure two names, and an alert written against one misses the other. Join lowercase segments with '.', e.g. 'dashboard.index.read.failed'.",
    },
  },
  create(context) {
    return {
      Property(node) {
        if (!isEventKey(node.key)) return;
        for (const candidate of candidateValues(node.value)) {
          const name = literalString(candidate);
          if (name === undefined || EVENT_NAME.test(name)) continue;
          context.report({ node, messageId: 'badName', data: { name } });
        }
      },
    };
  },
};

export default rule;

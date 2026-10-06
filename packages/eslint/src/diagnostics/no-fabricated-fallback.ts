import type { Rule } from 'eslint';

import { type AstNode, isRecord, isType, stringsAt } from '../authoring/ast.ts';
import { inRoots, isTestFile } from '../authoring/path-scope.ts';

/**
 * A fallback that invents prose is not a default; it is a claim the code
 * cannot support. `detail ?? 'No diagnostic detail was available.'` reads,
 * downstream, as "we looked and there was nothing", when what actually happened
 * is that a field arrived undefined and nobody asked why. The placeholder is
 * indistinguishable from a real answer, so the bug it hides becomes invisible
 * in exactly the surface built for diagnosing bugs.
 *
 * The shapes this catches pass review easily: `?? 'No diagnostic detail was
 * available.'` on a log field, a `fallback = 'Unknown error'` parameter, and
 * ``error.message || `Request failed ${status}` `` written without checking
 * whether `message` can be empty at all. Each reads as harmless until someone
 * reads it aloud.
 *
 * The rule is deliberately narrow: it fires only on text containing whitespace,
 * because that is what separates a sentence a reader will believe from a machine
 * value. Single tokens (`'production'`, `'utf8'`), identifier-shaped templates
 * (`` `session:${id}` ``) and the empty string are left alone. That last
 * exclusion is measured, not assumed: flagging `''` on a real backend produced
 * dozens of hits and nearly all were boundary coercion (`message.text || ''`
 * before `.trim()`, `match[1] ?? ''`, `sql[i] ?? ''` past the end), which is the
 * identity element for a string operation rather than an invented answer.
 * Narrow beats complete here: a rule that cries wolf gets disabled.
 */

function stringLiteralValue(node: unknown): string | undefined {
  return isType(node, 'Literal') && typeof node['value'] === 'string'
    ? node['value']
    : undefined;
}

/** The literal parts of a template, ignoring whatever `${}` interpolates. */
function templateText(node: AstNode): string | undefined {
  const quasis = node['quasis'];
  if (!Array.isArray(quasis)) return undefined;

  return quasis
    .map((element) => {
      if (!isRecord(element)) return '';
      const value = element['value'];
      if (!isRecord(value)) return '';
      const cooked = value['cooked'];
      return typeof cooked === 'string' ? cooked : '';
    })
    .join('');
}

/**
 * Prose is text a reader would mistake for a real answer, and whitespace is
 * what separates it from a machine value. `'Key validation failed'` is a
 * sentence someone will read as a finding; `''`, `'utf8'` and `` `session:${id}` ``
 * are normalization and identifiers. The empty string in particular is just
 * the identity for a string operation, and flagging it drowns this rule in
 * boundary coercions (`message.text || ''` before `.trim()`).
 */
function isProse(text: string, allowed: readonly string[]): boolean {
  if (allowed.includes(text)) return false;
  return /\s/.test(text);
}

function isFabricatedProse(node: unknown, allowed: readonly string[]): boolean {
  const literal = stringLiteralValue(node);
  if (literal !== undefined) return isProse(literal, allowed);

  if (!isType(node, 'TemplateLiteral')) return false;

  const text = templateText(node);
  return text === undefined ? false : isProse(text, allowed);
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid fallbacks that fabricate prose (a sentence, or a template whose literal text has whitespace) for a value the code failed to obtain.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allow: { type: 'array', items: { type: 'string' } },
          roots: { type: 'array', items: { type: 'string' } },
        },
      },
    ],
    defaultOptions: [{ allow: [], roots: [] }],
    messages: {
      fabricatedFallback:
        'This fallback invents text for a value you did not obtain, and downstream cannot tell it from a real one. Cite the line in the producing code where the value can legitimately be absent — if you cannot, the absence is a bug to trace, not a string to paper over. If it genuinely can be absent, let it be absent (omit the key, narrow the type) instead of filling it in.',
    },
  },
  create(context) {
    const filename = context.physicalFilename;
    const roots = stringsAt(context.options[0], 'roots');
    if (isTestFile(filename) || !inRoots(filename, roots)) return {};

    const allowed = stringsAt(context.options[0], 'allow');

    function check(right: unknown, node: Rule.Node): void {
      if (isFabricatedProse(right, allowed)) {
        context.report({ node, messageId: 'fabricatedFallback' });
      }
    }

    return {
      LogicalExpression(node) {
        if (node.operator !== '??' && node.operator !== '||') return;
        check(node.right, node);
      },
      AssignmentPattern(node) {
        check(node.right, node);
      },
    };
  },
};

export default rule;

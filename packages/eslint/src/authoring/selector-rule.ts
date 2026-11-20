import type { Rule } from 'eslint';

export interface SelectorCheck {
  readonly description: string;
  readonly message: string;
  /** esquery selectors; a node that matches any of them is reported. */
  readonly selectors: readonly string[];
}

/**
 * ESLint reads `{{ name }}` in a message as a placeholder and has no escape
 * for it. Each `{{` becomes the placeholder `{{open}}`, which the report fills
 * with `{{`, so a JSX object literal such as `items={{ mg: 'Milligram' }}`
 * reads as written and RuleTester sees no unfilled placeholder.
 */
const open = { open: '{{' };

/**
 * A check that used to be one entry of `no-restricted-syntax`, as a rule of its
 * own. Flat config keeps one options array per rule key, so the next config to
 * set `no-restricted-syntax` (a framework preset, a project override) replaced
 * every entry at once. Under its own key, a check can only be turned off by
 * name. esquery's substring operator `*=` never matches a Literal's `value`;
 * write regex selectors (`[value=/…/]`) instead. `message` is plain text: a
 * `{{ … }}` in it is not a placeholder.
 */
export function selectorRule({
  description,
  message,
  selectors,
}: SelectorCheck): Rule.RuleModule {
  return {
    meta: {
      type: 'problem',
      docs: { description },
      schema: [],
      messages: { matched: message.replaceAll('{{', '{{open}}') },
    },
    create(context) {
      const report = (node: Rule.Node) =>
        context.report({ node, messageId: 'matched', data: open });
      return Object.fromEntries(
        selectors.map((selector) => [selector, report]),
      );
    },
  };
}

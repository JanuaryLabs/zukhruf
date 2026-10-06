import type { Rule } from 'eslint';

import { selectorRule } from '../authoring/selector-rule.ts';

/**
 * A Tailwind class written in a string or a template literal. Both selector
 * forms use a regex: esquery's `*=` never matches a Literal's `value`.
 */
export function classNameCheck({
  description,
  pattern,
  message,
}: {
  description: string;
  /** esquery regex body, e.g. `h-screen` or `z-\\[`. */
  pattern: string;
  message: string;
}): Rule.RuleModule {
  return selectorRule({
    description,
    message,
    selectors: [
      `Literal[value=/${pattern}/]`,
      `TemplateLiteral TemplateElement[value.raw=/${pattern}/]`,
    ],
  });
}

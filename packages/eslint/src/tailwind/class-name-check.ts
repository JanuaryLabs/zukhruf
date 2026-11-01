import type { Rule } from 'eslint';

import { selectorRule } from '../authoring/selector-rule.ts';

/**
 * A Tailwind class written in a string or a template literal. The utility
 * must start a class: at the start of the string, after a space, or after a
 * variant's `:`, with an optional `!`. So `md:h-screen` matches, and a module
 * name such as `expo-splash-screen` does not. Both selector forms use a regex:
 * esquery's `*=` never matches a Literal's `value`.
 */
export function classNameCheck({
  description,
  utility,
  message,
}: {
  description: string;
  /** esquery regex body of the utility with no variant, e.g. `h-screen`. */
  utility: string;
  message: string;
}): Rule.RuleModule {
  const pattern = `(^|[\\s:])!?${utility}`;
  return selectorRule({
    description,
    message,
    selectors: [
      `Literal[value=/${pattern}/]`,
      `TemplateLiteral TemplateElement[value.raw=/${pattern}/]`,
    ],
  });
}

import type { Rule } from 'eslint';

/**
 * `rule`, active only on the files `applies` accepts. Scoping by the linted
 * file, rather than by a config's `files` glob, follows project tags and works
 * whichever folder ESLint runs from.
 */
export function scopedRule(
  rule: Rule.RuleModule,
  applies: (context: Rule.RuleContext) => boolean,
): Rule.RuleModule {
  return {
    ...rule,
    create: (context) => (applies(context) ? rule.create(context) : {}),
  };
}

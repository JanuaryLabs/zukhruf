import type { Rule } from 'eslint';

import { isRecord } from './ast.ts';

/**
 * typescript-eslint and Nx type their rules with their own RuleModule types,
 * which ESLint's `Rule.RuleModule` does not accept. Checking the one member
 * ESLint calls lets this package reuse those rules without a type assertion.
 */
export function isRuleModule(value: unknown): value is Rule.RuleModule {
  return isRecord(value) && typeof value['create'] === 'function';
}

/**
 * The rule `name` of an ESLint plugin; throws when the plugin no longer has it.
 * Takes the plugin as `unknown`: typescript-eslint types its plugin without the
 * `rules` it has at runtime.
 */
export function ruleOf(plugin: unknown, name: string): Rule.RuleModule {
  const rules = isRecord(plugin) ? plugin['rules'] : undefined;
  const rule = isRecord(rules) ? rules[name] : undefined;
  if (!isRuleModule(rule)) {
    throw new Error(`The plugin has no rule named "${name}".`);
  }
  return rule;
}

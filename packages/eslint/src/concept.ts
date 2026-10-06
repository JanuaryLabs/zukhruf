import type { ESLint, Linter, Rule } from 'eslint';

/**
 * One concern the package lints (React Router links, Tailwind classes, …): its
 * rules and the config that turns them on. A consumer picks concerns by config
 * name (`extends: ['zukhruf/react-router']`).
 */
export interface Concept {
  /** The config's name; consumers extend `zukhruf/<name>`. */
  readonly name: string;
  readonly rules: Readonly<Record<string, Rule.RuleModule>>;
  /** Builds the config; `plugins` registers this package's plugin. */
  config(plugins: Readonly<Record<string, ESLint.Plugin>>): Linter.Config[];
}

/** `severity` for every rule of `rules`, under the plugin's `zukhruf/` prefix. */
export function enable(
  rules: Readonly<Record<string, Rule.RuleModule>>,
  severity: Linter.RuleSeverity = 'error',
): Linter.RulesRecord {
  return Object.fromEntries(
    Object.keys(rules).map((name) => [`zukhruf/${name}`, severity]),
  );
}

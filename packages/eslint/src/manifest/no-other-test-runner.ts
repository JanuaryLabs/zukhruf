import type { Rule } from 'eslint';

import { isType } from '../authoring/ast.ts';
import { objectProperties } from '../authoring/json-ast.ts';
import { OTHER_TEST_RUNNERS } from '../imports/no-other-test-runner.ts';

/** Every section of a manifest that names a package. */
const SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/**
 * The runners that `zukhruf/no-other-test-runner` bans as imports, the
 * DefinitelyTyped package of each unscoped one, which gives a typed repo the
 * globals, and `jest-expo`, the Jest preset of Expo.
 */
const BANNED = new Set<string>([
  ...OTHER_TEST_RUNNERS,
  ...OTHER_TEST_RUNNERS.filter((name) => !name.startsWith('@')).map(
    (name) => `@types/${name}`,
  ),
  'jest-expo',
]);

/**
 * A Jest or Mocha test calls the globals `describe`, `it` and `expect` with no
 * import, so `zukhruf/no-other-test-runner`, an import ban, sees only an
 * explicit import. The runner, or the types of its globals, is still installed
 * by a manifest, so the rule reports it there.
 */
const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow test runners other than node:test and Vitest, and the types of their globals, in a package.json',
    },
    schema: [],
    messages: {
      banned:
        '{{section}} lists {{name}}, a test runner other than node:test and Vitest, or the types of its globals. Its tests call globals with no import, so zukhruf/no-other-test-runner cannot see them. Use node:test, or Vitest in a Vite app.',
    },
  },
  create(context) {
    return {
      'JSONExpressionStatement > JSONObjectExpression'(manifest: Rule.Node) {
        if (!isType(manifest, 'JSONObjectExpression')) return;
        const sections = new Map(objectProperties(manifest));
        for (const section of SECTIONS) {
          for (const [name, property] of objectProperties(
            sections.get(section)?.['value'],
          )) {
            if (!BANNED.has(name)) continue;
            context.report({
              node: property,
              messageId: 'banned',
              data: { section, name },
            });
          }
        }
      },
    };
  },
};

export default rule;

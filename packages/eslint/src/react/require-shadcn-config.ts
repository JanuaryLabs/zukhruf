import type { Linter, Rule } from 'eslint';

import { isRecord } from '../unknown-values.ts';

/**
 * The setting that the `shadcn` config writes for every file it covers. The
 * config sets it, not the repo: a repo that writes it by hand silences the
 * guard and still gets none of the kit's rules.
 */
export const SHADCN_SETTINGS = {
  zukhruf: { shadcn: true },
} satisfies Linter.Config['settings'];

function hasShadcnConfig(settings: unknown): boolean {
  const zukhruf = isRecord(settings) ? settings['zukhruf'] : undefined;
  return isRecord(zukhruf) && zukhruf['shadcn'] === true;
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require the zukhruf/shadcn config in a file that imports @zukhruf/shadcn, so the kit rules run where the kit is used',
    },
    schema: [],
    messages: {
      missing:
        "This file imports `@zukhruf/shadcn`, but its ESLint config does not include the `zukhruf/shadcn` config, so the kit rules (`zukhruf/no-as-child`, `zukhruf/no-native-control`, `zukhruf/require-select-group`, …) do not run here. Add `...zukhruf.configs['shadcn']` or `extends: ['zukhruf/shadcn']` for these files. `@zukhruf/eslint/react`, the React community configs, does not include it.",
    },
  },
  create(context) {
    if (hasShadcnConfig(context.settings)) return {};
    return {
      "ImportDeclaration[source.value='@zukhruf/shadcn']"(node: Rule.Node) {
        context.report({ node, messageId: 'missing' });
      },
    };
  },
};

export default rule;

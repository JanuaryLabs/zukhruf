import nx from '@nx/eslint-plugin';
import type { ESLint, Linter } from 'eslint';
import * as jsonc from 'jsonc-eslint-parser';
import tseslint from 'typescript-eslint';

import { ruleOf } from '../authoring/rule-module.ts';
import { scopedRule } from '../authoring/scoped-rule.ts';
import {
  CONFIG_FILES,
  PACKAGE_JSON,
  SCRIPTS,
  TESTS,
  TYPESCRIPT,
} from '../files.ts';
import { dependencyPolicy } from '../nx-policy/dependency-policy.ts';
import { inIsland, inLibrary } from './island-scope.ts';
import noConsole from './no-console.ts';
import noGenericPort from './no-generic-port.ts';
import noProcessEnv from './no-process-env.ts';

// Each check has its own `island/*` key, so a repo's own no-explicit-any,
// no-console or dependency-checks settings never replace it. typescript-eslint's
// and Nx's rules are reused through their plugins' public `rules` maps.
const rules = {
  'no-generic-port': scopedRule(noGenericPort, inIsland),
  'no-explicit-any': scopedRule(
    ruleOf(tseslint.plugin, 'no-explicit-any'),
    inIsland,
  ),
  'dependency-checks': scopedRule(ruleOf(nx, 'dependency-checks'), inIsland),
  'no-process-env': scopedRule(noProcessEnv, inLibrary),
  'no-console': scopedRule(noConsole, inLibrary),
};

const configs: Record<string, Linter.Config[]> = {};

/**
 * Islands: Nx projects tagged `layer:island`, written as if published to npm.
 * An island depends only on other islands, never on a host's runtime; a port it
 * declares returns `unknown` rather than a generic; its package.json declares
 * every package its shipped code imports. Library code (every island, plus the
 * globs in `settings.island.libraries`) never reads process.env or writes to
 * console: the host reads its environment and passes values in.
 */
const plugin = {
  meta: { name: '@zukhruf/eslint/nx', namespace: 'island' },
  rules,
  configs,
} satisfies ESLint.Plugin;

const plugins = { island: plugin };

configs['recommended'] = [
  {
    name: 'island/recommended/ports',
    files: TYPESCRIPT,
    ignores: TESTS,
    plugins,
    rules: {
      'island/no-generic-port': 'error',
      'island/no-explicit-any': 'error',
    },
  },
  {
    name: 'island/recommended/library',
    files: TYPESCRIPT,
    ignores: [...TESTS, ...SCRIPTS, ...CONFIG_FILES],
    plugins,
    rules: {
      'island/no-process-env': 'error',
      'island/no-console': 'error',
    },
  },
  {
    name: 'island/recommended/dependencies',
    files: PACKAGE_JSON,
    languageOptions: { parser: jsonc },
    plugins,
    rules: { 'island/dependency-checks': ['error', dependencyPolicy()] },
  },
];

export default plugin;

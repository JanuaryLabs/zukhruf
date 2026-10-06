import type { ESLint, Linter } from 'eslint';
import * as jsonc from 'jsonc-eslint-parser';

import { PACKAGE_JSON } from '../files.ts';
import dependencyChecks from './dependency-checks.ts';

const configs: Record<string, Linter.Config[]> = {};

/**
 * Manifests: every project's package.json declares the npm packages its
 * shipped code needs. How many depends on the project's shape: a bundled app
 * declares the whole closure its workspace imports pull in, an unbundled
 * project only its own imports. Islands are checked by
 * `island/dependency-checks`.
 */
const plugin = {
  meta: { name: '@zukhruf/eslint/nx/manifest', namespace: 'manifest' },
  rules: { 'dependency-checks': dependencyChecks },
  configs,
} satisfies ESLint.Plugin;

configs['recommended'] = [
  {
    name: 'manifest/recommended',
    files: PACKAGE_JSON,
    languageOptions: { parser: jsonc },
    plugins: { manifest: plugin },
    rules: { 'manifest/dependency-checks': 'error' },
  },
];

export default plugin;

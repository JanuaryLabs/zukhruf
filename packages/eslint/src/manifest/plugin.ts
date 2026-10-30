import type { ESLint, Linter } from 'eslint';
import * as jsonc from 'jsonc-eslint-parser';

import { PACKAGE_JSON } from '../files.ts';
import dependencyChecks from './dependency-checks.ts';
import noTruncatedDescription from './no-truncated-description.ts';

const configs: Record<string, Linter.Config[]> = {};

/**
 * Manifests: every project's package.json declares the npm packages its
 * shipped code needs. How many depends on the project's shape: a bundled app
 * declares the whole closure its workspace imports pull in, an unbundled
 * project only its own imports. Islands are checked by
 * `island/dependency-checks`. A manifest that npm can publish keeps its
 * description inside what the npm registry stores.
 */
const plugin = {
  meta: { name: '@zukhruf/eslint/nx/manifest', namespace: 'manifest' },
  rules: {
    'dependency-checks': dependencyChecks,
    'no-truncated-description': noTruncatedDescription,
  },
  configs,
} satisfies ESLint.Plugin;

configs['recommended'] = [
  { name: 'manifest/recommended/plugins', plugins: { manifest: plugin } },
  {
    name: 'manifest/recommended',
    files: PACKAGE_JSON,
    languageOptions: { parser: jsonc },
    rules: {
      'manifest/dependency-checks': 'error',
      'manifest/no-truncated-description': 'error',
    },
  },
];

export default plugin;

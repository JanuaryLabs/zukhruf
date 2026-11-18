import type { ESLint, Linter } from 'eslint';
import * as jsonc from 'jsonc-eslint-parser';

import { PACKAGE_JSON } from '../files.ts';
import dependencyChecks from './dependency-checks.ts';
import noGlobstarWorkspace from './no-globstar-workspace.ts';
import noRootScript from './no-root-script.ts';
import noTruncatedDescription from './no-truncated-description.ts';
import nxFamilyPinned from './nx-family-pinned.ts';

const configs: Record<string, Linter.Config[]> = {};

/**
 * Manifests: every project's package.json declares the npm packages its
 * shipped code needs. How many depends on the project's shape: a bundled app
 * declares the whole closure its workspace imports pull in, an unbundled
 * project only its own imports. Islands are checked by
 * `island/dependency-checks`. A manifest that npm can publish keeps its
 * description inside what the npm registry stores. Only the workspace root
 * installs the nx family, at one exact version, and runs no npm script but
 * `prepare`. A `workspaces` glob has no `**`.
 */
const plugin = {
  meta: { name: '@zukhruf/eslint/nx/manifest', namespace: 'manifest' },
  rules: {
    'dependency-checks': dependencyChecks,
    'no-globstar-workspace': noGlobstarWorkspace,
    'no-root-script': noRootScript,
    'no-truncated-description': noTruncatedDescription,
    'nx-family-pinned': nxFamilyPinned,
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
      'manifest/no-globstar-workspace': 'error',
      'manifest/no-root-script': 'error',
      'manifest/no-truncated-description': 'error',
      'manifest/nx-family-pinned': 'error',
    },
  },
];

export default plugin;

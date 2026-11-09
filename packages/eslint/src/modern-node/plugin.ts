import e18e from '@e18e/eslint-plugin';
import type { ESLint, Linter } from 'eslint';
import unicorn from 'eslint-plugin-unicorn';
import { defineConfig } from 'eslint/config';

import { SOURCE } from '../files.ts';
import cryptoHash from './crypto-hash.ts';

const rules = {
  'crypto-hash': cryptoHash,
};

const configs: Record<string, Linter.Config[]> = {};

/**
 * Modern Node: checks that report code a newer Node or JavaScript API can
 * replace. A new check joins this namespace (ADR 0008).
 */
const plugin = {
  meta: { name: '@zukhruf/eslint/modern-node', namespace: 'modern-node' },
  rules,
  configs,
} satisfies ESLint.Plugin;

// e18e/ban-dependencies gives these packages only a different package, such as
// express to h3. That is a choice of the repo, not a new API. The rule has no
// option for the type of replacement (ADR 0008).
const ONLY_A_DIFFERENT_PACKAGE = [
  'debug',
  'detect-package-manager',
  'execa',
  'express',
  'fast-glob',
  'glob',
  'gray-matter',
  'js-yaml',
  'ora',
  'semver',
  'tar-stream',
  'yargs',
];

configs['recommended'] = defineConfig(
  {
    name: 'modern-node/recommended/plugins',
    plugins: { 'modern-node': plugin, e18e, unicorn },
  },
  {
    name: 'modern-node/recommended',
    files: SOURCE,
    extends: [e18e.configs.modernization],
    rules: {
      'modern-node/crypto-hash': 'error',
      'e18e/ban-dependencies': ['error', { allowed: ONLY_A_DIFFERENT_PACKAGE }],
      // The fixer changes a.concat(b) to [...a, b]. When b is an array, the
      // result changes and no error occurs.
      'e18e/prefer-spread-syntax': 'off',
      // @e18e/eslint-plugin 0.8.1: the fixer changes [...s].splice(0, 1), the
      // removed items, to s.toSpliced(0, 1), the remaining items.
      'e18e/prefer-array-to-spliced': 'off',
      // The fix gives unknown[], so the code does not compile.
      'e18e/prefer-array-fill': 'off',
      'e18e/prefer-exponentiation-operator': 'error',
      'e18e/prefer-flatmap-over-map-flat': 'error',
      'unicorn/prefer-error-is-error': 'error',
      'unicorn/prefer-group-by': 'error',
      'unicorn/prefer-import-meta-properties': 'error',
      'unicorn/prefer-iterator-helpers': 'error',
      'unicorn/prefer-promise-with-resolvers': 'error',
      'unicorn/prefer-set-methods': 'error',
      'unicorn/prefer-uint8array-hex': 'error',
    },
  },
);

export default plugin;

import e18e from '@e18e/eslint-plugin';
import type { ESLint, Linter } from 'eslint';
import unicorn from 'eslint-plugin-unicorn';
import { defineConfig } from 'eslint/config';

import { SOURCE, TYPESCRIPT } from '../files.ts';
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
      'unicorn/no-new-buffer': 'error',
      'unicorn/prefer-abort-signal-any': 'error',
      'unicorn/prefer-array-from-async': 'error',
      'unicorn/prefer-error-is-error': 'error',
      'unicorn/prefer-group-by': 'error',
      'unicorn/prefer-import-meta-properties': 'error',
      'unicorn/prefer-iterator-helpers': 'error',
      'unicorn/prefer-promise-with-resolvers': 'error',
      'unicorn/prefer-set-methods': 'error',
      'unicorn/prefer-uint8array-hex': 'error',
      'unicorn/prefer-url-search-parameters': 'error',
    },
  },
  {
    name: 'modern-node/recommended/typescript',
    files: TYPESCRIPT,
    rules: {
      // Only types prove that a value has a disposer. In a JavaScript file the
      // rule reports each close(), and the fix throws at run time (ADR 0008).
      'unicorn/prefer-dispose': 'error',
    },
  },
);

export default plugin;

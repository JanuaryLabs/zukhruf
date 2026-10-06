import type { ESLint, Linter } from 'eslint';
import esx from 'eslint-plugin-es-x';
import importX from 'eslint-plugin-import-x';

import { CONFIG_FILES, SCRIPTS, SOURCE, TESTS } from '../files.ts';
import noMissingConsole from './no-missing-console.ts';

const rules = { 'no-missing-console': noMissingConsole };

const configs: Record<string, Linter.Config[]> = {};

/**
 * Hermes: the JavaScript engine of React Native. Code that ships in the app
 * runs without Node's built-in modules, with only part of `Intl`, and with a
 * console that lacks some methods in release builds. Tests, config files and
 * scripts run in Node, so they are left alone.
 */
const plugin = {
  meta: { name: '@zukhruf/eslint/react-native', namespace: 'hermes' },
  rules,
  configs,
} satisfies ESLint.Plugin;

configs['recommended'] = [
  {
    name: 'hermes/recommended',
    files: SOURCE,
    ignores: [...TESTS, ...CONFIG_FILES, ...SCRIPTS],
    plugins: { hermes: plugin, 'es-x': esx, 'import-x': importX },
    rules: {
      'hermes/no-missing-console': 'error',
      // Hermes implements Collator, DateTimeFormat and NumberFormat only.
      'es-x/no-intl-displaynames': 'error',
      'es-x/no-intl-durationformat': 'error',
      'es-x/no-intl-listformat': 'error',
      'es-x/no-intl-locale': 'error',
      'es-x/no-intl-pluralrules': 'error',
      'es-x/no-intl-relativetimeformat': 'error',
      'es-x/no-intl-segmenter': 'error',
      'import-x/no-nodejs-modules': 'error',
    },
  },
];

export default plugin;

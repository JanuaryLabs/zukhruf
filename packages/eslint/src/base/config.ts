import js from '@eslint/js';
import functional from 'eslint-plugin-functional';
import importX from 'eslint-plugin-import-x';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import noPromiseField from '../async-values/no-promise-field.ts';
import { type Concept, enable } from '../concept.ts';
import {
  BUILD_OUTPUT,
  FIXTURES,
  JAVASCRIPT,
  SOURCE,
  TESTS,
  TYPESCRIPT,
} from '../files.ts';
import noPlaywrightTest from '../imports/no-playwright-test.ts';
import noStateManagers from '../imports/no-state-managers.ts';
import noEnum from '../language/no-enum.ts';
import { workspaceRootOf } from '../workspace/workspace-root.ts';
import { noFloatingPromises, noLet } from './options.ts';

const importBans = {
  'no-state-managers': noStateManagers,
  'no-playwright-test': noPlaywrightTest,
};

const rules = {
  'no-enum': noEnum,
  'no-promise-field': noPromiseField,
  ...importBans,
};

/**
 * What every TypeScript repo gets: the recommended sets of @eslint/js and
 * typescript-eslint, embedded first so a framework preset can never sit between
 * them and this config's changes, then the taste rules and the typed checks.
 */
export const base: Concept = {
  name: 'base',
  rules,
  config: (plugins) =>
    defineConfig(
      { name: 'zukhruf/base/ignores', ignores: [...BUILD_OUTPUT, '**/.nx'] },
      {
        name: 'zukhruf/base/recommended',
        files: SOURCE,
        extends: [js.configs.recommended, tseslint.configs.recommended],
      },
      {
        name: 'zukhruf/base/javascript-globals',
        files: JAVASCRIPT,
        languageOptions: { globals: { ...globals.browser, ...globals.node } },
      },
      {
        name: 'zukhruf/base/recommended-changes',
        files: SOURCE,
        rules: {
          'no-redeclare': 'off',
          '@typescript-eslint/no-redeclare': 'error',
          'no-unused-private-class-members': 'off',
          '@typescript-eslint/no-non-null-assertion': 'off',
          '@typescript-eslint/no-explicit-any': 'off',
          '@typescript-eslint/no-unused-vars': 'off',
          'no-empty': 'off',
          '@typescript-eslint/no-empty-function': 'off',
          '@typescript-eslint/parameter-properties': 'error',
          '@typescript-eslint/adjacent-overload-signatures': 'error',
          '@typescript-eslint/prefer-namespace-keyword': 'error',
          '@typescript-eslint/no-inferrable-types': 'error',
        },
      },
      {
        name: 'zukhruf/base/typescript',
        files: TYPESCRIPT,
        plugins,
        rules: {
          // `as X` papers over a type error instead of fixing it: narrow with
          // control flow. `as const` and `satisfies` stay allowed.
          '@typescript-eslint/consistent-type-assertions': [
            'error',
            { assertionStyle: 'never' },
          ],
          // Enums and value namespaces need a runtime transform, which Node's
          // strip-only `.ts` execution does not do.
          '@typescript-eslint/no-namespace': 'error',
          'zukhruf/no-enum': 'error',
        },
        // A disable directive that suppresses nothing outlived its reason.
        linterOptions: { reportUnusedDisableDirectives: 'error' },
      },
      {
        name: 'zukhruf/base/imports',
        files: SOURCE,
        plugins: { ...plugins, 'import-x': importX },
        rules: {
          ...enable(importBans),
          // Two imports of one module read as unrelated; type imports stay a
          // separate statement so they remain erasable on their own.
          'import-x/no-duplicates': ['error', { 'prefer-inline': false }],
          // A bare `import './x.ts'` hides a registration behind evaluation
          // order; a module you need is a value you bind.
          'import-x/no-unassigned-import': 'error',
        },
      },
      {
        // A module-scope `let` is a global, and the functions that read it
        // cannot be closures over it, so their other dependencies get drilled
        // through their signatures. Keep mutable state in its owner.
        name: 'zukhruf/base/module-state',
        files: TYPESCRIPT,
        ignores: [...TESTS, ...FIXTURES],
        plugins: { functional },
        rules: { 'functional/no-let': ['error', noLet()] },
      },
      {
        // Typed lint: the project service gives each file its nearest
        // tsconfig.json. The root comes from where ESLint runs, walked up to the
        // workspace, so it is right under `nx lint` (cwd = the project).
        name: 'zukhruf/base/typed',
        files: TYPESCRIPT,
        plugins,
        languageOptions: {
          parserOptions: {
            projectService: true,
            tsconfigRootDir: workspaceRootOf(process.cwd()) ?? process.cwd(),
          },
        },
        rules: {
          // A promise nobody awaits has nowhere to send its rejection; state
          // the intent with `void`, never `.catch(() => {})`.
          '@typescript-eslint/no-floating-promises': [
            'error',
            noFloatingPromises(),
          ],
          // A promise-returning function in a void slot loses its rejection
          // the same way.
          '@typescript-eslint/no-misused-promises': [
            'error',
            { checksConditionals: false, checksSpreads: false },
          ],
          // A thrown string or object has no stack, and `catch (error)` code
          // reads `error.message`.
          '@typescript-eslint/only-throw-error': 'error',
          // A switch over a union that misses a member and has no `default`
          // silently does nothing for it.
          '@typescript-eslint/switch-exhaustiveness-check': [
            'error',
            { considerDefaultExhaustiveForUnions: true },
          ],
          'zukhruf/no-promise-field': 'error',
        },
      },
    ),
};

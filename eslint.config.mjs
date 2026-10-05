import nx from '@nx/eslint-plugin';

import island, { islandConstraint } from './island.eslint.config.mjs';
import personalConfig from './personal.eslint.config.mjs';

const testHookRestrictedSyntax = [
  {
    selector:
      'CallExpression[callee.name=/^(before|after|beforeEach|afterEach|beforeAll|afterAll)$/]',
    message:
      'No test lifecycle hooks. Write self-contained AAA tests: inline arrange in each test and run teardown (cleanup, mock restore, resource stop) in a per-test try/finally.',
  },
];

const enumRestrictedSyntax = [
  {
    selector: 'TSEnumDeclaration',
    message:
      'No TS enums — they need a runtime transform and break Node strip-only `.ts` execution (tsc/bundlers hide it). Use a `const` object + a union type instead.',
  },
];

// msw only answers what a handler lists; without this option an unstubbed
// request is warned about and sent to the real network, so the test passes on
// a live dependency it never meant to touch. Scoped by the msw/node import.
const mswUnhandledRequestSyntax = [
  {
    selector:
      'Program:has(ImportDeclaration[source.value="msw/node"]) CallExpression[callee.property.name="listen"]:matches([arguments.length=0], [arguments.0.type="ObjectExpression"]):not(:has(Property[key.name="onUnhandledRequest"] > Literal[value="error"]))',
    message:
      "msw: server.listen() must pass { onUnhandledRequest: 'error' } so an unstubbed request fails the test instead of reaching the network.",
  },
];

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    // Flat config never reads .gitignore, so build output is listed here.
    ignores: ['**/dist', '**/out-tsc'],
  },
  {
    files: ['**/*.ts', '**/*.js'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?js$'],
          depConstraints: [
            { sourceTag: '*', onlyDependOnLibsWithTags: ['*'] },
            islandConstraint([]),
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
    ],
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
    },
  },
  {
    files: ['**/*.ts', '**/*.cts', '**/*.mts'],
    ignores: ['**/*.test.ts', '**/*.test.cts', '**/*.test.mts'],
    rules: {
      'no-restricted-syntax': ['error', ...enumRestrictedSyntax],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.cts', '**/*.test.mts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...testHookRestrictedSyntax,
        ...mswUnhandledRequestSyntax,
        ...enumRestrictedSyntax,
      ],
    },
  },
  ...island({ libraries: ['packages/**/*.ts'] }),
  {
    files: ['**/*.ts', '**/*.cts', '**/*.mts'],
    // A disable directive that no longer suppresses anything is an escape hatch
    // that outlived its reason.
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  ...personalConfig,
];

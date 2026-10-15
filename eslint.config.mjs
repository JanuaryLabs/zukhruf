import nx from '@nx/eslint-plugin';
import { defineConfig } from 'eslint/config';

import { TESTS } from './packages/eslint/src/files.ts';
import zukhruf from './packages/eslint/src/index.ts';
import island, {
  islandConstraint,
  manifest,
  moduleBoundaries,
} from './packages/eslint/src/nx.ts';

// The workspace lints with @zukhruf/eslint's source, which Node runs with its
// types stripped: Nx loads this file to build the project graph before
// anything is built, and a rule edit applies on the next lint. Consumers
// install the built package (packages/eslint/docs/adr/0003).

// The std layers (docs/adr/0001): the layers each layer's shipped code may
// import, and the layers its tests and test helpers may import. Each entry
// checks direct imports only, so a host that imports mutex does not also need
// the test tools that mutex's tests import.
const LAYERS = [
  {
    sourceTag: 'std:base',
    shipped: ['std:base'],
    tests: ['std:base', 'std:tool'],
  },
  {
    sourceTag: 'std:coordination',
    shipped: ['std:base'],
    tests: ['std:base', 'std:tool'],
  },
  {
    sourceTag: 'std:domain',
    shipped: ['std:base', 'std:coordination'],
    tests: ['std:base', 'std:coordination', 'std:domain', 'std:tool'],
  },
  { sourceTag: 'std:tool', shipped: ['std:tool'], tests: ['std:tool'] },
  { sourceTag: 'std:ui', shipped: [], tests: ['std:tool'] },
  {
    sourceTag: 'std:host',
    shipped: ['std:base', 'std:coordination', 'std:domain', 'std:ui'],
    tests: ['std:base', 'std:coordination', 'std:domain', 'std:ui', 'std:tool'],
  },
];

export default defineConfig(
  nx.configs['flat/base'],
  {
    plugins: { zukhruf, island, manifest },
    extends: [
      'zukhruf/base',
      'zukhruf/tests',
      'zukhruf/hono',
      'zukhruf/diagnostics',
      'zukhruf/nx-project-json',
      'island/recommended',
      'manifest/recommended',
    ],
    settings: {
      island: { libraries: ['packages/**/*.ts', 'packages/**/*.tsx'] },
    },
  },
  {
    files: ['packages/shadcn/**'],
    plugins: { zukhruf },
    extends: ['zukhruf/react', 'zukhruf/tailwind'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js'],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('shipped'),
    },
  },
  {
    files: [...TESTS, '**/src/testing/**'],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('tests'),
    },
  },
  // The tests of the shadcn package import it by its name, as an app does,
  // so they check the published entry and not the source files.
  {
    files: ['packages/shadcn/src/**/*.test.ts'],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('tests', [
        '@zukhruf/shadcn',
      ]),
    },
  },
  // The shadcn CLI writes these files (`nx run shadcn:sync`), and nobody edits
  // them by hand, so the rules that the stock code fails are off here only.
  {
    files: [
      'packages/shadcn/src/components/**',
      'packages/shadcn/src/hooks/**',
      'packages/shadcn/src/lib/**',
      'packages/shadcn/src/index.ts',
    ],
    rules: {
      // `#components/*` and the like are the package's private imports
      // (package.json `imports`); the layer check stays on.
      '@nx/enforce-module-boundaries': moduleBoundaryRule('shipped', [
        '#components/*',
        '#lib/*',
        '#hooks/*',
      ]),
      '@typescript-eslint/consistent-type-assertions': 'off',
      'zukhruf/no-fabricated-fallback': 'off',
      'zukhruf/no-will-change': 'off',
      'zukhruf/no-arbitrary-z-index': 'off',
      'functional/no-let': 'off',
    },
  },
);

/**
 * The rule with the std layer table for one kind of file. A later block
 * replaces the rule's options (packages/eslint/docs/adr/0004), so each block
 * carries the island constraint and the whole table.
 */
function moduleBoundaryRule(files, allow = []) {
  return [
    'error',
    moduleBoundaries({
      allow,
      depConstraints: [
        islandConstraint([]),
        ...LAYERS.map((layer) => ({
          sourceTag: layer.sourceTag,
          onlyDependOnLibsWithTags: layer[files],
        })),
      ],
    }),
  ];
}

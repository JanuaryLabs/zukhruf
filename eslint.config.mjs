import nx from '@nx/eslint-plugin';
import { defineConfig } from 'eslint/config';

import { TESTS, TEST_SUPPORT } from './packages/eslint/src/files.ts';
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
  {
    sourceTag: 'std:tool',
    shipped: ['std:base', 'std:tool'],
    tests: ['std:base', 'std:tool'],
  },
  { sourceTag: 'std:ui', shipped: [], tests: ['std:tool'] },
  {
    sourceTag: 'std:ui-extension',
    shipped: ['std:ui'],
    tests: ['std:ui', 'std:tool'],
  },
  {
    sourceTag: 'std:host',
    shipped: [
      'std:base',
      'std:coordination',
      'std:domain',
      'std:ui',
      'std:ui-extension',
    ],
    tests: [
      'std:base',
      'std:coordination',
      'std:domain',
      'std:ui',
      'std:ui-extension',
      'std:tool',
    ],
  },
];

const DIAGRAM_OUTPUTS = ['svg', 'canvas', 'html'];

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
    files: [
      'packages/shadcn/**',
      'packages/diagram/**',
      'packages/ui/**',
      'apps/diagram-playground/**',
    ],
    plugins: { zukhruf },
    extends: ['zukhruf/react', 'zukhruf/tailwind'],
  },
  // A stylesheet import loads the styles; it has no binding to assign.
  {
    files: ['apps/diagram-playground/src/**/*.tsx'],
    rules: {
      'import-x/no-unassigned-import': ['error', { allow: ['**/*.css'] }],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js'],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('shipped'),
    },
  },
  {
    files: [...TESTS, ...TEST_SUPPORT],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('tests'),
    },
  },
  // `node --test-global-setup` (named in nx.json) runs the global setup as an entry point, so it reads the environment as a test file does.
  {
    files: ['packages/*/src/testing/docker-global-setup.ts'],
    rules: { 'island/no-process-env': 'off' },
  },
  // The tests of the UI packages import them by their names, as an app does,
  // so they check the published entry and not the source files.
  {
    files: ['packages/shadcn/src/**/*.test.ts'],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('tests', [
        '@zukhruf/shadcn',
      ]),
    },
  },
  {
    files: ['packages/diagram/src/**/*.test.ts'],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('tests', [
        '@zukhruf/diagram',
      ]),
    },
  },
  {
    files: ['packages/ui/src/**/*.test.ts'],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('tests', [
        '@zukhruf/ui',
      ]),
    },
  },
  // The diagram outputs (svg, canvas, html) never import each other, and
  // renderers/shared/, which every output uses, imports none of them.
  {
    files: ['packages/diagram/src/**'],
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: `${import.meta.dirname}/packages/diagram/src/lib/renderers`,
          zones: [
            ...DIAGRAM_OUTPUTS.map((output) => ({
              target: `./${output}`,
              from: DIAGRAM_OUTPUTS.filter((other) => other !== output).map(
                (other) => `./${other}`,
              ),
              message:
                'Diagram outputs never import each other; share code through renderers/shared/, compiler/, layouts/ or react/chrome/.',
            })),
            {
              target: './shared',
              from: DIAGRAM_OUTPUTS.map((output) => `./${output}`),
              message:
                'renderers/shared/ is used by every output and imports none of them.',
            },
          ],
        },
      ],
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

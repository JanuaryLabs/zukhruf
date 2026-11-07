import nx from '@nx/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';

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
  // Snowball's JavaScript stemmers, kept byte for byte (sha256 in
  // packages/mteb/docs/ported-from-mteb.md).
  globalIgnores(['packages/mteb/src/dependencies/snowball/']),
  // The frozen files of the relevance-filtering research rounds, kept byte for
  // byte (their sha256 files beside them). Their scripts ran from the
  // research folder, not from this workspace.
  globalIgnores(['docs/research/relevance-filtering/']),
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
  // The event-detection eval is not shipped. Like the tests, it runs the
  // package with a real Collection of @zukhruf/embeddings. Its runner and its
  // fitter are command line programs: they read their environment and print
  // the scores. An entry reads the time, as an app does.
  {
    files: ['packages/information-filtering/event-detection/eval/**'],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('tests'),
      'island/no-ambient-time': 'off',
    },
  },
  {
    files: [
      'packages/information-filtering/event-detection/eval/run.ts',
      'packages/information-filtering/event-detection/eval/fit.ts',
    ],
    rules: { 'island/no-console': 'off', 'island/no-process-env': 'off' },
  },
  // The relevance-filtering eval is not shipped. Like the tests, it runs the
  // package with real Collections of @zukhruf/embeddings. Its runner and its
  // seed are command line programs: they print what they did. An entry reads
  // the time, as an app does.
  {
    files: ['packages/information-filtering/relevance-filtering/eval/**'],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('tests'),
      'island/no-ambient-time': 'off',
    },
  },
  {
    files: [
      'packages/information-filtering/relevance-filtering/eval/run.ts',
      'packages/information-filtering/relevance-filtering/eval/seed.ts',
    ],
    rules: { 'island/no-console': 'off' },
  },
  // @zukhruf/shutdown takes over the report of a crash from Node.js. With a
  // listener for 'uncaughtException', Node.js does not write the error, and a
  // crash after a termination signal ends the process before a host can log
  // it, so the package writes the error to standard error (its ADR 0003).
  {
    files: ['packages/shutdown/src/shutdown.ts'],
    rules: { 'island/no-console': 'off' },
  },
  // The React components of @zukhruf/ui and @zukhruf/shadcn wait on the timers
  // of the browser. How a component gets a clock is not decided yet (#3600),
  // so island/no-ambient-time does not reach them.
  {
    files: ['packages/ui/src/**', 'packages/shadcn/src/**'],
    rules: { 'island/no-ambient-time': 'off' },
  },
  // The examples of @zukhruf/mteb are not shipped. They are command line
  // programs: they read their arguments and print the scores.
  {
    files: ['packages/mteb/examples/**'],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('tests'),
      'island/no-console': 'off',
      'island/no-process-env': 'off',
    },
  },
  // pg-pool's end() resolves before the sockets of its clients close, so the
  // FORCE drop of a test database can end a session the pool still owns
  // (#3305). postgresPool waits for every socket, and its type has no end.
  {
    files: ['packages/mutex/src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "NewExpression[callee.object.name='pg'][callee.property.name='Pool']",
          message:
            'Use postgresPool of src/testing/subjects/postgres.ts with `await using`: it ends once the server has no session of the pool, so the database can be dropped (#3305).',
        },
        {
          selector:
            "ImportDeclaration[source.value='pg'] > ImportSpecifier[imported.name='Pool']",
          message:
            'Use postgresPool of src/testing/subjects/postgres.ts with `await using` instead of a Pool of pg: it ends once the server has no session of the pool, so the database can be dropped (#3305).',
        },
      ],
    },
  },
  // @zukhruf/testing depends on docker, and docker on async, so the tests of
  // these two packages cannot import TemporaryFiles: that import would make a
  // cycle in the build (docs/adr/0001, line 29). Docker keeps its own copy of
  // the temporary directory (packages/docker/docs/copied-code.md).
  {
    files: ['packages/docker/**', 'packages/async/**'],
    rules: { 'zukhruf/no-raw-temp-directory': 'off' },
  },
  // @zukhruf/sqlite-open is the one place that constructs DatabaseSync. The
  // SQLite fixture of @zukhruf/testing cannot use it: sqlite-open tests with
  // @zukhruf/testing, so that import would make a cycle in the build
  // (docs/adr/0001, line 29), and its lock holder needs a busy timeout of 0.
  {
    files: ['packages/sqlite/open/**', 'packages/testing/src/databases/**'],
    rules: { 'zukhruf/no-raw-database-sync': 'off' },
  },
  // The Latch is the one-shot gate that zukhruf/no-promise-field tells code
  // to wait on, so its promise must live in its field. It never rejects and
  // is never replaced, so no hazard of the rule applies.
  {
    files: ['packages/async/src/latch.ts'],
    rules: { 'zukhruf/no-promise-field': 'off' },
  },
  // The tests of TemporaryFiles arrange their parent folders with node:fs, so
  // that the subject under test does not make its own fixtures.
  {
    files: ['packages/testing/src/fs/temporary-files.test.ts'],
    rules: { 'zukhruf/no-raw-temp-directory': 'off' },
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
  // A family of @zukhruf/evals imports only the core, never another family or
  // the adapter, and the core imports no subpath (packages/evals ADR 0001,
  // rule 1). A test may compose the core with a family, so tests are out.
  {
    files: ['packages/evals/src/**'],
    ignores: ['packages/evals/src/**/*.test.ts'],
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: `${import.meta.dirname}/packages/evals/src`,
          zones: [
            {
              target: './structured',
              from: ['./classification', './promptfoo'],
              message:
                'A family of @zukhruf/evals imports only the core (ADR 0001, rule 1).',
            },
            {
              target: './classification',
              from: ['./structured', './promptfoo'],
              message:
                'A family of @zukhruf/evals imports only the core (ADR 0001, rule 1).',
            },
            {
              target: './promptfoo',
              from: ['./structured', './classification'],
              message:
                'The promptfoo adapter imports only the core (ADR 0001, rule 1).',
            },
            {
              target: ['./index.ts', './aggregation', './scoring', './scorers'],
              from: ['./structured', './classification', './promptfoo'],
              message:
                'The core of @zukhruf/evals imports no subpath (ADR 0001, rule 1).',
            },
          ],
        },
      ],
    },
  },
  // sqlite-queue mirrors pg-boss's work() options, which still accepts
  // priority and orderByCreatedOn and warns that they are ignored; the parity
  // drops them when pg-boss's next major removes them.
  {
    files: ['packages/sqlite/queue/src/**'],
    rules: {
      '@typescript-eslint/no-deprecated': [
        'error',
        {
          // A read of the options matches by name (they are plain booleans,
          // which no package declares); an options literal matches by
          // pg-boss's JobFetchOptions, where the two are declared.
          allow: [
            'priority',
            'orderByCreatedOn',
            { from: 'package', package: 'pg-boss', name: 'JobFetchOptions' },
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

import nx from '@nx/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';
import * as jsonc from 'jsonc-eslint-parser';

import { TESTS, TEST_SUPPORT } from './packages/eslint/src/files.ts';
import zukhruf from './packages/eslint/src/index.ts';
import modernNode from './packages/eslint/src/modern-node.ts';
import island, {
  islandConstraint,
  manifest,
  moduleBoundaries,
} from './packages/eslint/src/nx.ts';
import shadcnStrict from './packages/eslint/src/shadcn-strict.ts';

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
  globalIgnores(['packages/mteb/vendor/']),
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
      'zukhruf/tsconfig',
      'zukhruf/github-actions',
      'island/recommended',
      'manifest/recommended',
    ],
    settings: {
      island: { libraries: ['packages/**/*.ts', 'packages/**/*.tsx'] },
    },
  },
  // A test has the limit of its test target, the default of @zukhruf/nx/test.
  {
    files: ['**/*.{test,spec}.ts', '**/*.{test,spec}.tsx', '**/src/testing/**'],
    rules: {
      'zukhruf/no-short-test-timeout': ['error', { minimum: 300_000 }],
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
    extends: ['zukhruf/shadcn', 'zukhruf/tailwind'],
  },
  // The kit's hosts use it as installed (packages/eslint/docs/adr/0011). The
  // kit's own source styles its parts, so it stays out.
  {
    files: [
      'packages/diagram/**',
      'packages/ui/**',
      'apps/diagram-playground/**',
    ],
    extends: [shadcnStrict],
  },
  // The loader guard throws React Router's replace(), as a loader does.
  {
    files: ['packages/authentication/src/react-router*.ts'],
    plugins: { zukhruf },
    extends: ['zukhruf/react-router'],
  },
  // Modern Node is for code that runs on Node, and these packages run in
  // browsers (packages/eslint/docs/adr/0008).
  {
    ignores: [
      'packages/shadcn/**',
      'packages/diagram/**',
      'packages/ui/**',
      'apps/diagram-playground/**',
    ],
    plugins: { 'modern-node': modernNode },
    extends: ['modern-node/recommended'],
  },
  // A release rewrites only the ranges of the npm:public group. A caret in a
  // private package stops matching at the next minor, and npm then locks a
  // registry copy of the workspace package under that package (#3438).
  {
    files: ['**/package.json'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSONObjectExpression:has(> JSONProperty[key.value='private'][value.value=true]) > JSONProperty[key.value=/^(dev|peer|optional)?[dD]ependencies$/] > JSONObjectExpression > JSONProperty[key.value=/^@zukhruf./][value.value!='*']",
          message:
            'A private package takes a workspace @zukhruf/* package with "*": a release does not rewrite its ranges (#3438).',
        },
        // No native dependencies: a feature of another driver comes to
        // node:sqlite in JS, or not at all (sqlite-open ADR 0007).
        {
          selector:
            'JSONProperty[key.value=/^(dev|peer|optional)?[dD]ependencies$/] > JSONObjectExpression > JSONProperty[key.value=/^(better-sqlite3|sqlite3|@photostructure\\u002Fsqlite|libsql|@libsql\\u002Fclient)$/]',
          message:
            'zukhruf uses node:sqlite, not a native SQLite driver. Open a connection with open() of @zukhruf/sqlite-open, and bring a feature of the driver to node:sqlite in JS.',
        },
      ],
    },
  },
  // The setup-workspace action is the one place that installs the workspace
  // with actions/setup-node and `npm ci`: every other job calls it.
  {
    files: ['.github/actions/setup-workspace/action.yml'],
    rules: { 'zukhruf/no-manual-workspace-install': 'off' },
  },
  // No project holds the lockfile, so CI lints it in its own step.
  {
    files: ['package-lock.json'],
    languageOptions: { parser: jsonc },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSONProperty[key.value=/.node_modules.@zukhruf./] > JSONObjectExpression > JSONProperty[key.value='resolved'][value.value=/^https?:/]",
          message:
            'A workspace package is locked from the registry: its range stopped matching the workspace version. Fix the range and drop this entry (#3438).',
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js'],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('shipped'),
    },
  },
  // The pre-commit hook runs a step that tools/readme-table owns. The hook is
  // a file that git runs, not a package, so it imports the step by its path.
  {
    files: ['.husky/*.ts'],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('shipped', [
        '../tools/readme-table/src/readme-table-step.ts',
      ]),
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
  // The freshness check of @zukhruf/nx/opentofu is a command line program
  // that the `show` target runs: it tells the person why the saved plan is
  // refused, and its exit code stops the target (packages/nx ADR 0007).
  {
    files: ['packages/nx/src/opentofu/check-plan-fresh.ts'],
    rules: { 'island/no-console': 'off' },
  },
  // The migration diff of @zukhruf/nx/prisma is a command line program that
  // the migrate:check and migrate:create targets run: it gives its
  // environment to Docker and to Prisma, names a new migration by the time,
  // as `prisma migrate dev` does, and tells the person what failed or what it
  // wrote (packages/nx ADR 0018).
  {
    files: ['packages/nx/src/prisma/migrate-diff.ts'],
    rules: {
      'island/no-console': 'off',
      'island/no-process-env': 'off',
      'island/no-ambient-time': 'off',
    },
  },
  // The nightly checks of @zukhruf/nx are not shipped. Like the tests, they
  // import the tool layer. They are command line programs: they give their
  // environment to the tools of a generated workspace, pick the base release
  // by its age, and print each step (packages/nx ADR 0020).
  {
    files: ['packages/nx/src/e2e/**'],
    rules: {
      '@nx/enforce-module-boundaries': moduleBoundaryRule('tests'),
      'island/no-console': 'off',
      'island/no-process-env': 'off',
      'island/no-ambient-time': 'off',
    },
  },
  // @zukhruf/shutdown takes over the report of a crash from Node.js. With a
  // listener for 'uncaughtException', Node.js does not write the error, and a
  // crash after a termination signal ends the process before a host can log
  // it, so the package writes the error to standard error (its ADR 0003).
  {
    files: ['packages/shutdown/src/shutdown.ts'],
    rules: { 'island/no-console': 'off' },
  },
  // The CLI of shadcn writes this source, and a UI package can not import the
  // clock of @zukhruf/ui, so its timers stay (packages/ui ADR 0001).
  {
    files: ['packages/shadcn/src/**'],
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
  // (#3305). A pool of a Postgres handle of @zukhruf/testing, or of its
  // postgresPool, waits for every socket (testing ADR 0026).
  {
    files: ['packages/mutex/src/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "NewExpression[callee.object.name='pg'][callee.property.name='Pool']",
          message:
            'Take the pool from the database handle, `database.pool()`, or from postgresPool of @zukhruf/testing/postgres with `await using`: it ends once the server has no session of the pool, so the database can be dropped (#3305).',
        },
        {
          selector:
            "ImportDeclaration[source.value='pg'] > ImportSpecifier[imported.name='Pool']",
          message:
            'Take the pool from the database handle, `database.pool()`, or from postgresPool of @zukhruf/testing/postgres with `await using`, instead of a Pool of pg: it ends once the server has no session of the pool, so the database can be dropped (#3305).',
        },
      ],
    },
  },
  // @zukhruf/fs depends on async and sqlite-open, so the tests of these two
  // packages cannot import TemporaryFiles: that import would make a cycle in
  // the build (docs/adr/0001). sqlite-open keeps a copy of the temporary
  // directory (packages/sqlite/open/docs/copied-code.md). The tests of fs
  // import @zukhruf/parameterized-test, so its own tests use node:fs's
  // mkdtempDisposable (its ADR 0001).
  {
    files: [
      'packages/async/**',
      'packages/sqlite/open/**',
      'packages/parameterized-test/**',
    ],
    rules: { 'zukhruf/no-raw-temp-directory': 'off' },
  },
  // @zukhruf/sqlite-open is the one place that constructs DatabaseSync. The
  // SQLite fixture of @zukhruf/testing does not use it: its lock holder needs
  // a busy timeout of 0.
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
  // TemporaryFiles is the one place that makes a temporary directory with
  // node:fs. Its tests arrange their parent folders with node:fs, so that the
  // subject under test does not make its own fixtures.
  {
    files: [
      'packages/fs/src/temporary-files.ts',
      'packages/fs/src/temporary-files.test.ts',
    ],
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
              target: [
                './index.ts',
                './aggregation',
                './presentation',
                './scoring',
                './scorers',
              ],
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
  // Each pg-boss line that sqlite-queue cites is a line of the pinned pg-boss
  // (its ADR 0001). The rules are in tools/eslint-rules.
  {
    files: ['packages/sqlite/queue/**/*.ts'],
    rules: { '@nx/workspace-pg-boss-cited-lines': 'error' },
  },
  {
    files: ['packages/sqlite/queue/package.json'],
    rules: { '@nx/workspace-pg-boss-cited-version': 'error' },
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
      // shadcn 4.23's use-highlighted-code cancels with `let cancelled`.
      'zukhruf/no-phase-flag': 'off',
      // shadcn 4.23's code-block drops a clipboard rejection and
      // use-highlighted-code a highlighter rejection (#3619).
      'zukhruf/no-silent-catch': 'off',
      // shadcn 4.23's native-select wraps the <select> that the rule keeps
      // out of app code.
      'zukhruf/no-native-control': 'off',
      // The kit styles its own parts through their data-slot.
      'zukhruf/no-data-slot-restyle': 'off',
      // shadcn's chart (registry, 2026-11-20) reads the Legend's
      // verticalAlign, which recharts 3.11 deprecates for position.
      '@typescript-eslint/no-deprecated': 'off',
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
      // Nx forbids a static import of a package that shipped code of the
      // project loads lazily, to keep it out of the first bundle. A test is
      // never bundled, so it imports such a package statically (#5743: the
      // tests of @zukhruf/nx and the optional peer @zukhruf/testing).
      ...(files === 'tests' && { checkDynamicDependenciesExceptions: ['.*'] }),
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

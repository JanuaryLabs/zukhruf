// File globs for the package's configs. Every glob starts with a `**` segment,
// so it means the same whichever folder the config is resolved from: a
// root-relative glob such as `apps/**` matches nothing once a project's own
// config re-exports the root config under `nx lint`.
export const TYPESCRIPT = ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'];
export const JAVASCRIPT = ['**/*.js', '**/*.jsx', '**/*.cjs', '**/*.mjs'];
export const SOURCE = [...TYPESCRIPT, ...JAVASCRIPT];
export const JSX = ['**/*.tsx', '**/*.jsx'];
/** The extensions a test file can have: `x.test.<extension>` or `x.spec.<extension>`. */
export const TEST_EXTENSIONS = [
  'ts',
  'tsx',
  'cts',
  'mts',
  'js',
  'jsx',
  'cjs',
  'mjs',
];
export const TESTS = [`**/*.{test,spec}.{${TEST_EXTENSIONS.join(',')}}`];
/** Test-support scripts run top-level like tests: their state is arrange state. */
export const FIXTURES = ['**/*.fixture.ts'];
/** A script's stdout is its interface. */
export const SCRIPTS = ['**/scripts/**'];
/** Config files run at build time on the developer's environment. */
export const CONFIG_FILES = ['**/*.config.{js,cjs,mjs,ts,mts,cts}'];
export const PACKAGE_JSON = ['**/package.json'];
export const PROJECT_JSON = ['**/project.json'];
/** Flat config never reads .gitignore, so build output is ignored by name. */
export const BUILD_OUTPUT = [
  '**/dist',
  '**/out-tsc',
  '**/build',
  '**/.react-router',
  '**/vite.config.*.timestamp*',
  '**/vitest.config.*.timestamp*',
];

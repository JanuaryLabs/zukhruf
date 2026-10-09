import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint, printConfig } from '../testing/run-eslint.ts';
import { isRecord } from '../unknown-values.ts';

// Typed lint needs every linted file in a tsconfig; `types: []` keeps the
// fixture from loading @types the temporary folder does not have.
const tsconfig = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, types: [] },
  include: ['**/*.ts'],
});

const ruleIds = (findings: { ruleId: string | null }[]) =>
  findings.map(({ ruleId }) => ruleId);

test('a later config that sets no-restricted-syntax cannot silence the package’s checks', () => {
  // Arrange: a framework preset after the package's configs, setting the one
  // key every hand-written ban used to share (Nx's React preset sets exactly this).
  using workspace = fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(`
      { plugins: { zukhruf }, extends: ['zukhruf/base', 'zukhruf/tests'] },
      { rules: { 'no-restricted-syntax': ['warn', 'WithStatement'] } },
    `),
    'src/color.ts': 'export enum Color { Red }\n',
    'src/color.test.ts': 'beforeEach(() => {});\n',
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.ok(ruleIds(findings).includes('zukhruf/no-enum'));
  assert.ok(ruleIds(findings).includes('zukhruf/no-test-lifecycle-hooks'));
});

test('a project config that re-exports the root config still applies path-scoped checks', () => {
  // Arrange: `nx lint` runs ESLint from the project folder, and the project's
  // own config re-exports the root one, which resolves root globs from there.
  using workspace = fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(`
      {
        plugins: { zukhruf, island },
        extends: ['zukhruf/base', 'island/recommended', 'zukhruf/packaged-app'],
        settings: { island: { libraries: ['packages/lib/**/*.ts'] } },
      },
      {
        rules: {
          'zukhruf/no-bare-spawn': ['error', { roots: ['apps/desktop/src'] }],
        },
      },
    `),
    'packages/lib/project.json': '{}',
    'packages/lib/eslint.config.mjs': `export { default } from '../../eslint.config.mjs';\n`,
    'packages/lib/src/index.ts': `console.log('loaded');\n`,
    'apps/desktop/project.json': '{}',
    'apps/desktop/eslint.config.mjs': `export { default } from '../../eslint.config.mjs';\n`,
    'apps/desktop/src/main.ts': `import { spawn } from 'node:child_process';\nspawn('git', ['status']);\n`,
    'apps/web/project.json': '{}',
    'apps/web/eslint.config.mjs': `export { default } from '../../eslint.config.mjs';\n`,
    'apps/web/src/main.ts': `import { spawn } from 'node:child_process';\nconsole.log('ok');\nspawn('git', ['status']);\n`,
  });

  // Act
  const library = lint(workspace.path('packages/lib'), ['src']);
  const desktop = lint(workspace.path('apps/desktop'), ['src']);
  const web = lint(workspace.path('apps/web'), ['src']);

  // Assert: in scope by settings or by roots, and out of scope elsewhere.
  assert.ok(ruleIds(library).includes('island/no-console'));
  assert.ok(ruleIds(desktop).includes('zukhruf/no-bare-spawn'));
  assert.deepEqual(ruleIds(web), []);
});

test('the typed-lint root is the workspace, found from the folder ESLint runs in', () => {
  // Arrange: the package is installed (its build under node_modules), and
  // ESLint runs from a project two folders below the workspace root.
  using workspace = fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
    ),
    'apps/api/project.json': '{}',
    'apps/api/src/main.ts': 'export const port = 1;\n',
  });

  // Act
  const config = printConfig(workspace.path('apps/api'), 'src/main.ts');

  // Assert
  const languageOptions = isRecord(config)
    ? config['languageOptions']
    : undefined;
  const parserOptions = isRecord(languageOptions)
    ? languageOptions['parserOptions']
    : undefined;
  assert.ok(isRecord(parserOptions));
  assert.equal(parserOptions['tsconfigRootDir'], workspace.root);
});

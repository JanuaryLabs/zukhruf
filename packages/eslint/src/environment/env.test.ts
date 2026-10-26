import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

// Typed lint needs every linted file in a tsconfig; `types: []` keeps the
// fixture from loading @types the temporary folder does not have.
const tsconfig = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, types: [] },
  include: ['**/*.ts'],
});

const RULE = 'zukhruf/no-undeclared-process-env';

test('zukhruf/env does not check a tool config file, which runs at build time without the startup schema', () => {
  // Arrange
  using workspace = fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(`{
      plugins: { zukhruf },
      extends: ['zukhruf/base', 'zukhruf/env'],
    }`),
    'src/startup.ts': 'const env = z.object({ PORT: z.string() });\n',
    'src/server.ts': 'export const secret = process.env.SECRET;\n',
    'vite.config.ts': 'export const port = process.env.VITE_PORT;\n',
  });

  // Act
  const findings = lint(workspace.root, ['.']);

  // Assert
  const envFindings = findings.filter(({ ruleId }) => ruleId === RULE);
  assert.deepEqual(
    envFindings.map(({ file }) => file),
    [workspace.path('src/server.ts')],
  );
});

test('zukhruf/env with settings.env.startupFile does not check test files', () => {
  // Arrange: a repo whose startup file is not src/startup.ts.
  using workspace = fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(`
      { plugins: { zukhruf }, extends: ['zukhruf/base', 'zukhruf/env'] },
      { settings: { env: { startupFile: 'src/env.ts' } } },
    `),
    'src/env.ts': 'const env = z.object({ PORT: z.string() });\n',
    'src/server.test.ts': 'export const fixture = process.env.TEST_ONLY;\n',
  });

  // Act
  const findings = lint(workspace.root, ['.']);

  // Assert
  assert.deepEqual(
    findings.filter(({ ruleId }) => ruleId === RULE),
    [],
  );
});

test('zukhruf/env with settings.env.startupFile reports an undeclared key against that file', () => {
  // Arrange
  using workspace = fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(`
      { plugins: { zukhruf }, extends: ['zukhruf/base', 'zukhruf/env'] },
      { settings: { env: { startupFile: 'src/env.ts' } } },
    `),
    'src/env.ts': 'const env = z.object({ PORT: z.string() });\n',
    'src/server.ts': [
      'export const port = process.env.PORT;',
      'export const secret = process.env.SECRET;',
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['.']);

  // Assert
  assert.deepEqual(
    findings.filter(({ ruleId }) => ruleId === RULE),
    [
      {
        file: workspace.path('src/server.ts'),
        ruleId: RULE,
        message:
          'Declare SECRET in src/env.ts before using process.env.SECRET.',
      },
    ],
  );
});

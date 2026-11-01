import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

// `types: []` keeps the fixture from loading @types the temporary folder does
// not have.
const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'esnext',
    module: 'nodenext',
    types: [],
  },
  include: ['**/*.ts'],
});

const unassigned = (findings: { ruleId: string | null; file: string }[]) =>
  findings
    .filter(({ ruleId }) => ruleId === 'import-x/no-unassigned-import')
    .map(({ file }) => basename(file))
    .sort();

test('base allows the side-effect imports of the standard: a stylesheet, env.ts and startup.ts', async () => {
  // Arrange: a Vite entry and a backend server, as the standard lays them out.
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
    ),
    'src/main.ts': [`import './styles.css';`, `export {};`, ``].join('\n'),
    'src/startup.ts': [`import './env.ts';`, `export {};`, ``].join('\n'),
    'src/server.ts': [`import './startup.ts';`, `export {};`, ``].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(unassigned(findings), []);
});

test('a repo that allows one more side-effect import with noUnassignedImport() keeps the standard ones', async () => {
  // Arrange: the repo's own entry, as text2sql allows its Electron exceptions.ts.
  const factory = JSON.stringify(import.meta.resolve('@zukhruf/eslint'));
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': [
      `import { noUnassignedImport } from ${factory};`,
      fixtureConfig(
        [
          `{ plugins: { zukhruf }, extends: ['zukhruf/base'] },`,
          `{ rules: { 'import-x/no-unassigned-import': ['error', noUnassignedImport({ allow: ['**/exceptions.ts'] })] } }`,
        ].join('\n'),
      ),
    ].join('\n'),
    'src/main.ts': [
      `import './exceptions.ts';`,
      `import './styles.css';`,
      `export {};`,
      ``,
    ].join('\n'),
    'src/worker.ts': [`import './polyfills.ts';`, `export {};`, ``].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(unassigned(findings), ['worker.ts']);
});

test('base still reports any other side-effect import', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
    ),
    'src/main.ts': [`import './polyfills.ts';`, `export {};`, ``].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(unassigned(findings), ['main.ts']);
});

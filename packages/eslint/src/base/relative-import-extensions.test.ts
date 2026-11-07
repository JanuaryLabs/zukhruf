import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const files = {
  'nx.json': '{}',
  // `types: []` keeps the fixture from loading @types the temporary folder
  // does not have.
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'esnext',
      module: 'nodenext',
      allowImportingTsExtensions: true,
      types: [],
    },
    include: ['**/*.ts'],
  }),
  'eslint.config.mjs': fixtureConfig(
    `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
  ),
  // A package with a subpath export, as zod ships `zod/mini`.
  'node_modules/zod/package.json': JSON.stringify({
    name: 'zod',
    type: 'module',
    exports: { '.': './index.js', './mini': './mini/index.js' },
  }),
  'node_modules/zod/index.js': 'export const z = {};\n',
  'node_modules/zod/mini/index.js': 'export const z = {};\n',
  // A subpath import whose target in package.json carries the extension.
  'package.json': JSON.stringify({
    name: 'fixture',
    type: 'module',
    imports: { '#lib/*': './src/lib/*.ts' },
  }),
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export interface B { b: number }\n',
  'src/lib/c.ts': 'export const c = 1;\n',
};

const extensionFindings = (
  findings: { ruleId: string | null; message: string }[],
) =>
  findings
    .filter(({ ruleId }) => ruleId === 'import-x/extensions')
    .map(({ message }) => message);

test('base reports a relative import and a relative type import that have no extension', async () => {
  // Arrange: a declaration file that imports './deriver' fails under nodenext (TS2835).
  await using workspace = await fixtureWorkspace({
    ...files,
    'src/main.ts': [
      `import { a } from './a';`,
      `import type { B } from './b';`,
      `export const value: B = { b: a };`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(extensionFindings(findings), [
    'Missing file extension for "./a"',
    'Missing file extension for "./b"',
  ]);
});

test('base accepts a relative import with .js or .ts, a package, a package subpath and a subpath import', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    ...files,
    'src/main.ts': [
      `import { a } from './a.js';`,
      `import type { B } from './b.ts';`,
      `import { z } from 'zod';`,
      `import { z as mini } from 'zod/mini';`,
      `import { c } from '#lib/c';`,
      `export const value: B = { b: a + c };`,
      `export { z, mini };`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(extensionFindings(findings), []);
});

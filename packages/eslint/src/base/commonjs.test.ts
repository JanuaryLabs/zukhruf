import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

// `types: []` keeps the fixture from loading @types the temporary folder does
// not have. `require` stays undeclared: the rule reports only the global one.
const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'esnext',
    module: 'nodenext',
    types: [],
  },
  include: ['**/*.ts', '**/*.cts'],
});

const requireAt = (findings: { ruleId: string | null; file: string }[]) =>
  findings
    .filter(({ ruleId }) => ruleId === '@typescript-eslint/no-require-imports')
    .map(({ file }) => file);

test('a CommonJS file (.cjs or .cts) may call require(), its only import form', async () => {
  // Arrange: an Electron Forge hook, which Forge loads with require().
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
    ),
    'src/signing-hook.cjs': [
      `const { join } = require('node:path');`,
      `module.exports = () => join('out', 'app.exe');`,
      ``,
    ].join('\n'),
    'src/signing-hook.cts': [
      `const { join } = require('node:path');`,
      `module.exports = () => join('out', 'app.exe');`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(requireAt(findings), []);
});

test('an ES module file still may not call require()', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
    ),
    'src/paths.ts': [
      `export const out = require('node:path').join('out');`,
      ``,
    ].join('\n'),
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  assert.deepEqual(requireAt(findings), [workspace.path('src/paths.ts')]);
});

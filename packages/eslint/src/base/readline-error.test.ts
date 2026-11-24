import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

// The real @types/node of this workspace, so the fixture sees net.Socket.
const typeRoots = [
  dirname(
    dirname(createRequire(import.meta.url).resolve('@types/node/package.json')),
  ),
];

const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'esnext',
    module: 'nodenext',
    types: ['node'],
    typeRoots,
  },
  include: ['**/*.ts'],
});

const coordinator = [
  `import { createServer } from 'node:net';`,
  `import { createInterface } from 'node:readline';`,
  `export const server = createServer((peer) => {`,
  `  peer.on('error', () => {});`,
  `  createInterface({ input: peer }).once('line', () => peer.destroy());`,
  `});`,
  ``,
].join('\n');

test('base reports a readline interface over a socket with no error listener in shipped code, tests and test helpers', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'tsconfig.json': tsconfig,
    'eslint.config.mjs': fixtureConfig(
      `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
    ),
    'src/coordinator.ts': coordinator,
    'src/coordinator.test.ts': coordinator,
    'src/testing/coordinator.ts': coordinator,
  });

  // Act
  const findings = lint(workspace.root, ['src']);

  // Assert
  const reported = findings
    .filter(({ ruleId }) => ruleId === 'zukhruf/no-unhandled-readline-error')
    .map(({ file }) => file.slice(workspace.root.length + 1))
    .toSorted();
  assert.deepEqual(reported, [
    'src/coordinator.test.ts',
    'src/coordinator.ts',
    'src/testing/coordinator.ts',
  ]);
});

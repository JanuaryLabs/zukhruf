import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { describe, test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { nodeTypeRoots } from '../testing/node-type-roots.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

const tsconfig = JSON.stringify({
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: 'esnext',
    module: 'nodenext',
    types: ['node'],
    typeRoots: nodeTypeRoots,
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

// Each test starts processes of its own over a workspace of its own, so the
// tests run at the same time, as many as this machine's processors.
describe('readline-error', { concurrency: availableParallelism() }, () => {
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
    const findings = await lint(workspace.root, ['src']);

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
});

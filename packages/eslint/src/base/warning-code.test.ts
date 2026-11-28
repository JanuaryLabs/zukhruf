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

const giveBack = [
  `export async function giveBack(release: () => Promise<void>) {`,
  `  try {`,
  `    await release();`,
  `  } catch (error) {`,
  `    process.emitWarning(Error.isError(error) ? error : new Error(String(error), { cause: error }));`,
  `  }`,
  `}`,
  ``,
].join('\n');

// Each test starts processes of its own over a workspace of its own, so the
// tests run at the same time, as many as this machine's processors.
describe('warning-code', { concurrency: availableParallelism() }, () => {
  test('base reports a process warning with no code in shipped code, tests and test helpers', async () => {
    // Arrange
    await using workspace = await fixtureWorkspace({
      'nx.json': '{}',
      'tsconfig.json': tsconfig,
      'eslint.config.mjs': fixtureConfig(
        `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
      ),
      'src/give-back.ts': giveBack,
      'src/give-back.test.ts': giveBack,
      'src/testing/give-back.ts': giveBack,
    });

    // Act
    const findings = await lint(workspace.root, ['src']);

    // Assert
    const reported = findings
      .filter(({ ruleId }) => ruleId === 'zukhruf/require-warning-code')
      .map(({ file }) => file.slice(workspace.root.length + 1))
      .toSorted();
    assert.deepEqual(reported, [
      'src/give-back.test.ts',
      'src/give-back.ts',
      'src/testing/give-back.ts',
    ]);
  });
});

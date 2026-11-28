import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { describe, test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

// `types: []` keeps the fixture from loading @types the temporary folder does
// not have; `esnext` brings Symbol.asyncDispose.
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

// The shape of a bug that shipped in git-hooks: the snapshots of `await using`
// were disposed while the steps that use them still ran.
const runner = (returned: string) =>
  [
    `const work = async (): Promise<number> => 1;`,
    `export async function run(): Promise<number> {`,
    `  await using resource = { async [Symbol.asyncDispose]() {} };`,
    `  void resource;`,
    `  return ${returned};`,
    `}`,
    ``,
  ].join('\n');

// Each test starts processes of its own over a workspace of its own, so the
// tests run at the same time, as many as this machine's processors.
describe('return-await', { concurrency: availableParallelism() }, () => {
  test('base reports a promise returned without await inside an await using scope, and passes it awaited', async () => {
    // Arrange
    await using workspace = await fixtureWorkspace({
      'nx.json': '{}',
      'tsconfig.json': tsconfig,
      'eslint.config.mjs': fixtureConfig(
        `{ plugins: { zukhruf }, extends: ['zukhruf/base'] }`,
      ),
      'src/unawaited.ts': runner('work()'),
      'src/awaited.ts': runner('await work()'),
    });

    // Act
    const findings = await lint(workspace.root, ['src']);

    // Assert
    const returnAwait = findings
      .filter(({ ruleId }) => ruleId === '@typescript-eslint/return-await')
      .map(({ file }) => file.split('/').pop());
    assert.deepEqual(returnAwait, ['unawaited.ts']);
  });
});

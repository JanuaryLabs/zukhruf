import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';

import { describe, test } from '@zukhruf/parameterized-test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, printConfig } from '../testing/run-eslint.ts';
import { isRecord } from '../unknown-values.ts';

// Each test starts processes of its own over a workspace of its own, so the
// tests run at the same time, as many as this machine's processors.
describe('config', { concurrency: availableParallelism() }, () => {
  void test.each(
    [
      { rule: 'prefer-each', as: 'an error', severity: 2 },
      { rule: 'no-tabular-test', as: 'an error', severity: 2 },
    ],
    ({ rule, as, severity }) =>
      test(`the tests config turns ${rule} on as ${as} for a test file`, async () => {
        // Arrange
        await using workspace = await fixtureWorkspace({
          'nx.json': '{}',
          'tsconfig.json': JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, types: [] },
            include: ['**/*.ts'],
          }),
          'eslint.config.mjs': fixtureConfig(
            `{ plugins: { zukhruf }, extends: ['zukhruf/base', 'zukhruf/tests'] }`,
          ),
          'src/sum.test.ts': `export {};\n`,
        });

        // Act
        const config = await printConfig(workspace.root, 'src/sum.test.ts');

        // Assert
        const rules = isRecord(config) ? config['rules'] : undefined;
        const entry = isRecord(rules) ? rules[`zukhruf/${rule}`] : undefined;
        assert.deepEqual(entry, [severity]);
      }),
  );
});

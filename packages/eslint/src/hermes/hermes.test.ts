import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { describe, test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

// Each test starts processes of its own over a workspace of its own, so the
// tests run at the same time, as many as this machine's processors.
describe('hermes', { concurrency: availableParallelism() }, () => {
  test('hermes/recommended flags what Hermes lacks in app code, and leaves Node-side files alone', async () => {
    // Arrange
    await using workspace = await fixtureWorkspace({
      'nx.json': '{}',
      'eslint.config.mjs': fixtureConfig(`{
      plugins: { hermes },
      extends: ['hermes/recommended'],
    }`),
      'src/app.js': [
        `import { createHash } from 'crypto';`,
        `export const list = new Intl.ListFormat('en').format(['a', 'b']);`,
        `export const plural = new Intl.PluralRules('en').select(1);`,
        `export const amount = new Intl.NumberFormat('en').format(1);`,
        `export const short = new Intl.NumberFormat('en', { notation: 'compact' }).format(44000);`,
        `console.dir(createHash);`,
        `console.log('ready');`,
      ].join('\n'),
      'metro.config.js': `import { join } from 'node:path';\nconsole.dir(join);\n`,
      'scripts/release.js': `import { readFileSync } from 'node:fs';\nreadFileSync;\n`,
    });

    // Act
    const findings = await lint(workspace.root, ['.']);

    // Assert
    const ruleIds = findings.map(({ ruleId }) => ruleId).sort();
    assert.deepEqual(ruleIds, [
      'es-x/no-intl-listformat',
      'es-x/no-intl-pluralrules',
      'hermes/no-compact-notation',
      'hermes/no-missing-console',
      'import-x/no-nodejs-modules',
    ]);
    assert.deepEqual(
      new Set(findings.map(({ file }) => file)),
      new Set([workspace.path('src/app.js')]),
    );
  });
});

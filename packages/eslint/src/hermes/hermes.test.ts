import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

test('hermes/recommended flags what Hermes lacks in app code, and leaves Node-side files alone', () => {
  // Arrange
  using workspace = fixtureWorkspace({
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
      `console.dir(createHash);`,
      `console.log('ready');`,
    ].join('\n'),
    'metro.config.js': `import { join } from 'node:path';\nconsole.dir(join);\n`,
    'scripts/release.js': `import { readFileSync } from 'node:fs';\nreadFileSync;\n`,
  });

  // Act
  const findings = lint(workspace.root, ['.']);

  // Assert
  const ruleIds = findings.map(({ ruleId }) => ruleId).sort();
  assert.deepEqual(ruleIds, [
    'es-x/no-intl-listformat',
    'es-x/no-intl-pluralrules',
    'hermes/no-missing-console',
    'import-x/no-nodejs-modules',
  ]);
  assert.ok(findings.every(({ file }) => file.endsWith('/src/app.js')));
});

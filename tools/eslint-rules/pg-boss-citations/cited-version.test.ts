import { test } from 'node:test';

import { RuleTester } from 'eslint';
import * as jsonc from 'jsonc-eslint-parser';

import rule from './cited-version.ts';
import { fixtureWorkspace } from './testing/fixture-workspace.ts';

const manifest = (pin: string) =>
  JSON.stringify({ name: '@acme/queue', dependencies: { 'pg-boss': pin } });

test('a pin that differs from the version the citations name is reported at the pin, with both versions', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'queue/pg-boss-citations.json': JSON.stringify({ 'pg-boss': '12.38.2' }),
  });
  const ruleTester = new RuleTester({ languageOptions: { parser: jsonc } });

  // Act + Assert
  ruleTester.run('cited-version', rule, {
    valid: [],
    invalid: [
      {
        code: manifest('12.39.0'),
        filename: workspace.path('queue/package.json'),
        errors: [
          {
            messageId: 'cited',
            data: { pinned: '12.39.0', cited: '12.38.2' },
            line: 1,
            column: 39,
          },
        ],
      },
    ],
  });
});

test('a pin with no record beside the package.json is reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'queue/README.md': '',
    'pg-boss-citations.json': JSON.stringify({ 'pg-boss': '12.39.0' }),
  });
  const ruleTester = new RuleTester({ languageOptions: { parser: jsonc } });

  // Act + Assert
  ruleTester.run('cited-version', rule, {
    valid: [],
    invalid: [
      {
        code: manifest('12.39.0'),
        filename: workspace.path('queue/package.json'),
        errors: [{ messageId: 'unrecorded', data: { pinned: '12.39.0' } }],
      },
    ],
  });
});

test('a pin equal to the recorded version passes, and so does a pg-boss that is not a dependency', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'queue/pg-boss-citations.json': JSON.stringify({ 'pg-boss': '12.39.0' }),
  });
  const ruleTester = new RuleTester({ languageOptions: { parser: jsonc } });

  // Act + Assert
  ruleTester.run('cited-version', rule, {
    valid: [
      {
        code: manifest('12.39.0'),
        filename: workspace.path('queue/package.json'),
      },
      {
        code: JSON.stringify({
          name: '@acme/queue',
          peerDependencies: { 'pg-boss': '12.38.2' },
          scripts: { 'pg-boss': '12.38.2' },
        }),
        filename: workspace.path('queue/package.json'),
      },
    ],
    invalid: [],
  });
});

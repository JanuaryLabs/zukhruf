import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { jsonRuleTester } from '../testing/rule-tester.ts';
import rule from './no-duplicate-nx-key.ts';

const ruleTester = jsonRuleTester();

test('a project.json key that the nx key of the package.json beside it also sets is reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'packages/lib/package.json': JSON.stringify({
      name: '@acme/lib',
      nx: { tags: ['scope:lib'], targets: { test: {} } },
    }),
  });
  const code = JSON.stringify({
    name: 'lib',
    tags: ['layer:island'],
    targets: { build: { executor: '@nx/js:tsc' } },
  });

  // Act + Assert
  ruleTester.run('no-duplicate-nx-key', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('packages/lib/project.json'),
        errors: [
          { messageId: 'duplicate', data: { key: 'tags' } },
          { messageId: 'duplicate', data: { key: 'targets' } },
        ],
      },
    ],
  });
});

test('a project.json whose keys the nx key does not set passes, and so does one with no nx key or no package.json beside it', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'packages/split/package.json': JSON.stringify({
      name: '@acme/split',
      nx: { tags: ['scope:lib'] },
    }),
    'packages/plain/package.json': JSON.stringify({
      name: '@acme/plain',
      tags: ['not-read-by-nx'],
    }),
  });
  const code = JSON.stringify({ name: 'x', targets: { build: {} } });

  // Act + Assert
  ruleTester.run('no-duplicate-nx-key', rule, {
    valid: [
      { code, filename: workspace.path('packages/split/project.json') },
      { code, filename: workspace.path('packages/plain/project.json') },
      { code, filename: workspace.path('packages/alone/project.json') },
    ],
    invalid: [],
  });
});

test('a package.json beside it that does not parse is left to its own lint', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'packages/broken/package.json': '{ "nx": { "tags": [] ',
  });
  const code = JSON.stringify({ tags: ['scope:lib'] });

  // Act + Assert
  ruleTester.run('no-duplicate-nx-key', rule, {
    valid: [{ code, filename: workspace.path('packages/broken/project.json') }],
    invalid: [],
  });
});

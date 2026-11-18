import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { jsonRuleTester } from '../testing/rule-tester.ts';
import rule from './no-root-script.ts';

const ruleTester = jsonRuleTester();

test('each script of the workspace root package.json other than prepare is reported', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({ 'nx.json': '{}' });
  const code = JSON.stringify({
    name: '@acme/source',
    scripts: {
      prepare: 'husky',
      build: 'nx run-many -t build',
      postinstall: 'node tools/patch.mjs',
    },
  });

  // Act + Assert
  ruleTester.run('no-root-script', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('package.json'),
        errors: [
          { messageId: 'rootScript', data: { script: 'build' } },
          { messageId: 'rootScript', data: { script: 'postinstall' } },
        ],
      },
    ],
  });
});

test('a workspace root found by its workspaces key is checked too', async () => {
  // Arrange
  const code = JSON.stringify({
    workspaces: ['packages/*'],
    scripts: { lint: 'eslint .' },
  });
  await using workspace = await fixtureWorkspace({ 'package.json': code });

  // Act + Assert
  ruleTester.run('no-root-script', rule, {
    valid: [],
    invalid: [
      {
        code,
        filename: workspace.path('package.json'),
        errors: [{ messageId: 'rootScript', data: { script: 'lint' } }],
      },
    ],
  });
});

test('a root with only prepare passes, and so do the scripts of a workspace package or of a package outside any workspace', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({ 'nx.json': '{}' });
  const onlyPrepare = JSON.stringify({ scripts: { prepare: 'husky' } });
  const packageScripts = JSON.stringify({ scripts: { build: 'tsc' } });

  // Act + Assert
  ruleTester.run('no-root-script', rule, {
    valid: [
      { code: onlyPrepare, filename: workspace.path('package.json') },
      {
        code: packageScripts,
        filename: workspace.path('packages/lib/package.json'),
      },
      {
        code: packageScripts,
        filename: join(tmpdir(), 'not-a-workspace', 'package.json'),
      },
    ],
    invalid: [],
  });
});

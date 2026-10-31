import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

import react from './react.ts';
import { fixtureWorkspace } from './testing/fixture-workspace.ts';

test('./react lints a .tsx file on ESLint 10 and reports a prop given twice', async () => {
  // Arrange
  // flat/react sets @typescript-eslint rules but leaves the plugin to the
  // workspace's TypeScript config.
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [tseslint.configs.base, ...react],
  });
  const code = 'export const Box = () => <div id="one" id="two" />;\n';

  // Act
  const [result] = await eslint.lintText(code, { filePath: 'box.tsx' });

  // Assert
  assert.deepEqual(
    result?.messages.map((message) => message.ruleId),
    ['react/jsx-no-duplicate-props'],
  );
});

test('./react sets the React version to the react package that is installed', () => {
  // Arrange
  const installed: unknown = createRequire(import.meta.url)(
    'react/package.json',
  );
  assert.ok(installed !== null && typeof installed === 'object');

  // Act
  const versions = react.flatMap((config) => {
    const settings = config.settings?.['react'];
    return settings !== null && typeof settings === 'object'
      ? [Reflect.get(settings, 'version')]
      : [];
  });

  // Assert
  assert.deepEqual(versions, [Reflect.get(installed, 'version')]);
});

test('./react throws an error that names react when react is not installed', async () => {
  // Arrange
  await using workspace = await fixtureWorkspace({ 'package.json': '{}' });

  // Act
  const run = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(import.meta.resolve('@zukhruf/eslint/react'))});`,
    ],
    { cwd: workspace.root, encoding: 'utf8' },
  );

  // Assert
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /needs the react package/);
});

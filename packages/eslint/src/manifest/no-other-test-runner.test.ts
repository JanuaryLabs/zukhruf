import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixtureWorkspace } from '../testing/fixture-workspace.ts';
import { fixtureConfig, lint } from '../testing/run-eslint.ts';

/** Lints `libs/greet/package.json`, a private project below the workspace root, with `manifest/recommended`. */
async function lintManifest(manifest: Record<string, unknown>) {
  await using workspace = await fixtureWorkspace({
    'nx.json': '{}',
    'package.json': JSON.stringify({ name: 'fx', private: true }),
    'eslint.config.mjs': fixtureConfig(`{
      plugins: { manifest },
      extends: ['manifest/recommended'],
    }`),
    'libs/greet/package.json': JSON.stringify({
      name: '@fx/greet',
      version: '0.0.0',
      private: true,
      ...manifest,
    }),
  });
  return await lint(workspace.root, ['libs/greet/package.json']);
}

test('each runner, the types of its globals, and jest-expo in devDependencies are reported', async () => {
  // Act
  const findings = await lintManifest({
    devDependencies: {
      jest: '^30.0.0',
      '@jest/globals': '^30.0.0',
      mocha: '^11.0.0',
      '@types/jest': '^30.0.0',
      '@types/mocha': '^10.0.0',
      'jest-expo': '^54.0.0',
    },
  });

  // Assert
  assert.deepEqual(
    findings.map(({ ruleId, message }) => [
      ruleId,
      /lists (\S+), a test runner/.exec(message)?.[1],
    ]),
    [
      ['manifest/no-other-test-runner', 'jest'],
      ['manifest/no-other-test-runner', '@jest/globals'],
      ['manifest/no-other-test-runner', 'mocha'],
      ['manifest/no-other-test-runner', '@types/jest'],
      ['manifest/no-other-test-runner', '@types/mocha'],
      ['manifest/no-other-test-runner', 'jest-expo'],
    ],
  );
  assert.match(
    findings[0]?.message ?? '',
    /^devDependencies lists jest,.*Use node:test, or Vitest in a Vite app\.$/,
  );
});

test('a runner in dependencies, optionalDependencies or peerDependencies is reported with its section', async () => {
  // Act
  const findings = await lintManifest({
    dependencies: { mocha: '^11.0.0' },
    optionalDependencies: { jasmine: '^5.0.0' },
    peerDependencies: { jest: '>=29' },
  });

  // Assert
  assert.deepEqual(
    findings.map(({ message }) => /^(\S+ lists \S+),/.exec(message)?.[1]),
    [
      'dependencies lists mocha',
      'optionalDependencies lists jasmine',
      'peerDependencies lists jest',
    ],
  );
});

test('vitest, @types/node and a package whose name only starts like a runner are not reported', async () => {
  // Act
  const findings = await lintManifest({
    devDependencies: {
      vitest: '^4.0.0',
      '@types/node': '^24.0.0',
      tapable: '^2.0.0',
    },
  });

  // Assert
  assert.deepEqual(findings, []);
});

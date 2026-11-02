import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { repository } from './testing/pre-commit-repository.ts';

const dependencyChecksOnly = `import { DependencyChecks, preCommit } from '@zukhruf/git-hooks';
await preCommit([new DependencyChecks()]);
`;

// The repo's ESLint config: a package.json that names the dependency "left-pad"
// breaks its lint, the way an undeclared or banned dependency breaks
// dependency-checks.
const eslintConfig = `import * as jsonc from '${import.meta.resolve('jsonc-eslint-parser')}';

export default [
  {
    files: ['**/package.json'],
    languageOptions: { parser: jsonc },
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "JSONProperty[key.value='left-pad']", message: 'left-pad is not allowed' },
      ],
    },
  },
];
`;

const banned = `${JSON.stringify({ name: 'a', dependencies: { 'left-pad': '^1.0.0' } }, null, 2)}\n`;
const clean = `${JSON.stringify({ name: 'a', dependencies: {} }, null, 2)}\n`;

async function workspace(root: string) {
  const repo = await repository(root, dependencyChecksOnly);
  await repo.write('eslint.config.mjs', eslintConfig);
  await mkdir(join(root, 'packages/a/src'), { recursive: true });
  await mkdir(join(root, 'packages/b/src'), { recursive: true });
  return repo;
}

test('a commit that touches a project whose package.json breaks the repo lint is stopped, and the hook names the manifest and the rule', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path);
  await repo.write('packages/a/package.json', banned);
  await repo.write('packages/a/src/index.ts', 'export const a = 1;\n');
  await repo.git('add', '.');

  // Act
  const result = await repo.commit('touch a');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /packages\/a\/package\.json:\d+/);
  assert.match(result.stderr, /left-pad is not allowed/);
});

test("a commit that touches only a clean project passes, though another project's package.json breaks the lint", async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path);
  await repo.write('packages/a/package.json', clean);
  await repo.write('packages/b/package.json', banned);
  await repo.write('packages/b/src/index.ts', 'export const b = 1;\n');
  await repo.git('add', '.');
  await repo.git('commit', '--no-verify', '--quiet', '-m', 'base');
  await repo.write('packages/a/src/index.ts', 'export const a = 1;\n');
  await repo.git('add', 'packages/a/src/index.ts');

  // Act
  const result = await repo.commit('touch a only');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});

test('the staged copy of a package.json is judged, not the working tree', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path);
  await repo.write('packages/a/package.json', clean);
  await repo.write('packages/a/src/index.ts', 'export const a = 1;\n');
  await repo.git('add', '.');
  await repo.write('packages/a/package.json', banned);

  // Act
  const result = await repo.commit('stage the clean manifest');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});

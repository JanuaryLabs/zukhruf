import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { repository } from './testing/pre-commit-repository.ts';
import { toolPackages } from './testing/tool-packages.ts';

const workflowChecksOnly = `import { WorkflowChecks, preCommit } from '@zukhruf/git-hooks';
await preCommit([new WorkflowChecks()]);
`;

// The repo's ESLint config: a step that runs `npm ci` breaks the lint of a
// workflow, the way a hand install breaks zukhruf/no-manual-workspace-install.
const eslintConfig = `import * as yaml from '${import.meta.resolve('yaml-eslint-parser')}';

export default [
  {
    files: ['**/.github/**/*.{yml,yaml}'],
    languageOptions: { parser: yaml },
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "YAMLPair[key.value='run'][value.value=/npm ci/]", message: 'npm ci is not allowed' },
      ],
    },
  },
];
`;

const banned = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
`;
const clean = `on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npx nx affected -t test
`;

async function workspace(root: string) {
  const repo = await repository(root, workflowChecksOnly);
  await toolPackages(root, ['eslint']);
  await repo.write('.gitignore', 'node_modules\n');
  await repo.git('add', 'package-lock.json', '.gitignore');
  await repo.write('eslint.config.mjs', eslintConfig);
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  return repo;
}

test('a commit that stages a workflow which breaks the repo lint is stopped, and the hook names the workflow, the line and the message', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path);
  await repo.write('.github/workflows/ci.yml', banned);
  await repo.git('add', '.');

  // Act
  const result = await repo.commit('add ci');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /\.github\/workflows\/ci\.yml:6 /);
  assert.match(result.stderr, /npm ci is not allowed/);
});

test('a commit that stages no workflow passes, though a committed workflow breaks the lint', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path);
  await repo.write('.github/workflows/ci.yml', banned);
  await repo.git('add', '.');
  await repo.git('commit', '--no-verify', '--quiet', '-m', 'base');
  await repo.write('src/index.ts', 'export const a = 1;\n');
  await repo.git('add', 'src/index.ts');

  // Act
  const result = await repo.commit('touch the source only');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});

test('the staged copy of a workflow is judged, not the working tree', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path);
  await repo.write('.github/workflows/ci.yml', clean);
  await repo.git('add', '.');
  await repo.write('.github/workflows/ci.yml', banned);

  // Act
  const result = await repo.commit('stage the clean workflow');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});

test('a commit that deletes a workflow passes', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path);
  await repo.write('.github/workflows/ci.yml', banned);
  await repo.write('.github/workflows/old.yml', clean);
  await repo.git('add', '.');
  await repo.git('commit', '--no-verify', '--quiet', '-m', 'base');
  await repo.git('rm', '--quiet', '.github/workflows/old.yml');

  // Act
  const result = await repo.commit('delete old');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});

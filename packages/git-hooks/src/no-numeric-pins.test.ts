import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { repository } from './testing/pre-commit-repository.ts';

const pinsOnly = `import { NoNumericPins, preCommit } from '@zukhruf/git-hooks';
await preCommit([new NoNumericPins()]);
`;

test('a commit that pins Node by number in .nvmrc, a workflow or a Dockerfile is stopped, and the hook names each line', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, pinsOnly);
  await mkdir(join(repo.root, '.github/workflows'), { recursive: true });
  await repo.write('.nvmrc', '22\n');
  await repo.write(
    '.github/workflows/ci.yml',
    "jobs:\n  ci:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '22.x'\n",
  );
  await repo.write('Dockerfile', 'FROM node:22-alpine\nRUN npm ci\n');
  await repo.git('add', '.');

  // Act
  const result = await repo.commit('pin node');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /\.nvmrc:1/);
  assert.match(result.stderr, /\.github\/workflows\/ci\.yml:6/);
  assert.match(result.stderr, /Dockerfile:1/);
  assert.match(result.stderr, /lts\/\*/);
});

test('a commit that pins npm by number, or sets engines, is stopped', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, pinsOnly);
  await mkdir(join(repo.root, '.github/workflows'), { recursive: true });
  await repo.write(
    'package.json',
    `${JSON.stringify(
      {
        type: 'module',
        engines: { node: '>=22', npm: '>=11' },
        packageManager: 'npm@11.0.0',
        allowScripts: { 'esbuild@0.25.0': true },
      },
      null,
      2,
    )}\n`,
  );
  await repo.write(
    '.github/workflows/release.yml',
    'jobs:\n  release:\n    steps:\n      - run: npm install -g npm@11\n',
  );
  await repo.git('add', '.');

  // Act
  const result = await repo.commit('pin npm');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /package\.json.*engines\.node/);
  assert.match(result.stderr, /package\.json.*engines\.npm/);
  assert.match(result.stderr, /package\.json.*packageManager/);
  assert.match(result.stderr, /package\.json.*esbuild@0\.25\.0/);
  assert.match(result.stderr, /release\.yml:4/);
});

test('a commit with lts aliases, npm@latest, an @types/node range and the known exceptions passes', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, pinsOnly);
  await mkdir(join(repo.root, '.github/workflows'), { recursive: true });
  await mkdir(join(repo.root, 'docs'));
  await repo.write('.nvmrc', 'lts/*\n');
  await repo.write(
    '.github/workflows/ci.yml',
    'jobs:\n  ci:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: lts/*\n      - run: npm install -g npm@latest\n',
  );
  await repo.write('Dockerfile', 'FROM node:lts-alpine\nRUN npm ci\n');
  await repo.write(
    'package.json',
    `${JSON.stringify({ type: 'module', devDependencies: { '@types/node': '^24.0.0' } }, null, 2)}\n`,
  );
  await repo.write(
    'eas.json',
    `${JSON.stringify({ build: { base: { node: '24.11.0' } } }, null, 2)}\n`,
  );
  await repo.write(
    'package-lock.json',
    `${JSON.stringify({ packages: { 'node_modules/esbuild': { engines: { node: '>=18' } } } }, null, 2)}\n`,
  );
  await mkdir(join(repo.root, 'extension'));
  await repo.write(
    'extension/package.json',
    `${JSON.stringify({ engines: { vscode: '^1.85.0' } }, null, 2)}\n`,
  );
  await repo.write(
    'docs/plan.md',
    'On 2026-10-29 the CI image still ran node 22.\n',
  );
  await repo.git('add', '.');

  // Act
  const result = await repo.commit('lts everywhere');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});

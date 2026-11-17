import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { repository } from './testing/pre-commit-repository.ts';

const lockfileOnly = `import { LockfileSync, preCommit } from '@zukhruf/git-hooks';
await preCommit([new LockfileSync()]);
`;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// npm writes the lockfile of the repo. A workspace needs no registry.
function lock(root: string) {
  execFileSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--offline',
    ],
    { cwd: root },
  );
}

// An npm workspace with one package, packages/a, and the lockfile that npm
// writes for it, committed without the hook.
async function workspace(root: string) {
  const repo = await repository(root, lockfileOnly);
  await mkdir(join(root, 'packages/a'), { recursive: true });
  await repo.write(
    'package.json',
    json({
      name: 'probe',
      private: true,
      type: 'module',
      workspaces: ['packages/*'],
    }),
  );
  await repo.write(
    'packages/a/package.json',
    json({ name: 'a', version: '1.0.0' }),
  );
  await repo.write('.gitignore', 'node_modules\n');
  lock(root);
  await repo.git('add', '.');
  await repo.git('commit', '--no-verify', '--quiet', '-m', 'base');
  return repo;
}

test('a new workspace package without its lockfile entry is stopped, with the lines of npm ci', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path);
  await mkdir(join(repo.root, 'packages/b'));
  await repo.write(
    'packages/b/package.json',
    json({ name: 'b', version: '1.0.0' }),
  );
  await repo.git('add', 'packages/b/package.json');

  // Act
  const result = await repo.commit('add b without the lockfile');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /npm ci does not accept/);
  assert.match(result.stderr, /Missing: b@1\.0\.0 from lock file/);
});

test('a range edit that npm ci accepts is stopped, because the lockfile keeps the old range', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, lockfileOnly);
  await repo.write(
    'package.json',
    json({ name: 'probe', dependencies: { 'left-pad': '^1.0.0' } }),
  );
  // As npm writes it after `npm install left-pad@^1.0.0`; no registry here.
  await repo.write(
    'package-lock.json',
    json({
      name: 'probe',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'probe', dependencies: { 'left-pad': '^1.0.0' } },
        'node_modules/left-pad': {
          version: '1.3.0',
          resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
          integrity:
            'sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQEbP7qtGhMhQ0QgIP/vdkgm8yT+hjNyaLkaF0hCVUG4TBAg==',
        },
      },
    }),
  );
  await repo.git('add', '.');
  await repo.git('commit', '--no-verify', '--quiet', '-m', 'base');
  await repo.write(
    'package.json',
    json({ name: 'probe', dependencies: { 'left-pad': '^1.2.0' } }),
  );
  await repo.git('add', 'package.json');

  // Act
  const result = await repo.commit('raise the range');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /package\.json {2}dependencies\.left-pad: \^1\.2\.0 in package\.json, \^1\.0\.0 in package-lock\.json/,
  );
});

test('a commit of package.json alone through git commit --only is stopped when its lockfile is not in the commit', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path);
  await repo.write(
    'packages/a/package.json',
    json({ name: 'a', version: '1.0.0', dependencies: { b: '*' } }),
  );
  await mkdir(join(repo.root, 'packages/b'));
  await repo.write(
    'packages/b/package.json',
    json({ name: 'b', version: '1.0.0' }),
  );
  lock(repo.root);

  // Act
  const result = await repo.commitWith(
    [],
    'a needs b',
    '--only',
    '--',
    'packages/a/package.json',
  );

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /packages\/a\/package\.json {2}dependencies\.b: \* in package\.json, absent in package-lock\.json/,
  );
});

test('a new workspace package that another one depends on, with its lockfile entries, passes, and a commit without a package.json, package-lock.json or .npmrc skips', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path);
  await mkdir(join(repo.root, 'packages/b'));
  await repo.write(
    'packages/b/package.json',
    json({ name: 'b', version: '1.0.0' }),
  );
  await repo.write(
    'packages/a/package.json',
    json({ name: 'a', version: '1.0.0', dependencies: { b: '*' } }),
  );
  lock(repo.root);
  await repo.git('add', '.');

  // Act
  const made = await repo.commit('add b with the lockfile');
  await repo.write('notes.txt', 'no package here\n');
  await repo.git('add', 'notes.txt');
  const skipped = await repo.commit('notes');

  // Assert
  assert.equal(made.code, 0, made.stderr);
  assert.match(
    made.stderr,
    /package-lock\.json records each staged package\.json/,
  );
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.match(
    skipped.stderr,
    /no package\.json, package-lock\.json or \.npmrc/,
  );
});

test('a commit that deletes package-lock.json and keeps package.json is stopped', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path);
  await repo.git('rm', '--quiet', 'package-lock.json');

  // Act
  const result = await repo.commit('drop the lockfile');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /a package\.json but no package-lock\.json/);
});

test('a staged package.json that is not JSON is stopped, and the hook names it without a stack trace', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await workspace(folder.path);
  await repo.write('packages/a/package.json', '{ "name": "a",\n');
  await repo.git('add', 'packages/a/package.json');

  // Act
  const result = await repo.commit('broken manifest');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /packages\/a\/package\.json {2}is not JSON/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

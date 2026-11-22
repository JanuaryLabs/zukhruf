import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { repository } from './testing/pre-commit-repository.ts';

const defaults = `import { NoOutsideLinks, preCommit } from '@zukhruf/git-hooks';
await preCommit([new NoOutsideLinks()]);
`;

// A package folder at `folder`, as a checkout of another repo holds it.
async function packageAt(folder: string, name: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, 'package.json'),
    JSON.stringify({ name, version: '1.0.0' }),
  );
}

test('a lockfile that links a package from another checkout is stopped, and the hook names the package and its target', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, defaults);
  // As npm writes it after `npm link ../elt/packages/core`.
  await repo.write(
    'package-lock.json',
    `${JSON.stringify({
      name: 'probe',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'probe' },
        'node_modules/@eltjs/core': {
          resolved: '../elt/packages/core',
          link: true,
        },
        '../elt/packages/core': { name: '@eltjs/core', version: '1.0.0' },
      },
    })}\n`,
  );
  await repo.git('add', 'package-lock.json');

  // Act
  const result = await repo.commit('link elt');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /@eltjs\/core -> \.\.\/elt\/packages\/core/);
  assert.match(
    result.stderr,
    /push the package \(a push to its main releases it\), then npm install the published version/,
  );
});

test('an installed package that is a link to a folder outside the repo is stopped, in the root and in a workspace', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  await using other = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, defaults);
  await repo.write(
    'package.json',
    JSON.stringify({ type: 'module', workspaces: ['packages/*'] }),
  );
  await repo.write('.gitignore', 'node_modules\n');
  await packageAt(join(repo.root, 'packages/a'), 'a');
  await packageAt(join(other.path, 'eslint'), '@zukhruf/eslint');
  await packageAt(join(other.path, 'nx'), 'nx-plugin');
  await mkdir(join(repo.root, 'node_modules/@zukhruf'), { recursive: true });
  await symlink(
    join(other.path, 'eslint'),
    join(repo.root, 'node_modules/@zukhruf/eslint'),
  );
  await mkdir(join(repo.root, 'packages/a/node_modules'));
  await symlink(
    join(other.path, 'nx'),
    join(repo.root, 'packages/a/node_modules/nx-plugin'),
  );
  await repo.git('add', '.');

  // Act
  const result = await repo.commit('linked by hand');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /node_modules\/@zukhruf\/eslint -> .*eslint/);
  assert.match(result.stderr, /packages\/a\/node_modules\/nx-plugin -> .*nx/);
});

test('workspace links that point inside the repo pass', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, defaults);
  await repo.write(
    'package.json',
    JSON.stringify({ type: 'module', workspaces: ['packages/*'] }),
  );
  await repo.write('.gitignore', 'node_modules\n');
  await packageAt(join(repo.root, 'packages/a'), '@probe/a');
  await mkdir(join(repo.root, 'node_modules/@probe'), { recursive: true });
  await symlink('../../packages/a', join(repo.root, 'node_modules/@probe/a'));
  await repo.write(
    'package-lock.json',
    `${JSON.stringify({
      name: 'probe',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'probe' },
        'node_modules/@probe/a': { resolved: 'packages/a', link: true },
        'packages/a': { name: '@probe/a', version: '1.0.0' },
      },
    })}\n`,
  );
  await repo.git('add', '.');

  // Act
  const result = await repo.commit('workspace');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});

test('a package that allowed names may link to another checkout, in the lockfile and in node_modules', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  await using other = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(
    folder.path,
    `import { NoOutsideLinks, preCommit } from '@zukhruf/git-hooks';
await preCommit([new NoOutsideLinks({ allowed: ['@eltjs/*'] })]);
`,
  );
  await repo.write('.gitignore', 'node_modules\n');
  await packageAt(join(other.path, 'core'), '@eltjs/core');
  await mkdir(join(repo.root, 'node_modules/@eltjs'), { recursive: true });
  await symlink(
    join(other.path, 'core'),
    join(repo.root, 'node_modules/@eltjs/core'),
  );
  await repo.write(
    'package-lock.json',
    `${JSON.stringify({
      name: 'probe',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'probe' },
        'node_modules/@eltjs/core': {
          resolved: '../elt/packages/core',
          link: true,
        },
        '../elt/packages/core': { name: '@eltjs/core', version: '1.0.0' },
      },
    })}\n`,
  );
  await repo.git('add', '.');

  // Act
  const result = await repo.commit('elt stays linked');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});

test('a link to a checkout that no longer exists is stopped, and the hook names the folder that it named', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  await using other = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, defaults);
  await repo.write('.gitignore', 'node_modules\n');
  await mkdir(join(repo.root, 'node_modules'));
  await symlink(
    join(other.path, 'moved'),
    join(repo.root, 'node_modules/moved'),
  );
  await repo.git('add', '.');

  // Act
  const result = await repo.commit('dangling link');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /node_modules\/moved -> .*moved/);
});

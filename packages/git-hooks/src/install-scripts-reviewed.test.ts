import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { repository } from './testing/pre-commit-repository.ts';

const hook = `import { InstallScriptsReviewed, preCommit } from '@zukhruf/git-hooks';
await preCommit([new InstallScriptsReviewed()]);
`;

// A package-lock.json with these entries in `packages`, under the root.
function lockfile(packages: Record<string, object>): string {
  return `${JSON.stringify(
    {
      name: 'probe',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'probe' }, ...packages },
    },
    null,
    2,
  )}\n`;
}

// A root package.json that the hook can run under, with this allowScripts.
function manifest(allowScripts?: Record<string, boolean>): string {
  return `${JSON.stringify({ type: 'module', allowScripts }, null, 2)}\n`;
}

const registry = (name: string, version: string) =>
  `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;

test('a package with an install script that fits only Linux is stopped without an allowScripts key, and the hook names its folder and its platform', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, hook);
  await repo.write('package.json', manifest({ esbuild: true }));
  await repo.write(
    'package-lock.json',
    lockfile({
      'node_modules/esbuild': {
        version: '0.25.0',
        resolved: registry('esbuild', '0.25.0'),
        hasInstallScript: true,
      },
      'node_modules/linux-probe': {
        version: '1.0.0',
        resolved: registry('linux-probe', '1.0.0'),
        hasInstallScript: true,
        optional: true,
        os: ['linux'],
        cpu: ['x64'],
      },
    }),
  );
  await repo.git('add', 'package.json', 'package-lock.json');

  // Act
  const result = await repo.commit('a linux script');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    / linux-probe\n +node_modules\/linux-probe {2}\(os: linux; cpu: x64\)/,
  );
  assert.doesNotMatch(result.stderr, / esbuild\n/);
});

test('a key decides a package with true or false, and a key with exact versions decides only the versions it names', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, hook);
  const scripts = lockfile({
    'node_modules/esbuild': {
      version: '0.25.0',
      resolved: registry('esbuild', '0.25.0'),
      hasInstallScript: true,
    },
    'node_modules/nx': {
      version: '22.0.0',
      resolved: registry('nx', '22.0.0'),
      hasInstallScript: true,
    },
  });
  await repo.write('package.json', manifest({ esbuild: true, nx: false }));
  await repo.write('package-lock.json', scripts);
  await repo.git('add', 'package.json', 'package-lock.json');

  // Act
  const made = await repo.commit('both decided');
  await repo.write(
    'package.json',
    manifest({ 'esbuild@0.24.0 || 0.25.0': true, 'nx@21.0.0': false }),
  );
  await repo.git('add', 'package.json');
  const stopped = await repo.commit('nx 22 is not named');

  // Assert
  assert.equal(made.code, 0, made.stderr);
  assert.notEqual(stopped.code, 0);
  assert.match(stopped.stderr, / nx\n +node_modules\/nx\n/);
  assert.doesNotMatch(stopped.stderr, / esbuild\n/);
});

test('a key names the package that an alias folder installs, and a bundled package or a package from git needs no key', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, hook);
  await repo.write('package.json', manifest({ esbuild: true }));
  await repo.write(
    'package-lock.json',
    lockfile({
      'node_modules/esbuild-old': {
        name: 'esbuild',
        version: '0.20.0',
        resolved: registry('esbuild', '0.20.0'),
        hasInstallScript: true,
      },
      'node_modules/carrier': { version: '1.0.0' },
      'node_modules/carrier/node_modules/native': {
        version: '1.0.0',
        hasInstallScript: true,
        inBundle: true,
      },
      'node_modules/forked': {
        version: '1.0.0',
        resolved: 'git+ssh://git@github.com/probe/forked.git#0123456789abcdef',
        hasInstallScript: true,
      },
    }),
  );
  await repo.git('add', 'package.json', 'package-lock.json');

  // Act
  const result = await repo.commit('alias, bundle and git');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});

test('a commit that only removes a key from allowScripts in the root package.json is stopped', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, hook);
  await repo.write('package.json', manifest({ esbuild: true }));
  await repo.write(
    'package-lock.json',
    lockfile({
      'node_modules/esbuild': {
        version: '0.25.0',
        resolved: registry('esbuild', '0.25.0'),
        hasInstallScript: true,
      },
    }),
  );
  await repo.git('add', 'package.json', 'package-lock.json');
  await repo.commit('decided');
  await repo.write('package.json', manifest());
  await repo.git('add', 'package.json');

  // Act
  const result = await repo.commit('the key is gone');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, / esbuild\n +node_modules\/esbuild\n/);
});

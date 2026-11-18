import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { repository } from './testing/pre-commit-repository.ts';

const defaults = `import { OneRuntimeCopy, preCommit } from '@zukhruf/git-hooks';
await preCommit([new OneRuntimeCopy()]);
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

test('a lockfile with a nested copy of react is stopped, and the hook names each folder with its version', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, defaults);
  await repo.write(
    'package-lock.json',
    lockfile({
      'node_modules/react': { version: '19.3.1' },
      'node_modules/devtools/node_modules/react': { version: '18.3.1' },
      'node_modules/devtools': { version: '1.0.0' },
    }),
  );
  await repo.git('add', 'package-lock.json');

  // Act
  const result = await repo.commit('two reacts');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /react has 2 copies/);
  assert.match(result.stderr, /node_modules\/react {2}19\.3\.1/);
  assert.match(
    result.stderr,
    /node_modules\/devtools\/node_modules\/react {2}18\.3\.1/,
  );
});

test('two folders of the same version of zod are two copies, and a workspace link named zod is none', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, defaults);
  await repo.write(
    'package-lock.json',
    lockfile({
      'node_modules/zod': { version: '4.6.7' },
      'packages/api/node_modules/zod': { version: '4.6.7' },
      'node_modules/react': { resolved: 'packages/react', link: true },
      'node_modules/react-dom': { version: '19.3.1' },
    }),
  );
  await repo.git('add', 'package-lock.json');

  // Act
  const result = await repo.commit('same version twice');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /zod has 2 copies/);
  assert.match(result.stderr, /packages\/api\/node_modules\/zod {2}4\.6\.7/);
  assert.doesNotMatch(result.stderr, /react has/);
});

test('an allowed folder is not counted, and an allowed folder that the lockfile no longer has stops the commit', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(
    folder.path,
    `import { OneRuntimeCopy, preCommit } from '@zukhruf/git-hooks';
await preCommit([
  new OneRuntimeCopy({
    allowed: {
      'node_modules/@expo/cli/node_modules/zod': '@expo/cli pins zod 3, and no bundle loads it',
    },
  }),
]);
`,
  );
  await repo.write(
    'package-lock.json',
    lockfile({
      'node_modules/zod': { version: '4.6.7' },
      'node_modules/@expo/cli': { version: '0.24.0' },
      'node_modules/@expo/cli/node_modules/zod': { version: '3.25.76' },
    }),
  );
  await repo.git('add', 'package-lock.json');

  // Act
  const made = await repo.commit('zod 3 under the tool');
  await repo.write(
    'package-lock.json',
    lockfile({ 'node_modules/zod': { version: '4.6.7' } }),
  );
  await repo.git('add', 'package-lock.json');
  const stopped = await repo.commit('the tool is gone');

  // Assert
  assert.equal(made.code, 0, made.stderr);
  assert.notEqual(stopped.code, 0);
  assert.match(
    stopped.stderr,
    /node_modules\/@expo\/cli\/node_modules\/zod is allowed, but package-lock\.json no longer has it/,
  );
});

test('packages replaces the default list, so a second zod passes when only react is named', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(
    folder.path,
    `import { OneRuntimeCopy, preCommit } from '@zukhruf/git-hooks';
await preCommit([new OneRuntimeCopy({ packages: ['react'] })]);
`,
  );
  await repo.write(
    'package-lock.json',
    lockfile({
      'node_modules/react': { version: '19.3.1' },
      'node_modules/zod': { version: '4.6.7' },
      'node_modules/tool/node_modules/zod': { version: '3.25.76' },
    }),
  );
  await repo.git('add', 'package-lock.json');

  // Act
  const result = await repo.commit('zod is not named');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});

test('a commit that does not change package-lock.json is not stopped by the copies that the lockfile already has', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, defaults);
  await repo.write(
    'package-lock.json',
    lockfile({
      'node_modules/react': { version: '19.3.1' },
      'node_modules/devtools/node_modules/react': { version: '18.3.1' },
    }),
  );
  await repo.git('add', 'package-lock.json');
  await repo.commitWith([], 'two reacts, before the hook', '--no-verify');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit('no lockfile change');

  // Assert
  assert.equal(result.code, 0, result.stderr);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { repository } from './testing/pre-commit-repository.ts';

const npmrcOnly = `import { NpmrcPolicy, preCommit } from '@zukhruf/git-hooks';
await preCommit([new NpmrcPolicy()]);
`;

test('a commit without .npmrc is stopped, and the hook names both settings that it needs', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, npmrcOnly);
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit('no npmrc');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no \.npmrc/);
  assert.match(result.stderr, /legacy-peer-deps=false/);
  assert.match(result.stderr, /strict-allow-scripts=true/);
});

test('legacy-peer-deps=true is stopped without a comment above it that names a backlog item, and passes with one', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, npmrcOnly);
  await repo.write(
    '.npmrc',
    '# express 5 against a peer of express 4\n\nlegacy-peer-deps=true\nstrict-allow-scripts=true\n',
  );
  await repo.git('add', '.npmrc');

  // Act
  const stopped = await repo.commit('true without its item');
  await repo.write(
    '.npmrc',
    '# express 5 against a peer of express 4 (#2394)\nlegacy-peer-deps=true\nstrict-allow-scripts=true\n',
  );
  await repo.git('add', '.npmrc');
  const made = await repo.commit('true under its item');

  // Assert
  assert.notEqual(stopped.code, 0);
  assert.match(
    stopped.stderr,
    /\.npmrc {2}legacy-peer-deps=true without a comment above it/,
  );
  assert.equal(made.code, 0, made.stderr);
});

test('an .npmrc without strict-allow-scripts=true is stopped', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, npmrcOnly);
  await repo.write(
    '.npmrc',
    'legacy-peer-deps=false\nstrict-allow-scripts=false\n',
  );
  await repo.git('add', '.npmrc');

  // Act
  const result = await repo.commit('scripts not strict');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /\.npmrc {2}strict-allow-scripts=false: write true/,
  );
});

test("the forms that npm's ini reads pass: spaces around =, a quoted value and a comment after the value; a key that is set twice is stopped, because npm reads it as a list", async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, npmrcOnly);
  await repo.write(
    '.npmrc',
    'legacy-peer-deps = "false"\nstrict-allow-scripts = true ; npm fails an unreviewed script\n',
  );
  await repo.git('add', '.npmrc');

  // Act
  const made = await repo.commit('ini forms');
  await repo.write(
    '.npmrc',
    'legacy-peer-deps=false\nstrict-allow-scripts=true\nlegacy-peer-deps=false\n',
  );
  await repo.git('add', '.npmrc');
  const stopped = await repo.commit('twice');

  // Assert
  assert.equal(made.code, 0, made.stderr);
  assert.notEqual(stopped.code, 0);
  assert.match(stopped.stderr, /legacy-peer-deps set 2 times/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { repository } from './testing/pre-commit-repository.ts';

const trailerOnly = `import { NoAttributionTrailer, commitMsg } from '@zukhruf/git-hooks';
await commitMsg([new NoAttributionTrailer()]);
`;

test('a Co-authored-by trailer stops the commit, and the hook names the trailer line and says to remove it', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, trailerOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit(
    'feat(a): the lock takes a timeout\n\nThe body.\n\nSigned-off-by: A <a@b>\nCo-authored-by: B <b@c>',
  );

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /trailer\s+.*attribution trailer/);
  assert.match(result.stderr, /^\s+Co-authored-by: B <b@c>$/m);
  assert.doesNotMatch(result.stderr, /Signed-off-by/);
  assert.match(result.stderr, /Remove/);
  assert.equal(await repo.git('rev-list', '--all', '--count'), '0\n');
});

test('a co-authored-by trailer in lower case stops the commit, as git reads trailer keys without case', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, trailerOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit(
    'feat(a): the lock takes a timeout\n\nco-authored-by: B <b@c>',
  );

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /^\s+co-authored-by: B <b@c>$/m);
  assert.equal(await repo.git('rev-list', '--all', '--count'), '0\n');
});

test('a Claude-Session trailer stops the commit', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, trailerOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit(
    'feat(a): the lock takes a timeout\n\nClaude-Session: x',
  );

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /^\s+Claude-Session: x$/m);
  assert.equal(await repo.git('rev-list', '--all', '--count'), '0\n');
});

test('a Co-authored-by trailer after a "---" line of the body stops the commit, as a commit message is no patch', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, trailerOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit(
    'feat(a): the lock takes a timeout\n\nThe body.\n---\nThe rest.\n\nCo-authored-by: B <b@c>',
  );

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /^\s+Co-authored-by: B <b@c>$/m);
  assert.equal(await repo.git('rev-list', '--all', '--count'), '0\n');
});

test('a Signed-off-by trailer passes', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, trailerOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit(
    'feat(a): the lock takes a timeout\n\nThe body.\n\nSigned-off-by: A <a@b>',
  );

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await repo.git('rev-list', '--all', '--count'), '1\n');
});

test('a Co-authored-by line in the middle of the body passes, as git reads trailers only in the last paragraph', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, trailerOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit(
    'docs(a): the guide names the co-author line\n\nCo-authored-by: B <b@c>\n\nThe guide says why the repo keeps it out.',
  );

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await repo.git('rev-list', '--all', '--count'), '1\n');
});

test('a message without trailers passes', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, trailerOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit(
    'feat(a): the lock takes a timeout\n\nThe lock waits.',
  );

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await repo.git('rev-list', '--all', '--count'), '1\n');
});

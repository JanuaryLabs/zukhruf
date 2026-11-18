import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { repository } from './testing/pre-commit-repository.ts';

const breakingOnly = `import { NoBreakingChange, commitMsg } from '@zukhruf/git-hooks';
await commitMsg([new NoBreakingChange()]);
`;

test('a "!" before the ": " of a header without a scope marks a breaking change and stops the commit, and the hook says that nx release would make a major version', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, breakingOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit('feat!: the lock takes a timeout');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /breaking\s+nx release reads this message as a breaking change/,
  );
  assert.match(result.stderr, /major\s+version/);
  assert.equal(await repo.git('rev-list', '--all', '--count'), '0\n');
});

test('a "!" after the scope of a header marks a breaking change and stops the commit', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, breakingOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit('fix(a)!: the lock takes a timeout');

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /reads this message as a breaking change/);
});

test('a "BREAKING CHANGE:" footer stops the commit', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, breakingOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit(
    'feat(a): the lock takes a timeout\n\nThe body.\n\nBREAKING CHANGE: acquire needs a timeout',
  );

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /reads this message as a breaking change/);
});

test('"BREAKING CHANGE:" in the middle of a paragraph of the body stops the commit, as nx release reads it anywhere in the body', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, breakingOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit(
    'feat(a): the lock takes a timeout\n\nThe lock waits.\n\nThe old call is gone. BREAKING CHANGE: acquire needs a timeout.\n\nThe docs say how.',
  );

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /reads this message as a breaking change/);
});

test('a header without "!", "breaking changes" in lower case, "BREAKING CHANGE:" in the subject, a BREAKING-CHANGE footer, which nx release does not read, and a merge commit pass', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, breakingOnly, 'commit-msg');
  const messages = [
    'feat(a): the lock takes a timeout',
    'fix(a): the lock keeps its timeout\n\nThe old call has no breaking changes: it still works.',
    'docs(a): the guide names the BREAKING CHANGE: footer',
    'feat(a): the lock takes a timeout\n\nBREAKING-CHANGE: acquire needs a timeout',
  ];

  // Act
  const results = [];
  for (const [index, message] of messages.entries()) {
    await repo.write(`${index}.txt`, `${index}\n`);
    await repo.git('add', `${index}.txt`);
    results.push(await repo.commit(message));
  }
  await repo.git('switch', '--quiet', '--create', 'side', 'HEAD~1');
  await repo.write('side.txt', 'side\n');
  await repo.git('add', 'side.txt');
  results.push(await repo.commit('docs(a): side'));
  await repo.git('switch', '--quiet', 'main');
  await repo.git(
    '-c',
    'core.hooksPath=.husky',
    'merge',
    '--quiet',
    '--no-ff',
    '--no-edit',
    'side',
  );

  // Assert
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(
    await repo.git('log', '-1', '--format=%s'),
    "Merge branch 'side'\n",
  );
});

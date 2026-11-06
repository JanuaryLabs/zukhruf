import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { repository } from './testing/pre-commit-repository.ts';

const scopeOnly = `import { NxReleaseScope, commitMsg } from '@zukhruf/git-hooks';
await commitMsg([new NxReleaseScope()]);
`;

test('a subject with a later "(…): " after its scope is stopped, and the hook names the scope that nx release reads and how to reword it', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, scopeOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit(
    'fix(sqlite-changefeed): the watch takes the version (3da09167, #3840): async reads it',
  );

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /"sqlite-changefeed\): the watch takes the version \(3da09167, #3840", not "sqlite-changefeed"/,
  );
  assert.match(result.stderr, /"\(#3840\); "/);
  assert.equal(await repo.git('rev-list', '--all', '--count'), '0\n');
});

test('a breaking subject whose later "(…): " hides its "!" from nx release is stopped, and the hook says that it would ship as a patch', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, scopeOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit(
    'feat(async)!: ChangeWatcher replaces pollChanges (#3840, ADR 0007): the old name is gone',
  );

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not "async"/);
  assert.match(result.stderr, /ships as a patch/);
});

test('a subject whose first paragraph runs over two lines is judged as one subject, as git log and nx release read it', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, scopeOnly, 'commit-msg');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'a.txt');

  // Act
  const result = await repo.commit(
    'fix(fs): the lock reads the file\nagain (#3840): it was stale\n\nThe body (x): is free.',
  );

  // Assert
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not "fs"/);
});

test('a parenthesis followed by "; ", a "(…): " after a header without a scope, a breaking header, a parenthesis in the body, a release commit and a merge commit pass', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, scopeOnly, 'commit-msg');
  const subjects = [
    'fix(sqlite-changefeed): the watch takes the version (3da09167, #3840); async reads it',
    'fix: the parser reads (a): b',
    'feat(async)!: ChangeWatcher replaces pollChanges',
    'feat(async, fs): two packages\n\nThe body names (#3840): and that is fine.',
    'chore(release): publish 0.7.0',
  ];

  // Act
  const results = [];
  for (const [index, subject] of subjects.entries()) {
    await repo.write(`${index}.txt`, `${index}\n`);
    await repo.git('add', `${index}.txt`);
    results.push(await repo.commit(subject));
  }
  await repo.git('switch', '--quiet', '--create', 'side', 'HEAD~1');
  await repo.write('side.txt', 'side\n');
  await repo.git('add', 'side.txt');
  results.push(await repo.commit('docs(fs): side'));
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

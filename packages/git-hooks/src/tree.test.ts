import assert from 'node:assert/strict';
import { chmod, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { repository } from './testing/pre-commit-repository.ts';

// A hook whose one step gives what it read from the staged commit, as JSON on
// its outcome line: the staged tree, its entries and their content, and the
// diff entries of the commit.
const showTree = `import { type Commit, Step, preCommit } from '@zukhruf/git-hooks';
const byPath = (left: { path: string }, right: { path: string }) =>
  left.path < right.path ? -1 : 1;
class Show extends Step<Commit> {
  readonly name = 'tree';
  async run(commit: Commit) {
    const tree = await commit.tree();
    const entries = tree.entries().toSorted(byPath);
    const contents: Record<string, string | null> = {};
    for (const { path } of entries) contents[path] = (await tree.read(path)) ?? null;
    return this.pass(JSON.stringify({
      id: tree.id,
      entries,
      json: tree.entries(['**/*.json']).map(({ path }) => path).toSorted(),
      contents,
      absent: (await tree.read('absent.txt')) ?? null,
      changes: (await commit.changes()).toSorted(byPath),
      touchesLockfile: await commit.touches(['package-lock.json']),
      touchesMarkdown: await commit.touches(['**/*.md']),
    }));
  }
}
await preCommit([new Show()]);
`;

interface Shown {
  readonly id: string;
  readonly entries: unknown;
  readonly json: unknown;
  readonly contents: unknown;
  readonly absent: unknown;
  readonly changes: unknown;
  readonly touchesLockfile: unknown;
  readonly touchesMarkdown: unknown;
}

function shown(stderr: string): Shown {
  const line = /^tree\s+(\{.*\})$/m.exec(stderr);
  assert.ok(line, `The hook must print what the step read:\n${stderr}`);
  const value: unknown = JSON.parse(line[1] ?? '');
  assert.ok(isShown(value), `not what the step read: ${stderr}`);
  return value;
}

function isShown(value: unknown): value is Shown {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'changes' in value
  );
}

const spaced = 'docs/a b \u{e9}.md';

test('a step reads the tree that git records: each entry with its kind, an executable file as a file, the staged copy of a file and not the working tree, the target of a link, and nothing for an absent path or a submodule', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, showTree);
  await mkdir(join(repo.root, 'packages/x'), { recursive: true });
  await mkdir(join(repo.root, 'docs'));
  await repo.write('a.txt', 'staged\n');
  await repo.write('run.sh', '#!/bin/sh\n');
  await chmod(join(repo.root, 'run.sh'), 0o755);
  await repo.write(spaced, 'spaced\n');
  await repo.write('packages/x/package.json', '{}\n');
  await symlink('a.txt', join(repo.root, 'link'));
  await repo.git(
    'add',
    'a.txt',
    'run.sh',
    spaced,
    'package.json',
    'packages/x/package.json',
    'link',
  );
  // A submodule is a gitlink entry: the commit id of another repo.
  await repo.git(
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${'1'.repeat(40)},sub`,
  );
  await repo.write('a.txt', 'unstaged\n');

  // Act
  const result = await repo.commit('first');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  const tree = shown(result.stderr);
  assert.equal(
    tree.id,
    (await repo.git('rev-parse', 'HEAD^{tree}')).trim(),
    'The staged tree must be the tree that git records',
  );
  assert.deepEqual(tree.entries, [
    { path: 'a.txt', kind: 'file' },
    { path: spaced, kind: 'file' },
    { path: 'link', kind: 'link' },
    { path: 'package.json', kind: 'file' },
    { path: 'packages/x/package.json', kind: 'file' },
    { path: 'run.sh', kind: 'file' },
    { path: 'sub', kind: 'submodule' },
  ]);
  assert.deepEqual(
    tree.json,
    ['package.json', 'packages/x/package.json'],
    'A glob with ** must match at the root and in a nested folder',
  );
  assert.deepEqual(tree.contents, {
    'a.txt': 'staged\n',
    [spaced]: 'spaced\n',
    link: 'a.txt',
    'package.json': '{ "type": "module" }\n',
    'packages/x/package.json': '{}\n',
    'run.sh': '#!/bin/sh\n',
    sub: null,
  });
  assert.equal(tree.absent, null, 'An absent path must read as nothing');
});

test('the diff entries of a first commit start from the empty tree: each staged path is added, with its kind', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, showTree);
  await repo.write('a.txt', 'a\n');
  await symlink('a.txt', join(repo.root, 'link'));
  await repo.git('add', 'a.txt', 'link');

  // Act
  const result = await repo.commit('first');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(shown(result.stderr).changes, [
    { change: 'added', path: 'a.txt', kind: 'file' },
    { change: 'added', path: 'link', kind: 'link' },
  ]);
});

test('the diff entries name an added, a modified and a type-changed path with the kind of its new entry, give a rename as a deleted and an added path, and leave out an unchanged path', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, showTree);
  await repo.write('keep.txt', 'keep\n');
  await repo.write('edit.txt', 'before\n');
  await repo.write('old-name.txt', 'moved\n');
  await repo.write('swap', 'a file before\n');
  await repo.git('add', 'keep.txt', 'edit.txt', 'old-name.txt', 'swap');
  await repo.git('commit', '--quiet', '-m', 'base');
  await repo.write('edit.txt', 'after\n');
  await repo.git('mv', 'old-name.txt', 'new-name.txt');
  await rm(join(repo.root, 'swap'));
  await symlink('keep.txt', join(repo.root, 'swap'));
  await mkdir(join(repo.root, 'docs'));
  await repo.write(spaced, 'spaced\n');
  await repo.git('add', 'edit.txt', 'swap', spaced);

  // Act
  const result = await repo.commit('change each kind');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  const tree = shown(result.stderr);
  assert.deepEqual(tree.changes, [
    { change: 'added', path: spaced, kind: 'file' },
    { change: 'modified', path: 'edit.txt', kind: 'file' },
    { change: 'added', path: 'new-name.txt', kind: 'file' },
    { change: 'deleted', path: 'old-name.txt' },
    { change: 'type-changed', path: 'swap', kind: 'link' },
  ]);
  assert.equal(
    tree.touchesMarkdown,
    true,
    'An added file in a folder must match **/*.md',
  );
});

test('a commit that only deletes package-lock.json touches package-lock.json: its diff entry is deleted, with no kind', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, showTree);
  await repo.write('package-lock.json', '{}\n');
  await repo.write('a.txt', 'a\n');
  await repo.git('add', 'package-lock.json', 'a.txt');
  await repo.git('commit', '--quiet', '-m', 'base');
  await repo.git('rm', '--quiet', 'package-lock.json');

  // Act
  const result = await repo.commit('delete the lockfile');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  const tree = shown(result.stderr);
  assert.deepEqual(tree.changes, [
    { change: 'deleted', path: 'package-lock.json' },
  ]);
  assert.equal(
    tree.touchesLockfile,
    true,
    'A deleted path must count for touches',
  );
  assert.equal(
    tree.touchesMarkdown,
    false,
    'A glob that matches no diff entry must not touch',
  );
});

test('git commit --only takes the named path from the working tree in a temporary index: the step reads that tree, without the staged change of another file and without an unstaged edit', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, showTree);
  await repo.write('a.txt', 'a1\n');
  await repo.write('b.txt', 'b1\n');
  await repo.write('c.txt', 'c1\n');
  await repo.git('add', 'a.txt', 'b.txt', 'c.txt');
  await repo.git('commit', '--quiet', '-m', 'base');
  await repo.write('a.txt', 'a2\n');
  // Another session staged b.txt and edits c.txt.
  await repo.write('b.txt', 'b2\n');
  await repo.git('add', 'b.txt');
  await repo.write('c.txt', 'c2\n');

  // Act
  const result = await repo.commitWith([], 'only a', '--only', '--', 'a.txt');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  const tree = shown(result.stderr);
  assert.equal(
    tree.id,
    (await repo.git('rev-parse', 'HEAD^{tree}')).trim(),
    'The staged tree must be the tree that git records',
  );
  assert.deepEqual(tree.contents, {
    'a.txt': 'a2\n',
    'b.txt': 'b1\n',
    'c.txt': 'c1\n',
  });
  assert.deepEqual(tree.changes, [
    { change: 'modified', path: 'a.txt', kind: 'file' },
  ]);
});

test('git commit -a takes each tracked file from the working tree: the step reads that tree, without an untracked file', async () => {
  // Arrange
  await using folder = await new TemporaryFiles().directory('git-hooks-');
  const repo = await repository(folder.path, showTree);
  await repo.write('a.txt', 'a1\n');
  await repo.write('b.txt', 'b1\n');
  await repo.git('add', 'a.txt', 'b.txt');
  await repo.git('commit', '--quiet', '-m', 'base');
  await repo.write('a.txt', 'a2\n');
  await repo.write('b.txt', 'b2\n');
  await repo.git('add', 'b.txt');
  await repo.write('d.txt', 'untracked\n');

  // Act
  const result = await repo.commitWith([], 'all', '-a');

  // Assert
  assert.equal(result.code, 0, result.stderr);
  const tree = shown(result.stderr);
  assert.equal(
    tree.id,
    (await repo.git('rev-parse', 'HEAD^{tree}')).trim(),
    'The staged tree must be the tree that git records',
  );
  assert.deepEqual(tree.contents, { 'a.txt': 'a2\n', 'b.txt': 'b2\n' });
  assert.deepEqual(tree.changes, [
    { change: 'modified', path: 'a.txt', kind: 'file' },
    { change: 'modified', path: 'b.txt', kind: 'file' },
  ]);
});

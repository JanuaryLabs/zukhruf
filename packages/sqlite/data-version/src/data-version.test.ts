import assert from 'node:assert/strict';
import { renameSync, rmSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { DataVersion } from './index.ts';

// What a caller passes in: its own error, which names what it needs.
class SourceUnavailableError extends Error {
  override name = 'SourceUnavailableError';
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`The database at ${path} cannot be read.`, { cause });
    this.path = path;
  }
}

test('the version stays the same until the owner commits, then changes', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const path = join(dir.path, 'source.sqlite');
  using owner = new DatabaseSync(path);
  owner.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO notes (title) VALUES ('first');
  `);
  using version = new DataVersion(path, SourceUnavailableError);
  const before = version.current;
  assert.equal(version.current, before);

  owner.exec("INSERT INTO notes (title) VALUES ('second')");

  assert.notEqual(version.current, before);
});

// The owner's connection to a new database at the path, with one row.
function created(path: string, journal: 'WAL' | 'DELETE'): DatabaseSync {
  const owner = new DatabaseSync(path);
  owner.exec(`
    PRAGMA journal_mode = ${journal};
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO notes (title) VALUES ('first');
  `);
  return owner;
}

test('a new file renamed over the path changes the version, and its commits change it again', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const path = join(dir.path, 'source.sqlite');
  created(path, 'DELETE').close();
  using version = new DataVersion(path, SourceUnavailableError);
  const before = version.current;
  const replacement = join(dir.path, 'replacement.sqlite');
  created(replacement, 'DELETE').close();

  renameSync(replacement, path);
  const replaced = version.current;
  using owner = new DatabaseSync(path);
  owner.exec("INSERT INTO notes (title) VALUES ('second')");

  assert.notEqual(replaced, before, 'the replaced file is not a change');
  assert.notEqual(
    version.current,
    replaced,
    'a commit to the new file is not a change',
  );
});

test('a WAL database deleted with its WAL and shared-memory index and created again changes the version, and its commits change it again', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const path = join(dir.path, 'source.sqlite');
  const first = created(path, 'WAL');
  using version = new DataVersion(path, SourceUnavailableError);
  const before = version.current;
  first.close();

  for (const suffix of ['', '-wal', '-shm'])
    rmSync(`${path}${suffix}`, { force: true });
  using owner = created(path, 'WAL');
  const recreated = version.current;
  owner.exec("INSERT INTO notes (title) VALUES ('second')");

  assert.notEqual(recreated, before, 'the created file is not a change');
  assert.notEqual(
    version.current,
    recreated,
    'a commit to the new file is not a change',
  );
});

test('a missing path is no change until a file is created there again', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const path = join(dir.path, 'source.sqlite');
  const first = created(path, 'WAL');
  using version = new DataVersion(path, SourceUnavailableError);
  const before = version.current;
  first.close();

  for (const suffix of ['', '-wal', '-shm'])
    rmSync(`${path}${suffix}`, { force: true });
  const missing = version.current;
  using _owner = created(path, 'WAL');

  assert.equal(missing, before, 'the missing path is a change');
  assert.notEqual(version.current, missing, 'the created file is not a change');
});

test('a missing file is the caller’s unavailable error', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const missing = join(dir.path, 'missing', 'source.sqlite');

  assert.throws(
    () => new DataVersion(missing, SourceUnavailableError),
    (error: unknown) => {
      assert.ok(error instanceof SourceUnavailableError);
      assert.equal(error.path, missing);
      return true;
    },
  );
});

test(
  'a file the system denies is the caller’s unavailable error',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('data-version-');
    const path = join(dir.path, 'source.sqlite');
    new DatabaseSync(path).close();
    await chmod(path, 0o000);

    assert.throws(
      () => new DataVersion(path, SourceUnavailableError),
      (error: unknown) => {
        assert.ok(error instanceof SourceUnavailableError);
        assert.equal(error.path, path);
        return true;
      },
    );
  },
);

test(
  'a file in a folder the system denies is the caller’s unavailable error',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('data-version-');
    const folder = join(dir.path, 'denied');
    await mkdir(folder);
    const path = join(folder, 'source.sqlite');
    new DatabaseSync(path).close();
    await chmod(folder, 0o000);
    try {
      assert.throws(
        () => new DataVersion(path, SourceUnavailableError),
        (error: unknown) => {
          assert.ok(error instanceof SourceUnavailableError);
          assert.equal(error.path, path);
          return true;
        },
      );
    } finally {
      await chmod(folder, 0o700);
    }
  },
);

import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { MissingColumnsError, Snapshot, UnavailableError } from './index.ts';

test('a read stays on one moment while the owner commits, and the next snapshot sees the commit', async () => {
  await using dir = await new TemporaryFiles().directory('snapshot-');
  const path = join(dir.path, 'source.sqlite');
  using owner = new DatabaseSync(path);
  owner.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO notes (title) VALUES ('first');
  `);

  {
    using snapshot = new Snapshot(path);
    owner.exec("INSERT INTO notes (title) VALUES ('second')");

    assert.deepEqual(
      snapshot.all('SELECT title FROM notes ORDER BY id').map((row) => ({
        ...row,
      })),
      [{ title: 'first' }],
    );
  }
  using next = new Snapshot(path);
  assert.equal(next.all('SELECT count(*) AS n FROM notes')[0]?.n, 2);
});

test('a layout without the required columns fails with MissingColumnsError, naming each one, and closes', async () => {
  await using dir = await new TemporaryFiles().directory('snapshot-');
  const path = join(dir.path, 'source.sqlite');
  using owner = new DatabaseSync(path);
  owner.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
  using snapshot = new Snapshot(path);

  assert.throws(
    () => snapshot.requireColumns({ notes: ['id', 'title'], folders: ['id'] }),
    (error: unknown) => {
      assert.ok(error instanceof MissingColumnsError);
      assert.equal(error.path, path);
      assert.deepEqual(error.missing, ['notes.title', 'folders.id']);
      return true;
    },
  );
  assert.throws(() => snapshot.all('SELECT 1'), /not open/);
});

test('a missing file is an UnavailableError, and a file that is no database is not', async () => {
  await using dir = await new TemporaryFiles().directory('snapshot-');
  const missing = join(dir.path, 'missing', 'source.sqlite');
  const notDatabase = join(dir.path, 'notes.txt');
  await writeFile(notDatabase, 'not a database, but long enough to be read');

  assert.throws(
    () => new Snapshot(missing),
    (error: unknown) => {
      assert.ok(error instanceof UnavailableError);
      assert.equal(error.path, missing);
      assert.ok(error.cause instanceof Error && 'errcode' in error.cause);
      assert.equal(error.cause.errcode, 14);
      return true;
    },
  );
  assert.throws(
    () => new Snapshot(notDatabase),
    (error: unknown) => {
      assert.ok(!(error instanceof UnavailableError));
      assert.match(String(error), /not a database/);
      return true;
    },
  );
});

test(
  'a file the system denies is an UnavailableError',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('snapshot-');
    const path = join(dir.path, 'source.sqlite');
    new DatabaseSync(path).close();
    await chmod(path, 0o000);

    assert.throws(
      () => new Snapshot(path),
      (error: unknown) => {
        assert.ok(error instanceof UnavailableError);
        assert.equal(error.path, path);
        assert.ok(error.cause instanceof Error && 'errcode' in error.cause);
        assert.equal(error.cause.errcode, 14);
        return true;
      },
    );
  },
);

import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { UnavailableError, openReader } from './index.ts';

test('a reader reads the commits of the owner, and cannot write', async () => {
  await using dir = await new TemporaryFiles().directory('reader-');
  const path = join(dir.path, 'source.sqlite');
  using owner = new DatabaseSync(path);
  owner.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE notes (title TEXT);
    INSERT INTO notes VALUES ('first')`);

  using reader = openReader(path);

  assert.deepEqual(
    reader
      .prepare('SELECT title FROM notes')
      .all()
      .map((row) => row.title),
    ['first'],
  );
  assert.throws(
    () => reader.exec("INSERT INTO notes VALUES ('second')"),
    /readonly/,
  );
});

test('a missing file is an UnavailableError', async () => {
  await using dir = await new TemporaryFiles().directory('reader-');
  const missing = join(dir.path, 'missing', 'source.sqlite');

  assert.throws(
    () => openReader(missing),
    (error: unknown) => {
      assert.ok(error instanceof UnavailableError);
      assert.equal(error.path, missing);
      assert.ok(error.cause instanceof Error && 'errcode' in error.cause);
      assert.equal(error.cause.errcode, 14);
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
    await using dir = await new TemporaryFiles().directory('reader-');
    const path = join(dir.path, 'source.sqlite');
    new DatabaseSync(path).close();
    await chmod(path, 0o000);

    assert.throws(
      () => openReader(path),
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

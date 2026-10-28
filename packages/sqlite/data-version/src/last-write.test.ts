import assert from 'node:assert/strict';
import { chmod, mkdir, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { DataVersion, UnavailableError, lastWrite } from './index.ts';

// The owner's connection, as it keeps the database while it runs: it commits
// into the WAL and does not checkpoint, so the file, the WAL and the
// shared-memory index are all there.
function owning(path: string): DatabaseSync {
  const owner = new DatabaseSync(path);
  owner.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO notes (title) VALUES ('first');
  `);
  return owner;
}

// A reader reads a file after the owner writes it, so a file's access time is
// later than the time it was last written.
const readLater = 100_000;

// Gives each file the time it was last written, in seconds since the epoch.
async function writtenAt(
  path: string,
  times: { file: number; wal: number; shm: number },
) {
  await utimes(path, times.file + readLater, times.file);
  await utimes(`${path}-wal`, times.wal + readLater, times.wal);
  await utimes(`${path}-shm`, times.shm + readLater, times.shm);
}

test('the last write is the later of the database file and its WAL', async () => {
  await using dir = await new TemporaryFiles().directory('last-write-');
  const path = join(dir.path, 'source.sqlite');
  using _owner = owning(path);
  await writtenAt(path, {
    file: 1_800_000_000,
    wal: 1_800_000_060,
    shm: 1_800_000_000,
  });

  const written = lastWrite(path);

  assert.equal(written.getTime(), 1_800_000_060_000);
});

test('a later write to the shared-memory index, which readers touch, does not count', async () => {
  await using dir = await new TemporaryFiles().directory('last-write-');
  const path = join(dir.path, 'source.sqlite');
  using _owner = owning(path);
  await writtenAt(path, {
    file: 1_800_000_060,
    wal: 1_800_000_000,
    shm: 1_800_000_900,
  });

  const written = lastWrite(path);

  assert.equal(written.getTime(), 1_800_000_060_000);
});

test('a database whose owner closed it, which removes the WAL, was last written when its file was', async () => {
  await using dir = await new TemporaryFiles().directory('last-write-');
  const path = join(dir.path, 'source.sqlite');
  owning(path).close();
  // A time in the past: a WAL with frames left behind would carry a later one.
  await utimes(path, 1_000_000_000 + readLater, 1_000_000_000);

  const written = lastWrite(path);

  assert.equal(written.getTime(), 1_000_000_000_000);
});

test('a WAL that a reader made after the owner removed its own does not count', async () => {
  await using dir = await new TemporaryFiles().directory('last-write-');
  const path = join(dir.path, 'source.sqlite');
  owning(path).close();
  await utimes(path, 1_000_000_000 + readLater, 1_000_000_000);
  {
    // A read-only connection opens the WAL the owner removed, so it makes an
    // empty one, timed as it reads.
    using reader = new DataVersion(path);
    assert.equal(typeof reader.current, 'number');
  }
  assert.equal((await stat(`${path}-wal`)).size, 0);

  const written = lastWrite(path);

  assert.equal(written.getTime(), 1_000_000_000_000);
});

test('a missing file is an UnavailableError', async () => {
  await using dir = await new TemporaryFiles().directory('last-write-');
  const missing = join(dir.path, 'missing', 'source.sqlite');

  assert.throws(
    () => lastWrite(missing),
    (error: unknown) => {
      assert.ok(error instanceof UnavailableError);
      assert.equal(error.path, missing);
      assert.ok(error.cause instanceof Error && 'code' in error.cause);
      assert.equal(error.cause.code, 'ENOENT');
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
    await using dir = await new TemporaryFiles().directory('last-write-');
    // A file's own mode does not deny reading its times; its folder's does.
    const folder = join(dir.path, 'denied');
    await mkdir(folder);
    const path = join(folder, 'source.sqlite');
    new DatabaseSync(path).close();
    await chmod(folder, 0o000);
    try {
      assert.throws(
        () => lastWrite(path),
        (error: unknown) => {
          assert.ok(error instanceof UnavailableError);
          assert.equal(error.path, path);
          assert.ok(error.cause instanceof Error && 'code' in error.cause);
          assert.equal(error.cause.code, 'EACCES');
          return true;
        },
      );
    } finally {
      await chmod(folder, 0o700);
    }
  },
);

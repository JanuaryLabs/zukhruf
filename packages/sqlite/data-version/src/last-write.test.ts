import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtempDisposable, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { lastWrite } from './index.ts';

// What a caller passes in: its own error, which names what it needs.
class SourceUnavailableError extends Error {
  override name = 'SourceUnavailableError';
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`The database at ${path} cannot be read.`, { cause });
    this.path = path;
  }
}

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

// Gives each file the time it was last written, in seconds since the epoch.
async function writtenAt(
  path: string,
  times: { file: number; wal: number; shm: number },
) {
  await utimes(path, times.file, times.file);
  await utimes(`${path}-wal`, times.wal, times.wal);
  await utimes(`${path}-shm`, times.shm, times.shm);
}

test('the last write is the later of the database file and its WAL', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'last-write-'));
  const path = join(dir.path, 'source.sqlite');
  using _owner = owning(path);
  await writtenAt(path, {
    file: 1_800_000_000,
    wal: 1_800_000_060,
    shm: 1_800_000_000,
  });

  const written = lastWrite(path, SourceUnavailableError);

  assert.equal(written.getTime(), 1_800_000_060_000);
});

test('a later write to the shared-memory index, which readers touch, does not count', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'last-write-'));
  const path = join(dir.path, 'source.sqlite');
  using _owner = owning(path);
  await writtenAt(path, {
    file: 1_800_000_060,
    wal: 1_800_000_000,
    shm: 1_800_000_900,
  });

  const written = lastWrite(path, SourceUnavailableError);

  assert.equal(written.getTime(), 1_800_000_060_000);
});

test('a database whose owner closed it, which removes the WAL, was last written when its file was', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'last-write-'));
  const path = join(dir.path, 'source.sqlite');
  owning(path).close();
  // A time in the past: a WAL left behind would carry the time of now and win.
  await utimes(path, 1_000_000_000, 1_000_000_000);

  const written = lastWrite(path, SourceUnavailableError);

  assert.equal(written.getTime(), 1_000_000_000_000);
});

test('a missing file is the caller’s unavailable error', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'last-write-'));
  const missing = join(dir.path, 'missing', 'source.sqlite');

  assert.throws(
    () => lastWrite(missing, SourceUnavailableError),
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
    await using dir = await mkdtempDisposable(join(tmpdir(), 'last-write-'));
    // A file's own mode does not deny reading its times; its folder's does.
    const folder = join(dir.path, 'denied');
    await mkdir(folder);
    const path = join(folder, 'source.sqlite');
    new DatabaseSync(path).close();
    await chmod(folder, 0o000);
    try {
      assert.throws(
        () => lastWrite(path, SourceUnavailableError),
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

import assert from 'node:assert/strict';
import { chmod, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

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
  await using dir = await mkdtempDisposable(join(tmpdir(), 'data-version-'));
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

test('a missing file is the caller’s unavailable error', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'data-version-'));
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
    await using dir = await mkdtempDisposable(join(tmpdir(), 'data-version-'));
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

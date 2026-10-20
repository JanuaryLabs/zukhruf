import assert from 'node:assert/strict';
import { chmod, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { Snapshot } from './index.ts';

// What a caller passes in: its own errors, which name what it needs.
class SourceUnavailableError extends Error {
  override name = 'SourceUnavailableError';
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`The database at ${path} cannot be read.`, { cause });
    this.path = path;
  }
}

class SourceSchemaError extends Error {
  override name = 'SourceSchemaError';
  readonly missing: readonly string[];

  constructor(path: string, missing: readonly string[]) {
    super(`The database at ${path} lacks ${missing.join(', ')}.`);
    this.missing = missing;
  }
}

test('a read stays on one moment while the owner commits, and the next snapshot sees the commit', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'snapshot-'));
  const path = join(dir.path, 'source.sqlite');
  using owner = new DatabaseSync(path);
  owner.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO notes (title) VALUES ('first');
  `);

  {
    using snapshot = new Snapshot(path, SourceUnavailableError);
    owner.exec("INSERT INTO notes (title) VALUES ('second')");

    assert.deepEqual(
      snapshot.all('SELECT title FROM notes ORDER BY id').map((row) => ({
        ...row,
      })),
      [{ title: 'first' }],
    );
  }
  using next = new Snapshot(path, SourceUnavailableError);
  assert.equal(next.all('SELECT count(*) AS n FROM notes')[0]?.n, 2);
});

test('a layout without the required columns fails with the caller’s schema error, naming each one, and closes', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'snapshot-'));
  const path = join(dir.path, 'source.sqlite');
  using owner = new DatabaseSync(path);
  owner.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
  using snapshot = new Snapshot(path, SourceUnavailableError);

  assert.throws(
    () =>
      snapshot.requireColumns(
        { notes: ['id', 'title'], folders: ['id'] },
        SourceSchemaError,
      ),
    (error: unknown) => {
      assert.ok(error instanceof SourceSchemaError);
      assert.deepEqual(error.missing, ['notes.title', 'folders.id']);
      return true;
    },
  );
  assert.throws(() => snapshot.all('SELECT 1'), /not open/);
});

test('a missing file is the caller’s unavailable error, and a file that is no database is not', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'snapshot-'));
  const missing = join(dir.path, 'missing', 'source.sqlite');
  const notDatabase = join(dir.path, 'notes.txt');
  await writeFile(notDatabase, 'not a database, but long enough to be read');

  assert.throws(
    () => new Snapshot(missing, SourceUnavailableError),
    (error: unknown) => {
      assert.ok(error instanceof SourceUnavailableError);
      assert.equal(error.path, missing);
      return true;
    },
  );
  assert.throws(
    () => new Snapshot(notDatabase, SourceUnavailableError),
    (error: unknown) => {
      assert.ok(!(error instanceof SourceUnavailableError));
      assert.match(String(error), /not a database/);
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
    await using dir = await mkdtempDisposable(join(tmpdir(), 'snapshot-'));
    const path = join(dir.path, 'source.sqlite');
    new DatabaseSync(path).close();
    await chmod(path, 0o000);

    assert.throws(
      () => new Snapshot(path, SourceUnavailableError),
      (error: unknown) => {
        assert.ok(error instanceof SourceUnavailableError);
        assert.equal(error.path, path);
        return true;
      },
    );
  },
);

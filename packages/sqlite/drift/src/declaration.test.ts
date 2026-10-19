import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { Declaration } from './index.ts';

// The objects a database stores, as sqlite_schema keeps their CREATE text.
function stored(database: DatabaseSync): Record<string, unknown>[] {
  return database
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => ({ ...row }));
}

function count(database: DatabaseSync, table: string): number {
  return Number(
    database.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,
  );
}

test('a new database stores none of a declaration, and apply creates each object as declared', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  const declaration = new Declaration([
    'CREATE TABLE IF NOT EXISTS   events (at TEXT NOT NULL, kind TEXT) STRICT',
    'CREATE INDEX IF NOT EXISTS events_at ON events (at)',
  ]);

  assert.equal(declaration.drift(database), 'missing');
  declaration.apply(database);

  assert.equal(declaration.drift(database), 'fits');
  assert.deepEqual(stored(database), [
    {
      type: 'table',
      name: 'events',
      sql: 'CREATE TABLE events (at TEXT NOT NULL, kind TEXT) STRICT',
    },
    {
      type: 'index',
      name: 'events_at',
      sql: 'CREATE INDEX events_at ON events (at)',
    },
  ]);
});

test('a database that stores every object as declared fits, and apply keeps its rows', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE events (at TEXT NOT NULL) STRICT;
    INSERT INTO events VALUES ('2026-10-15')`);
  const declaration = new Declaration([
    'CREATE TABLE IF NOT EXISTS events (at TEXT NOT NULL) STRICT',
  ]);

  declaration.apply(database);

  assert.equal(declaration.drift(database), 'fits');
  assert.equal(count(database, 'events'), 1);
});

test('a table whose columns or CHECK differ from its declaration is stale, and apply replaces the whole declaration without its rows', async () => {
  for (const older of [
    'CREATE TABLE parents (id INTEGER PRIMARY KEY) STRICT',
    "CREATE TABLE parents (id INTEGER PRIMARY KEY, status TEXT CHECK (status IN ('a'))) STRICT",
  ]) {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
    using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
    database.exec(`${older};
      CREATE TABLE children (parent INTEGER NOT NULL REFERENCES parents (id)) STRICT;
      INSERT INTO parents (id) VALUES (1);
      INSERT INTO children VALUES (1)`);
    const declaration = new Declaration([
      "CREATE TABLE parents (id INTEGER PRIMARY KEY, status TEXT CHECK (status IN ('a', 'b'))) STRICT",
      'CREATE TABLE children (parent INTEGER NOT NULL REFERENCES parents (id)) STRICT',
    ]);

    assert.equal(declaration.drift(database), 'stale');
    declaration.apply(database);

    assert.equal(declaration.drift(database), 'fits');
    assert.equal(count(database, 'parents'), 0);
    assert.equal(count(database, 'children'), 0);
  }
});

test('a database that stores some objects of a declaration but not others has drifted, and apply creates only the missing ones', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE attempts (id INTEGER PRIMARY KEY) STRICT;
    INSERT INTO attempts VALUES (7)`);
  const declaration = new Declaration([
    'CREATE TABLE attempts (id INTEGER PRIMARY KEY) STRICT',
    'CREATE TABLE checks (stream TEXT PRIMARY KEY) STRICT',
    'CREATE VIEW latest AS SELECT max(id) AS id FROM attempts',
  ]);

  assert.equal(declaration.drift(database), 'stale');
  declaration.apply(database);

  assert.equal(declaration.drift(database), 'fits');
  assert.deepEqual(
    database
      .prepare('SELECT id FROM latest')
      .all()
      .map(({ id }) => id),
    [7],
  );
});

test('a view whose query differs from its declaration is stale', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE attempts (id INTEGER, at TEXT) STRICT;
    CREATE VIEW latest AS SELECT id FROM attempts`);

  const declaration = new Declaration([
    'CREATE TABLE attempts (id INTEGER, at TEXT) STRICT',
    'CREATE VIEW latest AS SELECT id, at FROM attempts',
  ]);

  assert.equal(declaration.drift(database), 'stale');
});

test('drift reads a database opened read-only and changes nothing', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  const path = join(scratch.path, 'data.sqlite');
  {
    using writer = new DatabaseSync(path);
    writer.exec('CREATE TABLE events (at TEXT) STRICT');
  }
  using reader = new DatabaseSync(path, { readOnly: true });
  const declaration = new Declaration([
    'CREATE TABLE events (at TEXT NOT NULL) STRICT',
  ]);

  assert.equal(declaration.drift(reader), 'stale');
  assert.deepEqual(stored(reader), [
    {
      type: 'table',
      name: 'events',
      sql: 'CREATE TABLE events (at TEXT) STRICT',
    },
  ]);
});

test("apply inside the caller's transaction is undone when the caller rolls back", async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec('CREATE TABLE events (at TEXT) STRICT');
  const declaration = new Declaration([
    'CREATE TABLE events (at TEXT NOT NULL) STRICT',
  ]);

  database.exec('BEGIN IMMEDIATE');
  declaration.apply(database);
  assert.equal(declaration.drift(database), 'fits');
  database.exec('ROLLBACK');

  assert.equal(declaration.drift(database), 'stale');
});

test('apply leaves every object the declaration does not name', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE events (at TEXT) STRICT;
    CREATE TABLE notes (body TEXT) STRICT;
    INSERT INTO notes VALUES ('kept')`);
  const declaration = new Declaration([
    'CREATE TABLE events (at TEXT NOT NULL) STRICT',
  ]);

  declaration.apply(database);

  assert.equal(count(database, 'notes'), 1);
});

test('a declaration that cannot stand alone in an empty database fails when it is made, with the error of SQLite', () => {
  assert.throws(
    () =>
      new Declaration([
        'CREATE TRIGGER events_deleted AFTER DELETE ON events BEGIN SELECT 1; END',
      ]),
    /no such table: main\.events/,
  );
});

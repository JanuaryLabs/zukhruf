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
  const declaration = new Declaration(
    [
      'CREATE TABLE IF NOT EXISTS   events (at TEXT NOT NULL, kind TEXT) STRICT',
      'CREATE INDEX IF NOT EXISTS events_at ON events (at)',
    ],
    { rows: 'replace' },
  );

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
  const declaration = new Declaration(
    ['CREATE TABLE IF NOT EXISTS events (at TEXT NOT NULL) STRICT'],
    { rows: 'replace' },
  );

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
    const declaration = new Declaration(
      [
        "CREATE TABLE parents (id INTEGER PRIMARY KEY, status TEXT CHECK (status IN ('a', 'b'))) STRICT",
        'CREATE TABLE children (parent INTEGER NOT NULL REFERENCES parents (id)) STRICT',
      ],
      { rows: 'replace' },
    );

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
  const declaration = new Declaration(
    [
      'CREATE TABLE attempts (id INTEGER PRIMARY KEY) STRICT',
      'CREATE TABLE checks (stream TEXT PRIMARY KEY) STRICT',
      'CREATE VIEW latest AS SELECT max(id) AS id FROM attempts',
    ],
    { rows: 'replace' },
  );

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

  const declaration = new Declaration(
    [
      'CREATE TABLE attempts (id INTEGER, at TEXT) STRICT',
      'CREATE VIEW latest AS SELECT id, at FROM attempts',
    ],
    { rows: 'replace' },
  );

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
  const declaration = new Declaration(
    ['CREATE TABLE events (at TEXT NOT NULL) STRICT'],
    { rows: 'replace' },
  );

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
  const declaration = new Declaration(
    ['CREATE TABLE events (at TEXT NOT NULL) STRICT'],
    { rows: 'replace' },
  );

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
  const declaration = new Declaration(
    ['CREATE TABLE events (at TEXT NOT NULL) STRICT'],
    { rows: 'replace' },
  );

  declaration.apply(database);

  assert.equal(count(database, 'notes'), 1);
});

test('a declaration that cannot stand alone in an empty database fails when it is made, with the error of SQLite', () => {
  assert.throws(
    () =>
      new Declaration(
        [
          'CREATE TRIGGER events_deleted AFTER DELETE ON events BEGIN SELECT 1; END',
        ],
        { rows: 'replace' },
      ),
    /no such table: main\.events/,
  );
});

test("apply inside the caller's transaction fails with the error that made SQLite end that transaction", async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  // Dropping the stale parents table deletes its rows first. The cascade
  // reaches children, and its trigger ends the transaction.
  database.exec(`CREATE TABLE parents (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE children (parent INTEGER REFERENCES parents (id) ON DELETE CASCADE) STRICT;
    CREATE TRIGGER children_kept BEFORE DELETE ON children BEGIN SELECT RAISE(ROLLBACK, 'children are kept'); END;
    INSERT INTO parents VALUES (1);
    INSERT INTO children VALUES (1)`);
  const declaration = new Declaration(
    ['CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT) STRICT'],
    { rows: 'replace' },
  );

  database.exec('BEGIN IMMEDIATE');
  assert.throws(() => declaration.apply(database), {
    message: 'children are kept',
  });

  assert.equal(database.isTransaction, false);
  assert.equal(declaration.drift(database), 'stale');
});

function pragma(database: DatabaseSync, name: string): unknown {
  return database.prepare(`PRAGMA ${name}`).get()?.[name];
}

function rows(database: DatabaseSync, sql: string): Record<string, unknown>[] {
  return database
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

test('with rows keep, a table with a new column keeps its rows, the new column gets its default, and a dropped column is discarded', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT) STRICT;
    INSERT INTO runs VALUES (1, 'first', 'gone'), (2, 'second', 'gone')`);
  const declaration = new Declaration(
    [
      "CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'done') STRICT",
    ],
    { rows: 'keep' },
  );

  declaration.apply(database);

  assert.equal(declaration.drift(database), 'fits');
  assert.deepEqual(rows(database, 'SELECT * FROM runs ORDER BY id'), [
    { id: 1, name: 'first', status: 'done' },
    { id: 2, name: 'second', status: 'done' },
  ]);
  assert.equal(pragma(database, 'legacy_alter_table'), 0);
  assert.equal(pragma(database, 'foreign_keys'), 1);
});

test('with rows keep, a row the new declaration refuses fails apply with the error of SQLite, and the table and its rows stay as they were', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, status TEXT CHECK (status IN ('a', 'b'))) STRICT;
    CREATE TABLE cases (run INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE) STRICT;
    INSERT INTO runs VALUES (1, 'a'), (2, 'b');
    INSERT INTO cases VALUES (1), (2)`);
  const before = stored(database);
  const declaration = new Declaration(
    [
      "CREATE TABLE runs (id INTEGER PRIMARY KEY, status TEXT CHECK (status IN ('a'))) STRICT",
    ],
    { rows: 'keep' },
  );

  assert.throws(() => declaration.apply(database), {
    message: /CHECK constraint failed/,
  });

  assert.deepEqual(stored(database), before);
  assert.equal(count(database, 'runs'), 2);
  assert.equal(count(database, 'cases'), 2);
  assert.equal(pragma(database, 'legacy_alter_table'), 0);
  assert.equal(pragma(database, 'foreign_keys'), 1);
});

test('with rows keep, a table that other tables reference keeps the rows of its children and grandchildren, and its cascade still works', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE cases (id INTEGER PRIMARY KEY, run INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE) STRICT;
    CREATE TABLE scores (\`case\` INTEGER NOT NULL REFERENCES cases (id) ON DELETE CASCADE, value REAL) STRICT;
    INSERT INTO runs VALUES (1), (2);
    INSERT INTO cases VALUES (10, 1), (20, 2);
    INSERT INTO scores VALUES (10, 0.5), (20, 0.75)`);
  const declaration = new Declaration(
    [
      'CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT) STRICT',
      'CREATE TABLE cases (id INTEGER PRIMARY KEY, run INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE) STRICT',
      'CREATE TABLE scores (`case` INTEGER NOT NULL REFERENCES cases (id) ON DELETE CASCADE, value REAL) STRICT',
    ],
    { rows: 'keep' },
  );

  declaration.apply(database);

  assert.equal(count(database, 'runs'), 2);
  assert.equal(count(database, 'cases'), 2);
  assert.equal(count(database, 'scores'), 2);
  assert.equal(declaration.drift(database), 'fits');
  assert.equal(pragma(database, 'foreign_keys'), 1);
  database.exec('DELETE FROM runs WHERE id = 1');
  assert.deepEqual(rows(database, 'SELECT * FROM scores'), [
    { case: 20, value: 0.75 },
  ]);
});

test("with rows keep, a referenced table inside the caller's transaction fails before any change, because SQLite keeps foreign keys on there", async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE cases (run INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE) STRICT;
    INSERT INTO runs VALUES (1);
    INSERT INTO cases VALUES (1)`);
  const before = stored(database);
  const declaration = new Declaration(
    ['CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT) STRICT'],
    { rows: 'keep' },
  );

  database.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => declaration.apply(database), {
      message:
        'Keeping the rows of a table that other tables reference needs foreign keys off, which SQLite cannot change inside a transaction. Call apply outside a transaction, or turn foreign keys off before it.',
    });
    assert.equal(database.isTransaction, true);
    assert.deepEqual(stored(database), before);
    assert.equal(count(database, 'cases'), 1);
  } finally {
    database.exec('ROLLBACK');
  }
});

test("with rows keep, a table that no table references is rebuilt inside the caller's transaction, with foreign keys on", async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE cases (run INTEGER NOT NULL REFERENCES runs (id)) STRICT;
    INSERT INTO runs VALUES (1);
    INSERT INTO cases VALUES (1)`);
  const declaration = new Declaration(
    [
      'CREATE TABLE cases (run INTEGER NOT NULL REFERENCES runs (id), label TEXT) STRICT',
    ],
    { rows: 'keep' },
  );

  database.exec('PRAGMA legacy_alter_table = ON');
  database.exec('BEGIN IMMEDIATE');
  declaration.apply(database);
  database.exec('COMMIT');

  assert.equal(declaration.drift(database), 'fits');
  assert.deepEqual(rows(database, 'SELECT * FROM cases'), [
    { run: 1, label: null },
  ]);
  assert.equal(pragma(database, 'legacy_alter_table'), 1);
});

test('with rows keep, kept rows that break a foreign key of the new declaration fail apply, and the table stays as it was', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE cases (run INTEGER NOT NULL) STRICT;
    INSERT INTO cases VALUES (9)`);
  const before = stored(database);
  const declaration = new Declaration(
    [
      'CREATE TABLE runs (id INTEGER PRIMARY KEY) STRICT',
      'CREATE TABLE cases (run INTEGER NOT NULL REFERENCES runs (id)) STRICT',
    ],
    { rows: 'keep' },
  );

  database.exec('PRAGMA foreign_keys = OFF');
  assert.throws(() => declaration.apply(database), {
    message:
      'The kept rows break a foreign key: row 1 of cases refers to a row of runs that does not exist.',
  });

  assert.deepEqual(stored(database), before);
  assert.equal(count(database, 'cases'), 1);
});

test('with rows keep, the indexes, triggers and views on a rebuilt table that the declaration does not name stay and work', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT) STRICT;
    CREATE TABLE log (id INTEGER) STRICT;
    CREATE UNIQUE INDEX runs_name ON runs (name);
    CREATE TRIGGER runs_logged AFTER INSERT ON runs BEGIN INSERT INTO log VALUES (new.id); END;
    CREATE VIEW named AS SELECT name FROM runs;
    INSERT INTO runs VALUES (1, 'first')`);
  const declaration = new Declaration(
    [
      'CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT, at TEXT) STRICT',
      'CREATE INDEX runs_at ON runs (at)',
    ],
    { rows: 'keep' },
  );

  declaration.apply(database);

  assert.equal(declaration.drift(database), 'fits');
  assert.deepEqual(
    stored(database)
      .filter(({ type }) => type !== 'table')
      .map(({ name }) => name),
    ['named', 'runs_at', 'runs_logged', 'runs_name'],
  );
  database.exec("INSERT INTO runs (id, name) VALUES (2, 'second')");
  assert.deepEqual(rows(database, 'SELECT * FROM log ORDER BY id'), [
    { id: 1 },
    { id: 2 },
  ]);
  assert.deepEqual(rows(database, 'SELECT name FROM named ORDER BY name'), [
    { name: 'first' },
    { name: 'second' },
  ]);
  assert.throws(
    () => database.exec("INSERT INTO runs (id, name) VALUES (3, 'first')"),
    /UNIQUE constraint failed: runs\.name/,
  );
});

test('with rows keep, a stale index on a table that fits is made again, and the table keeps its rows', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT) STRICT;
    CREATE INDEX runs_name ON runs (name);
    INSERT INTO runs VALUES (1, 'first')`);
  const declaration = new Declaration(
    [
      'CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT) STRICT',
      'CREATE UNIQUE INDEX runs_name ON runs (name)',
    ],
    { rows: 'keep' },
  );

  declaration.apply(database);

  assert.equal(declaration.drift(database), 'fits');
  assert.equal(count(database, 'runs'), 1);
});

test("with rows keep, a table that refers to itself counts as referenced inside the caller's transaction", async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE steps (id INTEGER PRIMARY KEY, after INTEGER REFERENCES steps (id)) STRICT;
    INSERT INTO steps VALUES (1, NULL), (2, 1)`);
  const declaration = new Declaration(
    [
      'CREATE TABLE steps (id INTEGER PRIMARY KEY, after INTEGER REFERENCES steps (id), name TEXT) STRICT',
    ],
    { rows: 'keep' },
  );

  database.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => declaration.apply(database), {
      message: /needs foreign keys off/,
    });
  } finally {
    database.exec('ROLLBACK');
  }
});

test('with rows keep, a trigger on a rebuilt table that names a dropped column fails apply with the error of SQLite, and the table and its rows stay as they were', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, note TEXT) STRICT;
    CREATE TABLE log (note TEXT) STRICT;
    CREATE TRIGGER runs_gone AFTER DELETE ON runs BEGIN INSERT INTO log VALUES (old.note); END;
    INSERT INTO runs VALUES (1, 'first')`);
  const before = stored(database);
  const declaration = new Declaration(
    ['CREATE TABLE runs (id INTEGER PRIMARY KEY) STRICT'],
    { rows: 'keep' },
  );

  assert.throws(() => declaration.apply(database), {
    message: 'no such column: old.note',
  });

  assert.deepEqual(stored(database), before);
  assert.deepEqual(rows(database, 'SELECT * FROM runs'), [
    { id: 1, note: 'first' },
  ]);
});

test('with rows keep, a view that names a dropped column of a rebuilt table fails apply, and the table and its rows stay as they were', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, note TEXT) STRICT;
    CREATE VIEW notes AS SELECT note FROM runs;
    INSERT INTO runs VALUES (1, 'first')`);
  const before = stored(database);
  const declaration = new Declaration(
    ['CREATE TABLE runs (id INTEGER PRIMARY KEY) STRICT'],
    { rows: 'keep' },
  );

  assert.throws(
    () => declaration.apply(database),
    (error: Error) => {
      assert.equal(error.message, 'The rebuild breaks the view notes.');
      assert.match(String(error.cause), /no such column: note/);
      return true;
    },
  );

  assert.deepEqual(stored(database), before);
  assert.deepEqual(rows(database, 'SELECT * FROM runs'), [
    { id: 1, note: 'first' },
  ]);
});

test('with rows keep, the triggers and views on a rebuilt table that do not name a dropped column work after apply', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT, note TEXT) STRICT;
    CREATE TABLE log (kind TEXT, id INTEGER) STRICT;
    CREATE TRIGGER runs_added AFTER INSERT ON runs BEGIN INSERT INTO log VALUES ('insert', new.id); END;
    CREATE TRIGGER runs_named AFTER UPDATE OF name ON runs BEGIN INSERT INTO log VALUES ('update', new.id); END;
    CREATE TRIGGER runs_gone AFTER DELETE ON runs BEGIN INSERT INTO log VALUES ('delete', old.id); END;
    CREATE VIEW named AS SELECT id, name FROM runs;
    INSERT INTO runs VALUES (1, 'first', 'gone')`);
  const declaration = new Declaration(
    ['CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT) STRICT'],
    { rows: 'keep' },
  );

  declaration.apply(database);

  assert.equal(declaration.drift(database), 'fits');
  database.exec(`INSERT INTO runs VALUES (2, 'second');
    UPDATE runs SET name = 'renamed' WHERE id = 1;
    DELETE FROM runs WHERE id = 2`);
  assert.deepEqual(rows(database, 'SELECT * FROM log'), [
    { kind: 'insert', id: 1 },
    { kind: 'insert', id: 2 },
    { kind: 'update', id: 1 },
    { kind: 'delete', id: 2 },
  ]);
  assert.deepEqual(rows(database, 'SELECT * FROM named'), [
    { id: 1, name: 'renamed' },
  ]);
});

test('with rows keep, a view that was broken before apply does not fail it', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY) STRICT;
    CREATE VIEW lost AS SELECT missing FROM runs;
    INSERT INTO runs VALUES (1)`);
  const declaration = new Declaration(
    ['CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT) STRICT'],
    { rows: 'keep' },
  );

  declaration.apply(database);

  assert.equal(declaration.drift(database), 'fits');
  assert.deepEqual(rows(database, 'SELECT * FROM runs'), [
    { id: 1, name: null },
  ]);
});

test('with rows replace, a stale AUTOINCREMENT table is replaced and the declaration fits', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT) STRICT;
    INSERT INTO jobs (name) VALUES ('first')`);
  const declaration = new Declaration(
    [
      'CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, at TEXT) STRICT',
    ],
    { rows: 'replace' },
  );

  assert.equal(declaration.drift(database), 'stale');
  declaration.apply(database);

  assert.equal(declaration.drift(database), 'fits');
  assert.equal(count(database, 'jobs'), 0);
});

test('with rows replace, a stale FTS5 table is replaced, the declaration fits, and MATCH finds the new rows', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE VIRTUAL TABLE m_fts USING fts5(body);
    INSERT INTO m_fts VALUES ('old')`);
  const declaration = new Declaration(
    ['CREATE VIRTUAL TABLE m_fts USING fts5(body, title)'],
    { rows: 'replace' },
  );

  assert.equal(declaration.drift(database), 'stale');
  declaration.apply(database);

  assert.equal(declaration.drift(database), 'fits');
  database.exec("INSERT INTO m_fts VALUES ('new body', 'new title')");
  assert.deepEqual(
    rows(
      database,
      "SELECT body, title FROM m_fts WHERE m_fts MATCH 'title:new'",
    ),
    [{ body: 'new body', title: 'new title' }],
  );
});

test('an AUTOINCREMENT declaration that the database does not store is missing, when another table already made sqlite_sequence', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(
    'CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT) STRICT',
  );
  const declaration = new Declaration(
    [
      'CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT) STRICT',
    ],
    { rows: 'replace' },
  );

  assert.equal(declaration.drift(database), 'missing');
});

test('with rows keep, a table without INTEGER PRIMARY KEY keeps the rowid of each row, also when a column is named rowid', async () => {
  for (const [older, newer, id] of [
    [
      'CREATE TABLE notes (body TEXT) STRICT',
      'CREATE TABLE notes (body TEXT, at TEXT) STRICT',
      'rowid',
    ],
    [
      'CREATE TABLE notes (rowid TEXT, body TEXT) STRICT',
      'CREATE TABLE notes (rowid TEXT, body TEXT, at TEXT) STRICT',
      '_rowid_',
    ],
    [
      'CREATE TABLE notes (rowid TEXT, _rowid_ TEXT, body TEXT) STRICT',
      'CREATE TABLE notes (rowid TEXT, _rowid_ TEXT, body TEXT, at TEXT) STRICT',
      'oid',
    ],
  ] as const) {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
    using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
    database.exec(`${older};
      INSERT INTO notes (body) VALUES ('a'), ('b'), ('c');
      DELETE FROM notes WHERE body = 'a'`);
    const declaration = new Declaration([newer], { rows: 'keep' });

    declaration.apply(database);

    assert.equal(declaration.drift(database), 'fits');
    assert.deepEqual(
      rows(database, `SELECT ${id} AS id, body FROM notes ORDER BY body`),
      [
        { id: 2, body: 'b' },
        { id: 3, body: 'c' },
      ],
    );
  }
});

test('with rows keep, an AUTOINCREMENT table keeps its counter, so the id of a deleted row is not used again, also when no row is left', async () => {
  for (const [deleted, kept] of [
    [
      'DELETE FROM jobs WHERE id = 3',
      [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ],
    ],
    ['DELETE FROM jobs', []],
  ] as const) {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
    using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
    database.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT) STRICT;
      INSERT INTO jobs (name) VALUES ('a'), ('b'), ('c');
      ${deleted}`);
    const declaration = new Declaration(
      [
        'CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, at TEXT) STRICT',
      ],
      { rows: 'keep' },
    );

    declaration.apply(database);
    database.exec("INSERT INTO jobs (name) VALUES ('d')");

    assert.equal(declaration.drift(database), 'fits');
    assert.deepEqual(rows(database, 'SELECT id, name FROM jobs ORDER BY id'), [
      ...kept,
      { id: 4, name: 'd' },
    ]);
  }
});

test('with rows keep, a stale virtual table fails apply before any change, and its index still finds the right rows', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT) STRICT;
    CREATE VIRTUAL TABLE docs_fts USING fts5(body, content='docs', content_rowid='id');
    INSERT INTO docs VALUES (10, 'apple'), (20, 'banana');
    INSERT INTO docs_fts (rowid, body) SELECT id, body FROM docs`);
  const before = stored(database);
  const declaration = new Declaration(
    [
      'CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT) STRICT',
      "CREATE VIRTUAL TABLE docs_fts USING fts5(body, content='docs', content_rowid='id', prefix='2')",
    ],
    { rows: 'keep' },
  );

  assert.throws(() => declaration.apply(database), {
    message:
      "The virtual table docs_fts cannot keep its rows: declare it in its own declaration with rows: 'replace'.",
  });

  assert.deepEqual(stored(database), before);
  assert.deepEqual(
    rows(database, "SELECT rowid FROM docs_fts WHERE docs_fts MATCH 'banana'"),
    [{ rowid: 20 }],
  );
});

test('an element with two statements fails when the declaration is made, and one statement with a closing semicolon and a comment does not', async () => {
  for (const element of [
    'CREATE TABLE events (at TEXT) STRICT; CREATE TABLE notes (body TEXT) STRICT',
    'CREATE TABLE events (at TEXT) STRICT; notes',
  ])
    assert.throws(() => new Declaration([element], { rows: 'replace' }), {
      message: `An element of a declaration holds one statement. This element holds more: ${element}`,
    });

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  const declaration = new Declaration(
    ['CREATE TABLE events (at TEXT) STRICT; -- the log'],
    { rows: 'replace' },
  );
  declaration.apply(database);

  assert.equal(declaration.drift(database), 'fits');
  assert.deepEqual(stored(database), [
    {
      type: 'table',
      name: 'events',
      sql: 'CREATE TABLE events (at TEXT) STRICT',
    },
  ]);
});

test('an element that makes no object fails when the declaration is made', () => {
  for (const element of [
    'CREATE TABLE IF NOT EXISTS events (at TEXT) STRICT',
    'CREATE TEMP TABLE scratch (at TEXT) STRICT',
    "INSERT INTO events VALUES ('2026-10-23')",
  ])
    assert.throws(
      () =>
        new Declaration(['CREATE TABLE events (at TEXT) STRICT', element], {
          rows: 'replace',
        }),
      {
        message: `An element of a declaration makes one object. This element makes none: ${element}`,
      },
    );
});

test('with rows keep, a WITHOUT ROWID table keeps its rows', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE tags (name TEXT PRIMARY KEY) STRICT, WITHOUT ROWID;
    INSERT INTO tags VALUES ('a'), ('b')`);
  const declaration = new Declaration(
    [
      'CREATE TABLE tags (name TEXT PRIMARY KEY, color TEXT) STRICT, WITHOUT ROWID',
    ],
    { rows: 'keep' },
  );

  declaration.apply(database);

  assert.equal(declaration.drift(database), 'fits');
  assert.deepEqual(rows(database, 'SELECT * FROM tags ORDER BY name'), [
    { name: 'a', color: null },
    { name: 'b', color: null },
  ]);
});

test('with rows keep, a table that becomes a virtual table, or a virtual table that becomes a table, fails apply before any change', async () => {
  for (const [older, newer] of [
    [
      'CREATE TABLE notes (body TEXT)',
      'CREATE VIRTUAL TABLE notes USING fts5(body)',
    ],
    [
      'CREATE VIRTUAL TABLE notes USING fts5(body)',
      'CREATE TABLE notes (body TEXT)',
    ],
  ] as const) {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
    using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
    database.exec(`${older};
      INSERT INTO notes VALUES ('kept')`);
    const before = stored(database);
    const declaration = new Declaration([newer], { rows: 'keep' });

    assert.throws(() => declaration.apply(database), {
      message:
        "The virtual table notes cannot keep its rows: declare it in its own declaration with rows: 'replace'.",
    });

    assert.deepEqual(stored(database), before);
    assert.deepEqual(rows(database, 'SELECT body FROM notes'), [
      { body: 'kept' },
    ]);
  }
});

test('with rows keep, a column that becomes the INTEGER PRIMARY KEY keeps its values, and a new INTEGER PRIMARY KEY takes the old rowids', async () => {
  for (const [older, ids] of [
    ['CREATE TABLE notes (id INTEGER, body TEXT) STRICT', [100, 200]],
    ['CREATE TABLE notes (body TEXT) STRICT', [2, 3]],
  ] as const) {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
    using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
    database.exec(`${older};
      INSERT INTO notes (body) VALUES ('a'), ('b'), ('c');
      DELETE FROM notes WHERE body = 'a'`);
    if (older.includes('id INTEGER'))
      database.exec(`UPDATE notes SET id = rowid * 100 - 100`);
    const declaration = new Declaration(
      ['CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT) STRICT'],
      { rows: 'keep' },
    );

    declaration.apply(database);

    assert.equal(declaration.drift(database), 'fits');
    assert.deepEqual(rows(database, 'SELECT id, body FROM notes ORDER BY id'), [
      { id: ids[0], body: 'b' },
      { id: ids[1], body: 'c' },
    ]);
  }
});

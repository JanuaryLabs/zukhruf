import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

import { Federation, TooManyDatabasesError } from './index.ts';

// A database the host keeps: one table t with the values given.
function writeDatabase(path: string, values: readonly number[]): void {
  using database = new DatabaseSync(path);
  database.exec('CREATE TABLE t (x INTEGER)');
  const insert = database.prepare('INSERT INTO t (x) VALUES (?)');
  for (const value of values) insert.run(value);
}

// The schemas the handle has open between statements, as a condition can
// read them.
function attachedNames(federation: Federation): unknown[] {
  return federation.sql.all`SELECT name FROM pragma_database_list`.map(
    ({ name }) => name,
  );
}

test('a main database preserves its schema, presets and read-only behavior when also located by name', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'main.sqlite');
  writeDatabase(path, [1]);
  const locate = (name: string) => (name === 'd' ? path : undefined);
  const federation = new Federation({ main: path, locate });
  {
    using owned = federation;
    owned.exec('CREATE TEMP VIEW preset AS SELECT x FROM main.t');
    assert.deepEqual(owned.query('SELECT x FROM preset'), {
      columns: ['x'],
      rows: [[1]],
    });
    assert.equal(owned.sql.get`SELECT x FROM t`?.x, 1);
    assert.deepEqual(
      owned.query('SELECT m.x FROM main.t m JOIN d.t d USING (x)').rows,
      [[1]],
    );
    assert.deepEqual(owned.query('PRAGMA main.table_info(t)').rows, [
      [0, 'x', 'INTEGER', 0, null, 0],
    ]);
    assert.deepEqual(owned.query('SELECT name FROM sqlite_schema').rows, [
      ['t'],
    ]);
    assert.deepEqual(owned.query('SELECT x AS value FROM main.t WHERE 0'), {
      columns: ['value'],
      rows: [],
    });
    assert.throws(() => owned.query('DELETE FROM main.t'), /readonly/);
    assert.throws(
      () => owned.query('SELECT * FROM unknown.t'),
      /no such table: unknown.t/,
    );
    assert.deepEqual(attachedNames(owned), ['main', 'temp']);
    using writer = new DatabaseSync(path, { timeout: 0 });
    writer.exec('INSERT INTO t VALUES (2)');
    assert.deepEqual(owned.query('SELECT x FROM main.t ORDER BY x').rows, [
      [1],
      [2],
    ]);
  }
  assert.throws(() => federation.query('SELECT 1'), /not open/);
  const absent = join(scratch.path, 'absent.sqlite');
  assert.throws(
    () => new Federation({ main: absent, locate }),
    /unable to open database/,
  );
  assert.equal(existsSync(absent), false);
});

test('a named main stays open while its name locates a new path for later statements', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const first = join(scratch.path, 'first.sqlite');
  const second = join(scratch.path, 'second.sqlite');
  writeDatabase(first, [1]);
  writeDatabase(second, [2]);
  const paths = new Map([['d', first]]);
  using federation = new Federation({
    main: { name: 'd' },
    locate: (name) => paths.get(name),
  });
  assert.deepEqual(attachedNames(federation), ['main']);
  assert.equal(federation.sql.get`SELECT x FROM t`?.x, 1);
  federation.exec('CREATE TEMP VIEW preset AS SELECT x FROM main.t');
  paths.set('d', second);
  assert.deepEqual(federation.query('SELECT p.x, d.x FROM preset p, d.t d'), {
    columns: ['x', 'x'],
    rows: [[1, 2]],
  });
  assert.deepEqual(federation.query('PRAGMA main.table_info(t)').rows, [
    [0, 'x', 'INTEGER', 0, null, 0],
  ]);
  assert.throws(() => federation.query('DELETE FROM main.t'), /readonly/);
  assert.deepEqual(attachedNames(federation), ['main', 'temp']);
  assert.deepEqual(federation.query('SELECT x FROM main.t').rows, [[1]]);
});

test('a named main must resolve to an existing database and preserves locate errors', async () => {
  assert.throws(
    () =>
      new Federation({ main: { name: 'unknown' }, locate: () => undefined }),
    { message: 'Unknown main database unknown' },
  );
  const unreadable = new Error('the host cannot read its settings');
  assert.throws(
    () =>
      new Federation({
        main: { name: 'd' },
        locate: () => {
          throw unreadable;
        },
      }),
    (error) => error === unreadable,
  );
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const absent = join(scratch.path, 'absent.sqlite');
  assert.throws(
    () => new Federation({ main: { name: 'absent' }, locate: () => absent }),
    /unable to open database/,
  );
  assert.equal(existsSync(absent), false);
});

test('main stays open while up to ten additional databases attach for one statement', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const main = join(scratch.path, 'main.sqlite');
  writeDatabase(main, [100]);
  const paths = new Map<string, string>();
  for (let index = 0; index < 10; index++) {
    const path = join(scratch.path, `d${index}.sqlite`);
    writeDatabase(path, [index]);
    paths.set(`d${index}`, path);
  }
  using federation = new Federation({
    main,
    locate: (name) => paths.get(name),
  });
  federation.exec(
    'CREATE TEMP VIEW combined AS SELECT m.x + d.x AS x FROM main.t m, d1.t d',
  );
  assert.equal(federation.sql.get`SELECT x FROM combined`?.x, 101);
  assert.deepEqual(attachedNames(federation), ['main', 'temp']);
  assert.deepEqual(
    federation.query('SELECT t.x FROM t JOIN d0.t d ON d.x = 0').rows,
    [[100]],
  );
  assert.deepEqual(
    federation.query(
      `SELECT x FROM main.t UNION ALL ${[...paths.keys()].map((name) => `SELECT x FROM ${name}.t`).join(' UNION ALL ')}`,
    ).rows,
    [[100], ...Array.from({ length: 10 }, (_, index) => [index])],
  );
  assert.throws(
    () => federation.query('SELECT * FROM main.t, d0.missing'),
    /no such table: d0.missing/,
  );
  assert.throws(() => federation.query('DELETE FROM d0.t'), /readonly/);
  assert.deepEqual(attachedNames(federation), ['main', 'temp']);
  assert.deepEqual(federation.query('SELECT x FROM main.t').rows, [[100]]);
});

test('a statement that names more than 10 databases fails with TooManyDatabasesError and leaves none attached', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const paths = new Map<string, string>();
  for (let index = 0; index <= 10; index++) {
    const path = join(scratch.path, `d${index}.sqlite`);
    writeDatabase(path, [index]);
    paths.set(`d${index}`, path);
  }
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => paths.get(name),
  });

  assert.throws(
    () =>
      federation.sql.all`
        SELECT x FROM d0.t UNION ALL SELECT x FROM d1.t UNION ALL
        SELECT x FROM d2.t UNION ALL SELECT x FROM d3.t UNION ALL
        SELECT x FROM d4.t UNION ALL SELECT x FROM d5.t UNION ALL
        SELECT x FROM d6.t UNION ALL SELECT x FROM d7.t UNION ALL
        SELECT x FROM d8.t UNION ALL SELECT x FROM d9.t UNION ALL
        SELECT x FROM d10.t`,
    (error) => {
      assert.ok(error instanceof TooManyDatabasesError);
      assert.deepEqual([...error.names].sort(), [...paths.keys()].sort());
      assert.match(error.message, /split/i);
      return true;
    },
  );
  assert.deepEqual(attachedNames(federation), ['main']);
});

test('a name the host cannot locate fails with SQLite’s own error', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'd.sqlite');
  writeDatabase(path, [1]);
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => (name === 'd' ? path : undefined),
  });

  // Every database has sqlite_schema, so a database attached in place of the
  // unknown name would answer.
  assert.throws(
    () => federation.sql.all`SELECT name FROM elsewhere.sqlite_schema`,
    { message: 'no such table: elsewhere.sqlite_schema' },
  );
  assert.deepEqual(attachedNames(federation), ['main']);
});

test('a table its database lacks fails with SQLite’s own error and leaves none attached', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'd.sqlite');
  writeDatabase(path, [1]);
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => (name === 'd' ? path : undefined),
  });

  assert.throws(() => federation.sql.all`SELECT x FROM d.missing`, {
    message: 'no such table: d.missing',
  });
  assert.deepEqual(attachedNames(federation), ['main']);
});

test('a path to a file that does not exist fails with SQLite’s own error and leaves none attached', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const first = join(scratch.path, 'first.sqlite');
  writeDatabase(first, [1]);
  const paths = new Map([
    ['first', first],
    ['absent', join(scratch.path, 'absent.sqlite')],
  ]);
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => paths.get(name),
  });

  // SQLite resolves a FROM list from left to right, so first is attached
  // before absent fails.
  assert.throws(
    () => federation.sql.all`SELECT a.x FROM first.t a, absent.t b`,
    { message: /unable to open database/ },
  );
  assert.deepEqual(attachedNames(federation), ['main']);
});

test('a locate that throws fails the statement with its error and leaves none attached', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const first = join(scratch.path, 'first.sqlite');
  writeDatabase(first, [1]);
  const unreadable = new Error('the host cannot read its settings');
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => {
      if (name === 'first') return first;
      throw unreadable;
    },
  });

  assert.throws(
    () => federation.sql.all`SELECT a.x FROM first.t a, second.t b`,
    (error) => error === unreadable,
  );
  assert.deepEqual(attachedNames(federation), ['main']);
});

test('a statement cannot change a database it reads', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'd.sqlite');
  writeDatabase(path, [1]);
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => (name === 'd' ? path : undefined),
  });

  assert.throws(
    () => federation.sql.all`INSERT INTO d.t (x) VALUES (2) RETURNING x`,
    { message: /readonly database/ },
  );
  using database = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT x FROM t')
      .all()
      .map(({ x }) => x),
    [1],
  );
});

test('a writer commits between two statements', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'd.sqlite');
  writeDatabase(path, [1]);
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => (name === 'd' ? path : undefined),
  });
  assert.deepEqual(
    federation.sql.all`SELECT x FROM d.t`.map(({ x }) => x),
    [1],
  );

  using writer = new DatabaseSync(path, { timeout: 0 });
  writer.exec('INSERT INTO t (x) VALUES (2)');

  assert.deepEqual(
    federation.sql.all`SELECT x FROM d.t ORDER BY x`.map(({ x }) => x),
    [1, 2],
  );
});

test('a database that moves between statements is read from its new path', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const before = join(scratch.path, 'before.sqlite');
  const after = join(scratch.path, 'after.sqlite');
  writeDatabase(before, [1]);
  writeDatabase(after, [2]);
  let path = before;
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => (name === 'd' ? path : undefined),
  });
  // One cached statement runs again after its database was detached.
  const read = () => federation.sql.all`SELECT x FROM d.t`.map(({ x }) => x);
  assert.deepEqual(read(), [1]);

  path = after;

  assert.deepEqual(read(), [2]);
});

test('a statement reads a database that it names by schema', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'd.sqlite');
  writeDatabase(path, [1, 2]);
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => (name === 'd' ? path : undefined),
  });

  const all = federation.sql.all`SELECT x FROM d.t ORDER BY x`;
  const afterAll = attachedNames(federation);
  const one = federation.sql.get`SELECT count(*) AS n FROM d.t`;
  const afterGet = attachedNames(federation);

  assert.deepEqual(
    all.map(({ x }) => x),
    [1, 2],
  );
  assert.equal(one?.n, 2);
  assert.deepEqual(afterAll, ['main']);
  assert.deepEqual(afterGet, ['main']);
});

test('one statement joins two databases', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const paths = new Map([
    ['left', join(scratch.path, 'left.sqlite')],
    ['right', join(scratch.path, 'right.sqlite')],
  ]);
  writeDatabase(join(scratch.path, 'left.sqlite'), [1, 2, 3]);
  writeDatabase(join(scratch.path, 'right.sqlite'), [2, 3, 4]);
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => paths.get(name),
  });

  const rows = federation.sql.all`
    SELECT l.x FROM left.t l JOIN right.t r ON r.x = l.x ORDER BY l.x`;

  assert.deepEqual(
    rows.map(({ x }) => x),
    [2, 3],
  );
});

test('one statement reads 10 databases', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const paths = new Map<string, string>();
  for (let index = 0; index < 10; index++) {
    const path = join(scratch.path, `d${index}.sqlite`);
    writeDatabase(path, [index]);
    paths.set(`d${index}`, path);
  }
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => paths.get(name),
  });

  const rows = federation.sql.all`
    SELECT x FROM d0.t UNION ALL SELECT x FROM d1.t UNION ALL
    SELECT x FROM d2.t UNION ALL SELECT x FROM d3.t UNION ALL
    SELECT x FROM d4.t UNION ALL SELECT x FROM d5.t UNION ALL
    SELECT x FROM d6.t UNION ALL SELECT x FROM d7.t UNION ALL
    SELECT x FROM d8.t UNION ALL SELECT x FROM d9.t
    ORDER BY x`;

  assert.deepEqual(
    rows.map(({ x }) => x),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test('a SQL file defines temporary views read by raw and tagged queries across databases', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const left = join(scratch.path, 'left.sqlite');
  const right = join(scratch.path, 'right.sqlite');
  writeDatabase(left, [1, 2]);
  writeDatabase(right, [2, 3]);
  const paths = new Map([
    ['left', left],
    ['right', right],
  ]);
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => paths.get(name),
  });
  federation.exec(`
    CREATE TEMP VIEW matches AS SELECT l.x FROM left.t l JOIN right.t r USING (x);
    CREATE TEMP VIEW doubled AS SELECT x * 2 AS x FROM matches;
  `);

  assert.deepEqual(federation.query('SELECT x FROM doubled'), {
    columns: ['x'],
    rows: [[4]],
  });
  assert.deepEqual(attachedNames(federation), ['main', 'temp']);
  assert.equal(federation.sql.get`SELECT x FROM doubled`?.x, 4);
  assert.deepEqual(attachedNames(federation), ['main', 'temp']);
  using writer = new DatabaseSync(right);
  writer.exec('INSERT INTO t VALUES (1)');
  assert.deepEqual(federation.query('SELECT x FROM doubled ORDER BY x'), {
    columns: ['x'],
    rows: [[2], [4]],
  });
});

test('raw SQL preserves column positions, empty headers and qualified table resolution', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const first = join(scratch.path, 'first.sqlite');
  const second = join(scratch.path, 'second.sqlite');
  writeDatabase(first, [1]);
  writeDatabase(second, [2]);
  const paths = new Map([
    ['first', first],
    ['second', second],
  ]);
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => paths.get(name),
  });

  assert.deepEqual(federation.query('SELECT x FROM first.t'), {
    columns: ['x'],
    rows: [[1]],
  });
  assert.deepEqual(federation.query('SELECT x FROM second.t'), {
    columns: ['x'],
    rows: [[2]],
  });
  assert.throws(() => federation.query('SELECT x FROM t'), /no such table: t/);
  assert.deepEqual(federation.query('PRAGMA table_info(t)').rows, []);
  assert.deepEqual(federation.query('SELECT 1 AS same, 2 AS same'), {
    columns: ['same', 'same'],
    rows: [[1, 2]],
  });
  assert.deepEqual(federation.query('SELECT x AS value FROM first.t WHERE 0'), {
    columns: ['value'],
    rows: [],
  });
  const pragma = federation.query('PRAGMA first.table_info(t)');
  assert.deepEqual(pragma.columns, [
    'cid',
    'name',
    'type',
    'notnull',
    'dflt_value',
    'pk',
  ]);
  assert.deepEqual(pragma.rows, [[0, 'x', 'INTEGER', 0, null, 0]]);
  assert.deepEqual(attachedNames(federation), ['main']);
});

test('PRAGMAs discover bare and quoted database names through raw SQL and bound parameters', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'd.sqlite');
  writeDatabase(path, [1]);
  const schemas = [
    ['contacts', 'contacts'],
    ['"call-history"', 'call-history'],
    ['[call-history]', 'call-history'],
    ['"a""b"', 'a"b'],
    ["'o''brien'", "o'brien"],
    ['`a``b`', 'a`b'],
    ['"a.b"', 'a.b'],
  ] as const;
  const paths = new Map<string, string>(
    schemas.map(([, name]) => [name, path]),
  );
  const located: string[] = [];
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => {
      located.push(name);
      return paths.get(name);
    },
  });

  for (const [token, name] of schemas) {
    located.length = 0;
    assert.deepEqual(federation.query(`PRAGMA ${token}.table_info(t)`).rows, [
      [0, 'x', 'INTEGER', 0, null, 0],
    ]);
    assert.deepEqual(located, [name]);
    assert.deepEqual(attachedNames(federation), ['main']);
    assert.deepEqual(
      federation.query(
        `SELECT name FROM pragma_table_info('t', '${name.replaceAll("'", "''")}')`,
      ).rows,
      [['x']],
    );
    assert.deepEqual(
      federation.sql.all`SELECT name FROM pragma_table_info('t', ${name})`.map(
        ({ name }) => name,
      ),
      ['x'],
    );
    assert.deepEqual(
      federation.query(`PRAGMA ${token}.table_info(missing)`).rows,
      [],
    );
    assert.deepEqual(attachedNames(federation), ['main']);
  }
  for (const sql of [
    'PRAGMA missing.table_info(t)',
    "SELECT * FROM contacts.t, pragma_table_info('t', 'missing')",
  ]) {
    assert.throws(() => federation.query(sql), /unknown database '?missing'?/);
    assert.deepEqual(attachedNames(federation), ['main']);
  }
  assert.deepEqual(federation.query('PRAGMA main.table_info(t)').rows, []);
});

test('raw SQL rejects second statements before executing and detaches on failure', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'd.sqlite');
  writeDatabase(path, [1]);
  const paths = new Map([['d', path]]);
  using federation = new Federation({
    main: ':memory:',
    locate: (name) => paths.get(name),
  });

  assert.deepEqual(
    federation.query("SELECT ';' AS value; -- tail\n; /* done */"),
    {
      columns: ['value'],
      rows: [[';']],
    },
  );
  for (const tail of ['SELECT 2', 'malformed sql', 'SELECT * FROM absent.t']) {
    assert.throws(
      () =>
        federation.query(
          `CREATE TEMP TABLE rejected AS SELECT x FROM d.t; ${tail}`,
        ),
      {
        message: 'Run one SQL statement at a time',
      },
    );
    assert.equal(attachedNames(federation).includes('d'), false);
    assert.equal(
      federation.sql
        .get`SELECT count(*) AS n FROM temp.sqlite_schema WHERE name = 'rejected'`
        ?.n,
      0,
    );
  }
  assert.throws(
    () => federation.query('SELECT * FROM d.missing'),
    /no such table: d.missing/,
  );
  assert.throws(
    () => federation.query('SELECT a.x FROM d.t a JOIN absent.t b USING (x)'),
    /no such table: absent.t/,
  );
  assert.throws(() => federation.query('DELETE FROM d.t'), /readonly/);
  assert.deepEqual(federation.query('SELECT x FROM d.t'), {
    columns: ['x'],
    rows: [[1]],
  });
  assert.deepEqual(attachedNames(federation), ['main', 'temp']);
});

test('a configured busy timeout waits for a writer before reading an attached database', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'federation-'));
  const path = join(scratch.path, 'd.sqlite');
  writeDatabase(path, [1]);
  using federation = new Federation({
    main: ':memory:',
    locate: () => path,
    timeout: 2_000,
  });
  const writer = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(workerData);
    database.exec('BEGIN EXCLUSIVE; INSERT INTO t VALUES (2)');
    parentPort.postMessage('locked');
    setTimeout(() => { database.exec('COMMIT'); database.close(); }, 500);
  `,
    { eval: true, workerData: path },
  );
  try {
    await once(writer, 'message');
    assert.deepEqual(federation.query('SELECT x FROM d.t ORDER BY x'), {
      columns: ['x'],
      rows: [[1], [2]],
    });
  } finally {
    await writer.terminate();
  }
});

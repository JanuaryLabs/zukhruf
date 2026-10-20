import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { transaction } from './index.ts';

function notes(database: DatabaseSync): unknown[] {
  return database
    .prepare('SELECT body FROM notes ORDER BY rowid')
    .all()
    .map(({ body }) => body);
}

test('a transaction commits when the work returns, and gives the value of the work', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'transaction-'));
  const path = join(scratch.path, 'data.sqlite');
  using database = new DatabaseSync(path);
  database.exec('CREATE TABLE notes (body TEXT) STRICT');

  const value = transaction(
    database,
    () => {
      database.exec("INSERT INTO notes VALUES ('a')");
      return 42;
    },
    { mode: 'deferred' },
  );

  assert.equal(value, 42);
  assert.equal(database.isTransaction, false);
  using reader = new DatabaseSync(path);
  assert.deepEqual(notes(reader), ['a']);
});

test('a transaction rolls back when the work throws, and throws the same error', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'transaction-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec('CREATE TABLE notes (body TEXT) STRICT');
  const failure = new Error('work failed');

  const thrown = (() => {
    try {
      transaction(
        database,
        () => {
          database.exec("INSERT INTO notes VALUES ('a')");
          throw failure;
        },
        { mode: 'immediate' },
      );
    } catch (error) {
      return error;
    }
  })();

  assert.equal(thrown, failure);
  assert.equal(database.isTransaction, false);
  assert.deepEqual(notes(database), []);
});

test('when SQLite ends the transaction itself, the transaction throws the original error', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'transaction-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE notes (body TEXT) STRICT;
    CREATE TRIGGER notes_refused BEFORE INSERT ON notes WHEN NEW.body = 'refused'
      BEGIN SELECT RAISE(ROLLBACK, 'refused by trigger'); END`);

  assert.throws(
    () =>
      transaction(
        database,
        () => {
          database.exec("INSERT INTO notes VALUES ('a')");
          database.exec("INSERT INTO notes VALUES ('refused')");
        },
        { mode: 'immediate' },
      ),
    { message: 'refused by trigger', errcode: 1811 },
  );

  assert.equal(database.isTransaction, false);
  assert.deepEqual(notes(database), []);
});

test('a nested transaction that throws undoes only its own rows, and the outer transaction commits', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'transaction-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec('CREATE TABLE notes (body TEXT) STRICT');
  const failure = new Error('inner failed');

  transaction(
    database,
    () => {
      database.exec("INSERT INTO notes VALUES ('outer')");
      assert.throws(
        () =>
          transaction(
            database,
            () => {
              database.exec("INSERT INTO notes VALUES ('inner')");
              throw failure;
            },
            { mode: 'immediate' },
          ),
        (error) => error === failure,
      );
      assert.equal(database.isTransaction, true);
      transaction(
        database,
        () => database.exec("INSERT INTO notes VALUES ('kept')"),
        { mode: 'immediate' },
      );
    },
    { mode: 'immediate' },
  );

  assert.equal(database.isTransaction, false);
  assert.deepEqual(notes(database), ['outer', 'kept']);
});

test('a savepoint that throws after a nested savepoint failed undoes its own rows too', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'transaction-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec('CREATE TABLE notes (body TEXT) STRICT');

  transaction(
    database,
    () => {
      database.exec("INSERT INTO notes VALUES ('outer')");
      assert.throws(
        () =>
          transaction(
            database,
            () => {
              database.exec("INSERT INTO notes VALUES ('middle')");
              assert.throws(
                () =>
                  transaction(
                    database,
                    () => {
                      database.exec("INSERT INTO notes VALUES ('inner')");
                      throw new Error('inner failed');
                    },
                    { mode: 'immediate' },
                  ),
                /inner failed/,
              );
              throw new Error('middle failed');
            },
            { mode: 'immediate' },
          ),
        /middle failed/,
      );
    },
    { mode: 'immediate' },
  );

  assert.deepEqual(notes(database), ['outer']);
});

test('a savepoint that throws after a nested savepoint committed undoes the rows of both', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'transaction-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec('CREATE TABLE notes (body TEXT) STRICT');

  transaction(
    database,
    () => {
      database.exec("INSERT INTO notes VALUES ('outer')");
      assert.throws(
        () =>
          transaction(
            database,
            () => {
              database.exec("INSERT INTO notes VALUES ('middle')");
              transaction(
                database,
                () => database.exec("INSERT INTO notes VALUES ('inner')"),
                { mode: 'immediate' },
              );
              throw new Error('middle failed');
            },
            { mode: 'immediate' },
          ),
        /middle failed/,
      );
    },
    { mode: 'immediate' },
  );

  assert.deepEqual(notes(database), ['outer']);
});

test('when SQLite ends the outer transaction inside a nested transaction, the nested transaction throws the original error', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'transaction-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec(`CREATE TABLE notes (body TEXT) STRICT;
    CREATE TRIGGER notes_refused BEFORE INSERT ON notes WHEN NEW.body = 'refused'
      BEGIN SELECT RAISE(ROLLBACK, 'refused by trigger'); END`);
  database.exec('BEGIN');
  database.exec("INSERT INTO notes VALUES ('outer')");

  assert.throws(
    () =>
      transaction(
        database,
        () => database.exec("INSERT INTO notes VALUES ('refused')"),
        { mode: 'immediate' },
      ),
    { message: 'refused by trigger', errcode: 1811 },
  );

  assert.equal(database.isTransaction, false);
  assert.deepEqual(notes(database), []);
});

test('mode immediate takes the write lock at BEGIN, and mode deferred takes it at the first write of the transaction', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'transaction-'));
  const path = join(scratch.path, 'data.sqlite');
  using database = new DatabaseSync(path);
  database.exec('CREATE TABLE notes (body TEXT) STRICT');
  using other = new DatabaseSync(path, { timeout: 0 });
  const write = () => other.exec("INSERT INTO notes VALUES ('other')");

  transaction(
    database,
    () => assert.throws(write, { errcode: 5, message: 'database is locked' }),
    { mode: 'immediate' },
  );
  transaction(
    database,
    () => {
      assert.doesNotThrow(write);
      database.exec("INSERT INTO notes VALUES ('own')");
      assert.throws(write, { errcode: 5, message: 'database is locked' });
    },
    { mode: 'deferred' },
  );

  assert.deepEqual(notes(database), ['other', 'own']);
});

test('mode exclusive keeps other connections from reading', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'transaction-'));
  const path = join(scratch.path, 'data.sqlite');
  using database = new DatabaseSync(path);
  database.exec('CREATE TABLE notes (body TEXT) STRICT');
  using other = new DatabaseSync(path, { timeout: 0 });

  transaction(
    database,
    () =>
      assert.throws(() => notes(other), {
        errcode: 5,
        message: 'database is locked',
      }),
    { mode: 'exclusive' },
  );

  assert.deepEqual(notes(other), []);
});

test('work that returns a promise fails with a TypeError, and its rows are rolled back', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'transaction-'));
  using database = new DatabaseSync(join(scratch.path, 'data.sqlite'));
  database.exec('CREATE TABLE notes (body TEXT) STRICT');
  // TypeScript refuses an async function here; a caller in JavaScript can
  // still pass one.
  const work: () => unknown = async () => {
    database.exec("INSERT INTO notes VALUES ('a')");
  };

  assert.throws(
    () => transaction(database, work, { mode: 'immediate' }),
    TypeError,
  );

  assert.equal(database.isTransaction, false);
  assert.deepEqual(notes(database), []);
});

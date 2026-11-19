import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  SQLITE_BUSY,
  SQLITE_CONSTRAINT_FOREIGNKEY,
  SQLITE_CONSTRAINT_NOTNULL,
  SQLITE_CONSTRAINT_UNIQUE,
  SQLITE_ERROR,
  sqliteResultCode,
} from './index.ts';

// SQLite's primary code for every constraint variant.
const SQLITE_CONSTRAINT = 19;

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail('expected the statement to throw');
}

test('a NOT NULL violation reads as the constraint code with its NOT NULL variant', () => {
  // Arrange
  using database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE item (name TEXT NOT NULL)');

  // Act
  const error = thrownBy(() =>
    database.exec('INSERT INTO item DEFAULT VALUES'),
  );

  // Assert
  assert.deepStrictEqual(sqliteResultCode(error), {
    code: SQLITE_CONSTRAINT,
    extendedCode: SQLITE_CONSTRAINT_NOTNULL,
  });
});

test('a UNIQUE index violation reads as the constraint code with its UNIQUE variant', () => {
  // Arrange
  using database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE item (name TEXT UNIQUE)');
  database.exec("INSERT INTO item VALUES ('a')");

  // Act
  const error = thrownBy(() => database.exec("INSERT INTO item VALUES ('a')"));

  // Assert
  assert.deepStrictEqual(sqliteResultCode(error), {
    code: SQLITE_CONSTRAINT,
    extendedCode: SQLITE_CONSTRAINT_UNIQUE,
  });
});

test('a foreign key violation reads as the constraint code with its FOREIGNKEY variant', () => {
  // Arrange
  using database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
  database.exec('CREATE TABLE child (parent INTEGER REFERENCES parent (id))');

  // Act
  const error = thrownBy(() => database.exec('INSERT INTO child VALUES (1)'));

  // Assert
  assert.deepStrictEqual(sqliteResultCode(error), {
    code: SQLITE_CONSTRAINT,
    extendedCode: SQLITE_CONSTRAINT_FOREIGNKEY,
  });
});

test('a syntax error reads as SQLITE_ERROR in both parts', () => {
  // Arrange
  using database = new DatabaseSync(':memory:');

  // Act
  const error = thrownBy(() => database.exec('SELEC 1'));

  // Assert
  assert.deepStrictEqual(sqliteResultCode(error), {
    code: SQLITE_ERROR,
    extendedCode: SQLITE_ERROR,
  });
});

test('a write that another connection holds the lock for reads as SQLITE_BUSY', () => {
  // Arrange
  const folder = mkdtempSync(join(tmpdir(), 'result-code-'));
  try {
    const path = join(folder, 'busy.db');
    using holder = new DatabaseSync(path);
    using waiter = new DatabaseSync(path, { timeout: 0 });
    holder.exec('BEGIN IMMEDIATE');

    // Act
    const error = thrownBy(() => waiter.exec('BEGIN IMMEDIATE'));

    // Assert
    assert.deepStrictEqual(sqliteResultCode(error), {
      code: SQLITE_BUSY,
      extendedCode: SQLITE_BUSY,
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('an error that node:sqlite did not throw has no result code', () => {
  // Arrange
  const values = [
    new Error('not from SQLite'),
    { errcode: SQLITE_BUSY },
    'text',
  ];

  // Act
  const codes = values.map((value) => sqliteResultCode(value));

  // Assert
  assert.deepStrictEqual(codes, [undefined, undefined, undefined]);
});

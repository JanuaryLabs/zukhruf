import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';

import * as sqliteVec from 'sqlite-vec';

import { test } from '@zukhruf/parameterized-test';
import { open } from '@zukhruf/sqlite-open';

import {
  BitVector,
  Int8Vector,
  Vector,
  cosineDistance,
  euclideanDistance,
  hammingDistance,
} from './index.ts';
import { SqliteVecLoadedError, fromSql, install, toSql } from './sqlite.ts';

function withSqliteVec(): DatabaseSync {
  const database = open(':memory:', { allowExtension: true });
  database.loadExtension(sqliteVec.getLoadablePath());
  return database;
}

test('sqlite-vec reads the bytes of toSql as the same vector', () => {
  // Arrange
  using database = withSqliteVec();
  const json = (sql: string, blob: Uint8Array) =>
    JSON.parse(String(database.prepare(`SELECT ${sql} AS j`).get(blob)?.['j']));
  const bits = [
    true,
    false,
    false,
    true,
    false,
    false,
    false,
    false,
    false,
    true,
    true,
    false,
    false,
    false,
    false,
    true,
  ];

  // Act and Assert
  assert.deepEqual(
    json('vec_to_json(vec_f32(?))', toSql(Vector.from([0.5, -2, 3.25]))),
    [0.5, -2, 3.25],
  );
  assert.deepEqual(
    json('vec_to_json(vec_int8(?))', toSql(Int8Vector.from([-128, 0, 127]))),
    [-128, 0, 127],
  );
  assert.deepEqual(
    json('vec_to_json(vec_bit(?))', toSql(BitVector.from(bits))),
    bits.map(Number),
  );
});

test('the distances of sqlite-vec on the bytes of toSql equal the distances in memory', () => {
  // Arrange
  using database = withSqliteVec();
  const a = Vector.from([1, 2, 3]);
  const b = Vector.from([-1, 0.5, 4]);
  const x = BitVector.from([
    true,
    true,
    false,
    false,
    true,
    false,
    false,
    false,
  ]);
  const y = BitVector.from([
    true,
    false,
    true,
    false,
    true,
    false,
    false,
    true,
  ]);
  const value = (sql: string, ...parameters: Uint8Array[]) =>
    Number(database.prepare(`SELECT ${sql} AS d`).get(...parameters)?.['d']);

  // Act and Assert
  assert.ok(
    Math.abs(
      value('vec_distance_cosine(?, ?)', toSql(a), toSql(b)) -
        cosineDistance(a, b),
    ) < 1e-6,
  );
  assert.ok(
    Math.abs(
      value('vec_distance_L2(?, ?)', toSql(a), toSql(b)) -
        euclideanDistance(a, b),
    ) < 1e-6,
  );
  assert.equal(
    value('vec_distance_hamming(vec_bit(?), vec_bit(?))', toSql(x), toSql(y)),
    hammingDistance(x, y),
  );
});

test('a vec0 table of sqlite-vec finds the nearest rows of the bytes of toSql', () => {
  // Arrange
  using database = withSqliteVec();
  database.exec(
    `CREATE VIRTUAL TABLE f USING vec0(embedding FLOAT[2] DISTANCE_METRIC=cosine)`,
  );
  database.exec(`CREATE VIRTUAL TABLE i USING vec0(embedding INT8[2])`);
  database.exec(`CREATE VIRTUAL TABLE b USING vec0(embedding BIT[8])`);
  const rows: [number, number[], boolean[]][] = [
    [1, [1, 0], [true, true, true, true, false, false, false, false]],
    [2, [0, 1], [false, false, false, false, true, true, true, true]],
    [3, [1, 0.1], [true, true, true, false, false, false, false, false]],
  ];
  for (const [rowid, values, bits] of rows) {
    database
      .prepare(`INSERT INTO f (rowid, embedding) VALUES (?, ?)`)
      .run(BigInt(rowid), toSql(Vector.from(values)));
    database
      .prepare(`INSERT INTO i (rowid, embedding) VALUES (?, vec_int8(?))`)
      .run(
        BigInt(rowid),
        toSql(Int8Vector.from(values.map((v) => Math.round(v * 100)))),
      );
    database
      .prepare(`INSERT INTO b (rowid, embedding) VALUES (?, vec_bit(?))`)
      .run(BigInt(rowid), toSql(BitVector.from(bits)));
  }
  const nearest = (sql: string, query: Uint8Array) =>
    database
      .prepare(sql)
      .all(query)
      .map((row) => row['rowid']);

  // Act and Assert
  assert.deepEqual(
    nearest(
      `SELECT rowid FROM f WHERE embedding MATCH ? AND k = 2 ORDER BY distance`,
      toSql(Vector.from([1, 0.01])),
    ),
    [1, 3],
  );
  assert.deepEqual(
    nearest(
      `SELECT rowid FROM i WHERE embedding MATCH vec_int8(?) AND k = 2 ORDER BY distance`,
      toSql(Int8Vector.from([100, 1])),
    ),
    [1, 3],
  );
  assert.deepEqual(
    nearest(
      `SELECT rowid FROM b WHERE embedding MATCH vec_bit(?) AND k = 2 ORDER BY distance`,
      toSql(
        BitVector.from([true, true, true, true, false, false, false, false]),
      ),
    ),
    [1, 3],
  );
});

test('fromSql reads back what toSql wrote', () => {
  // Arrange
  const vector = Vector.from([0.1, -2, 3e-7]);
  const small = Int8Vector.from([-128, 5, 127]);
  const bits = BitVector.from([
    true,
    false,
    true,
    true,
    false,
    false,
    false,
    true,
  ]);

  // Act and Assert
  assert.deepEqual(
    [...fromSql(Vector, toSql(vector)).values],
    [...vector.values],
  );
  assert.deepEqual(
    [...fromSql(Int8Vector, toSql(small)).values],
    [...small.values],
  );
  assert.deepEqual(fromSql(BitVector, toSql(bits)).bits, bits.bits);
});

test('fromSql refuses a BLOB whose length does not fit its type', () => {
  // Arrange
  const blob = new Uint8Array(6);

  // Act and Assert
  assert.throws(() => fromSql(Vector, blob), RangeError);
  assert.throws(() => fromSql(Vector, new Uint8Array(0)), RangeError);
});

function withInstall(): DatabaseSync {
  const database = open(':memory:');
  install(database);
  return database;
}

type Outcome = { value: unknown } | { error: string };

function outcome(
  database: DatabaseSync,
  sql: string,
  parameters: (Uint8Array | string)[],
): Outcome {
  try {
    return {
      value: database.prepare(`SELECT ${sql} AS d`).get(...parameters)?.['d'],
    };
  } catch (error) {
    return { error: Error.isError(error) ? error.message : String(error) };
  }
}

test('install refuses a database that loaded sqlite-vec', () => {
  // Arrange
  using database = withSqliteVec();

  // Act and Assert
  assert.throws(() => install(database), SqliteVecLoadedError);
});

// A parameter of a case: numbers are the bytes of a float32 vector, a string
// is the JSON text of a vector, and { bytes } is that many zero bytes.
type Parameter = number[] | string | { bytes: number };

function bind(parameters: Parameter[]): (Uint8Array | string)[] {
  return parameters.map((parameter) =>
    typeof parameter === 'string'
      ? parameter
      : Array.isArray(parameter)
        ? toSql(Vector.from(parameter))
        : new Uint8Array(parameter.bytes),
  );
}

void test.each(
  [
    [
      'vec_distance_cosine(?, ?)',
      [
        [1, 2, 3],
        [1, 2, 4],
      ],
    ],
    [
      'vec_distance_cosine(?, ?)',
      [
        [1, 0],
        [0, 1],
      ],
    ],
    [
      'vec_distance_cosine(?, ?)',
      [
        [0, 0],
        [1, 2],
      ],
    ],
    [
      'vec_distance_cosine(?, ?)',
      [
        [0, 0],
        [0, 0],
      ],
    ],
    ['vec_distance_cosine(?, ?)', ['[1,2,3]', '[1,2,4]']],
    ['vec_distance_cosine(?, ?)', ['[0.5,-1]', [2, 3]]],
    [
      'vec_distance_L2(?, ?)',
      [
        [0, 0],
        [3, 4],
      ],
    ],
    [
      'vec_distance_L2(?, ?)',
      [
        [0, 0],
        [0, 0],
      ],
    ],
    [
      'vec_distance_L2(?, ?)',
      [
        [1.5, -2, 9],
        [0.25, 7, -3],
      ],
    ],
    ['vec_distance_L2(?, ?)', ['[1,2]', '[4,6]']],
  ] satisfies [string, Parameter[]][],
  ([sql, parameters]) =>
    test(`after install, plain SQLite gives the result of sqlite-vec, to float32 precision, for ${sql} with ${JSON.stringify(parameters)}`, () => {
      // Arrange
      using plain = withInstall();
      using extension = withSqliteVec();

      // Act
      const ours = outcome(plain, sql, bind(parameters));
      const theirs = outcome(extension, sql, bind(parameters));

      // Assert
      if (
        'value' in theirs &&
        typeof theirs.value === 'number' &&
        'value' in ours &&
        typeof ours.value === 'number'
      ) {
        assert.ok(
          Math.abs(ours.value - theirs.value) <=
            1e-6 * Math.max(1, Math.abs(theirs.value)),
          `${sql} ${ours.value} ${theirs.value}`,
        );
      } else {
        assert.deepEqual(ours, theirs, sql);
      }
    }),
);

void test.each(
  [
    [
      'vec_distance_cosine(?, ?)',
      [
        [1, 2],
        [1, 2, 3],
      ],
    ],
    [
      'vec_distance_L2(?, ?)',
      [
        [1, 2],
        [1, 2, 3],
      ],
    ],
    ['vec_distance_cosine(?, ?)', [{ bytes: 3 }, [1]]],
    ['vec_distance_cosine(?, ?)', [[1], { bytes: 3 }]],
    ['vec_distance_L2(?, ?)', [{ bytes: 0 }, [1]]],
    ['vec_distance_cosine(?, ?)', ['[]', [1]]],
    ['vec_distance_cosine(NULL, ?)', [[1]]],
    ['vec_distance_cosine(?, NULL)', [[1]]],
    ['vec_distance_L2(7, ?)', [[1]]],
    ['vec_distance_L2(?, 1.5)', [[1]]],
  ] satisfies [string, Parameter[]][],
  ([sql, parameters]) =>
    test(`after install, plain SQLite raises the error text of sqlite-vec for ${sql} with ${JSON.stringify(parameters)}`, () => {
      // Arrange
      using plain = withInstall();
      using extension = withSqliteVec();

      // Act
      const ours = outcome(plain, sql, bind(parameters));
      const theirs = outcome(extension, sql, bind(parameters));

      // Assert
      assert.ok('error' in theirs, `sqlite-vec accepted ${sql}`);
      assert.deepEqual(ours, theirs, sql);
    }),
);

test('the functions of install are deterministic, so an index can use them', () => {
  // Arrange
  using database = withInstall();
  database.exec(`CREATE TABLE chunks (embedding BLOB)`);

  // Act and Assert
  assert.doesNotThrow(() =>
    database.exec(
      `CREATE INDEX near_x ON chunks (vec_distance_cosine(embedding, X'0000803F'))`,
    ),
  );
});

test('after install, a host query filters, sorts by distance and limits in SQL', () => {
  // Arrange
  using database = withInstall();
  database.exec(
    `CREATE TABLE chunks (id TEXT PRIMARY KEY, source TEXT, embedding BLOB)`,
  );
  const rows: [string, string, number[]][] = [
    ['a', 'docs', [1, 0]],
    ['b', 'docs', [0, 1]],
    ['c', 'shared/faq', [1, 0.2]],
    ['d', 'other', [1, 0]],
    ['e', 'docs', [1, 0.5]],
  ];
  for (const [id, source, values] of rows) {
    database
      .prepare(`INSERT INTO chunks VALUES (?, ?, ?)`)
      .run(id, source, toSql(Vector.from(values)));
  }

  // Act
  const nearest = database
    .prepare(
      `SELECT id FROM chunks
       WHERE source = ? OR source LIKE 'shared/%'
       ORDER BY vec_distance_cosine(embedding, ?)
       LIMIT 3`,
    )
    .all('docs', toSql(Vector.from([1, 0])))
    .map((row) => row['id']);

  // Assert
  assert.deepEqual(nearest, ['a', 'c', 'e']);
});

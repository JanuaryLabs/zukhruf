import assert from 'node:assert/strict';
import { test } from 'node:test';

import mssql from 'mssql';

import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  HalfVector,
  Vector,
  cosineDistance,
  dot,
  euclideanDistance,
} from './index.ts';
import { fromSql, sqlType, toSql } from './sqlserver.ts';

// SQL Server 2025 has the VECTOR type; the default image of @zukhruf/testing is 2022.
const image = 'mcr.microsoft.com/mssql/server:2025-latest';

const wave = (seed: number, dimensions: number) =>
  Array.from(
    { length: dimensions },
    (_, index) => Math.sin(seed * 997 + index * 12.9898) * 3,
  );

test('toSql writes the float32 values that the full-precision JSON writes', async () => {
  // Arrange
  await using database = await new SqlServer({
    environment: process.env,
    image,
  }).database();
  const pool = await new mssql.ConnectionPool(
    database.connectionString,
  ).connect();
  try {
    const vectors = Array.from({ length: 50 }, (_, row) =>
      Vector.from(wave(row, 384)),
    );
    const gaps: unknown[] = [];

    // Act
    for (const vector of vectors) {
      const result = await pool
        .request()
        .input('ours', mssql.NVarChar(mssql.MAX), toSql(vector))
        .input(
          'full',
          mssql.NVarChar(mssql.MAX),
          JSON.stringify(Array.from(vector.values)),
        )
        .query(
          `SELECT VECTOR_DISTANCE('euclidean', CAST(@ours AS ${sqlType(vector)}), CAST(@full AS VECTOR(384))) AS gap`,
        );
      gaps.push(result.recordset[0]?.['gap']);
    }

    // Assert
    assert.deepEqual([...new Set(gaps)], [0]);
  } finally {
    await pool.close();
  }
});

test('a half vector keeps each float16 value through VECTOR(n, float16)', async () => {
  // Arrange
  await using database = await new SqlServer({
    environment: process.env,
    image,
  }).database();
  const pool = await new mssql.ConnectionPool(
    database.connectionString,
  ).connect();
  try {
    // Platform setup that no operation of the package exposes: SQL Server 2025
    // keeps float16 vectors behind PREVIEW_FEATURES; Azure SQL has them by default.
    await pool
      .request()
      .query('ALTER DATABASE SCOPED CONFIGURATION SET PREVIEW_FEATURES = ON');
    const half = HalfVector.from(wave(7, 384));

    // Act
    const result = await pool
      .request()
      .input('v', mssql.NVarChar(mssql.MAX), toSql(half))
      .query(
        `SELECT CAST(CAST(@v AS ${sqlType(half)}) AS nvarchar(max)) AS back`,
      );
    const back = fromSql(HalfVector, String(result.recordset[0]?.['back']));

    // Assert
    assert.deepEqual([...back.values], [...half.values]);
  } finally {
    await pool.close();
  }
});

test('fromSql reads a VECTOR column within one unit in the last place of what toSql wrote', async () => {
  // Arrange
  await using database = await new SqlServer({
    environment: process.env,
    image,
  }).database();
  const pool = await new mssql.ConnectionPool(
    database.connectionString,
  ).connect();
  try {
    const vector = Vector.from(wave(3, 384));
    await pool
      .request()
      .query(
        'CREATE TABLE chunks (id INT PRIMARY KEY, embedding VECTOR(384) NOT NULL)',
      );
    await pool
      .request()
      .input('v', mssql.NVarChar(mssql.MAX), toSql(vector))
      .query(`INSERT INTO chunks VALUES (1, CAST(@v AS ${sqlType(vector)}))`);

    // Act
    const text: unknown = (
      await pool.request().query('SELECT embedding FROM chunks')
    ).recordset[0]?.['embedding'];
    const back = fromSql(Vector, String(text));

    // Assert
    assert.equal(typeof text, 'string');
    assert.equal(back.dimensions, vector.dimensions);
    const written = vector.values;
    back.values.forEach((value: number, index: number) => {
      const expected = written[index] ?? Number.NaN;
      assert.ok(
        Math.abs(value - expected) <= Math.abs(expected) * 2 ** -23,
        `element ${index}: ${value} ${expected}`,
      );
    });
  } finally {
    await pool.close();
  }
});

test('a host query sorts by VECTOR_DISTANCE in the order and with the distances of the math in memory', async () => {
  // Arrange
  await using database = await new SqlServer({
    environment: process.env,
    image,
  }).database();
  const pool = await new mssql.ConnectionPool(
    database.connectionString,
  ).connect();
  try {
    const rows: [string, Vector][] = [
      ['a', Vector.from([1, 0, 0])],
      ['b', Vector.from([0, 1, 0])],
      ['c', Vector.from([1, 0.2, 0])],
      ['d', Vector.from([-1, 0, 0])],
      ['e', Vector.from([1, 0.5, 0.1])],
      ['f', Vector.from([0.987654321, 0.123456789, 0.0234567891])],
      ['g', Vector.from([0.876543219, 0.234567891, -0.0345678912])],
    ];
    await pool
      .request()
      .query(
        'CREATE TABLE chunks (id NVARCHAR(10) PRIMARY KEY, embedding VECTOR(3) NOT NULL)',
      );
    for (const [id, vector] of rows) {
      await pool
        .request()
        .input('id', mssql.NVarChar(10), id)
        .input('v', mssql.NVarChar(mssql.MAX), toSql(vector))
        .query(
          `INSERT INTO chunks VALUES (@id, CAST(@v AS ${sqlType(vector)}))`,
        );
    }
    const query = Vector.from([0.991234567, 0.112345678, 0.00456789123]);
    const metrics: [string, (vector: Vector) => number][] = [
      ['cosine', (vector) => cosineDistance(vector, query)],
      ['euclidean', (vector) => euclideanDistance(vector, query)],
      ['dot', (vector) => -dot(vector, query)],
    ];

    for (const [metric, inMemory] of metrics) {
      // Act
      const result = await pool
        .request()
        .input('q', mssql.NVarChar(mssql.MAX), toSql(query))
        .query(
          `SELECT TOP (3) id, VECTOR_DISTANCE('${metric}', embedding, CAST(@q AS ${sqlType(query)})) AS distance
           FROM chunks ORDER BY distance`,
        );

      // Assert
      const expected = rows
        .map(([id, vector]) => ({ id, distance: inMemory(vector) }))
        .sort((left, right) => left.distance - right.distance)
        .slice(0, 3);
      assert.deepEqual(
        result.recordset.map((row) => row['id']),
        expected.map((row) => row.id),
        metric,
      );
      result.recordset.forEach((row, index) => {
        assert.ok(
          Math.abs(
            Number(row['distance']) - (expected[index]?.distance ?? Number.NaN),
          ) < 1e-6,
          `${metric} ${row['id']}`,
        );
      });
    }
  } finally {
    await pool.close();
  }
});

test('fromSql refuses text that is not a JSON array of numbers', () => {
  // Arrange
  const texts = ['[]', '{"0": 1}', '[1, "2"]', '"[1, 2]"'];

  for (const text of texts) {
    // Act and Assert
    assert.throws(() => fromSql(Vector, text), RangeError, text);
  }
});

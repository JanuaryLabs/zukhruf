# @zukhruf/vectors

> Ezz accepted each ADR on 2026-11-18. The first release is built and tested, and not yet on npm.

A vector is a list of numbers that a model makes from a text, so that a program can find texts by meaning. Each database keeps and compares vectors in its own way. SQLite has no vector type, sqlite-vec reads float32 bytes, and SQL Server has its own `VECTOR` type. This package gives the vector types, their math, and the form of each vector in each database.

The package hides no database. It gives values and functions that a program puts into its own SQL, so the program keeps every feature of its database: its indexes, its filters, its joins and its approximate search ([ADR 0002](./docs/adr/0002-the-package-composes-into-the-hosts-sql-and-never-runs-it.md)). The package runs no SQL and opens no connection.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/vectors
```

The package has no dependencies.

### Compare vectors in memory

```ts
import { UnitVector, Vector, cosineDistance } from '@zukhruf/vectors';

const a = Vector.from(embeddingA); // number[] from the AI SDK, or a Float32Array
const b = Vector.from(embeddingB);
cosineDistance(a, b); // 1 − the cosine similarity: 0 for one direction, 2 for opposite
UnitVector.normalize(a); // length 1; a zero vector is a ZeroVectorError
```

### Search in plain SQLite

`install` adds the distance functions of sqlite-vec to a database that does not load the extension. The same SQL then runs with or without sqlite-vec ([ADR 0005](./docs/adr/0005-plain-sqlite-gets-the-distance-functions-of-sqlite-vec.md)).

```ts
import { DatabaseSync } from 'node:sqlite';

import { Vector } from '@zukhruf/vectors';
import { install, toSql } from '@zukhruf/vectors/sqlite';

using database = new DatabaseSync('chunks.sqlite');
install(database);

database.exec(
  `CREATE TABLE chunks (id TEXT PRIMARY KEY, source TEXT, embedding BLOB)`,
);
database
  .prepare(`INSERT INTO chunks VALUES (?, ?, ?)`)
  .run('guide#0', 'docs', toSql(Vector.from(embedding)));

const nearest = database
  .prepare(
    `SELECT id, vec_distance_cosine(embedding, ?) AS distance
     FROM chunks
     WHERE source = ? OR source LIKE 'shared/%'
     ORDER BY distance
     LIMIT 10`,
  )
  .all(toSql(Vector.from(query)), 'docs');
```

### Search with sqlite-vec

The program writes its own `vec0` table, with each feature of sqlite-vec: partition keys, metadata columns, auxiliary columns, int8 and bit vectors. The package gives the bytes.

```ts
database.loadExtension(sqliteVec.getLoadablePath());
database.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(
  source TEXT PARTITION KEY,
  embedding FLOAT[384] DISTANCE_METRIC=cosine,
  +content TEXT
)`);
database
  .prepare(
    `SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = 10 AND source = ?`,
  )
  .all(toSql(Vector.from(query)), 'docs');
```

### Search in SQL Server

```ts
import { Vector } from '@zukhruf/vectors';
import { sqlType, toSql } from '@zukhruf/vectors/sqlserver';

const query = Vector.from(embedding);
await pool.request().input('q', mssql.NVarChar(mssql.MAX), toSql(query)).query(`
    SELECT TOP (10) id, VECTOR_DISTANCE('cosine', embedding, CAST(@q AS ${sqlType(query)})) AS distance
    FROM chunks
    WHERE source = 'docs' OR JSON_VALUE(metadata, '$.shared') = 'true'
    ORDER BY distance`);
```

The approximate search of Azure SQL is the program's own SQL too:

```sql
CREATE VECTOR INDEX ix_chunks ON chunks (embedding) WITH (METRIC = 'cosine', TYPE = 'DiskANN');

DECLARE @qv VECTOR(384) = CAST(@q AS VECTOR(384));
SELECT TOP (10) WITH APPROXIMATE t.id, r.distance
FROM VECTOR_SEARCH(TABLE = chunks AS t, COLUMN = embedding, SIMILAR_TO = @qv, METRIC = 'cosine') AS r
WHERE t.source = 'docs'
ORDER BY r.distance;
```

### Search in Postgres

Postgres has its own client package, [pgvector](https://github.com/pgvector/pgvector-node), whose `toSql` and `fromSql` gave this package its names. Use it for the SQL form, and this package for the vector and its math ([ADR 0001](./docs/adr/0001-the-scope-and-the-name-come-from-the-vector-types-of-pgvector-and-the-math-of-dotnet.md), amendment):

```ts
import pgvector from 'pgvector';

import { UnitVector, Vector } from '@zukhruf/vectors';

const unit = UnitVector.normalize(Vector.from(embedding));
await client.query('INSERT INTO items (embedding) VALUES ($1)', [
  pgvector.toSql(Array.from(unit.values)),
]);
await client.query('SELECT id FROM items ORDER BY embedding <=> $1 LIMIT 10', [
  pgvector.toSql(Array.from(Vector.from(query).values)),
]);
```

### Cache embeddings

Wrap the AI SDK model once. Each `embed` and `embedMany` call through it calls the model only for text it did not embed before ([ADR 0009](./docs/adr/0009-the-embedding-cache-is-a-middleware-of-the-ai-sdk-model-in-the-subpath-embedding-cache.md)). This subpath needs `ai`; the others need nothing.

```ts
import { embedMany, wrapEmbeddingModel } from 'ai';

import { embeddingCacheMiddleware } from '@zukhruf/vectors/embedding-cache';
import { SqliteEmbeddingCacheStore } from '@zukhruf/vectors/sqlite';

const model = wrapEmbeddingModel({
  model: openai.embedding('text-embedding-3-small'),
  middleware: embeddingCacheMiddleware({
    store: new SqliteEmbeddingCacheStore({
      database,
      table: 'embedding_cache',
    }),
  }),
});
const { embeddings } = await embedMany({ model, values: texts }); // misses only reach OpenAI
```

## API

```ts
// @zukhruf/vectors
class Vector {
  static from(values: ArrayLike<number>): Vector;
  readonly values: Float32Array; // a copy: a change to it does not change the vector
  readonly dimensions: number;
}
class HalfVector {
  static from(values: ArrayLike<number>): HalfVector;
  readonly values: Float16Array;
  readonly dimensions: number;
}
class Int8Vector {
  static from(values: ArrayLike<number>): Int8Vector;
  readonly values: Int8Array;
  readonly dimensions: number;
}
class BitVector {
  static from(bits: ArrayLike<boolean>): BitVector; // a multiple of 8 bits
  readonly bits: boolean[]; // a copy
  readonly dimensions: number;
}
class UnitVector extends Vector {
  static normalize(vector: Vector | HalfVector): UnitVector;
}

function dot(a: Vector, b: Vector): number;
function norm(a: Vector): number;
function cosineSimilarity(a: Vector, b: Vector): number;
function cosineDistance(a: Vector, b: Vector): number; // 1 − cosineSimilarity
function euclideanDistance(a: Vector, b: Vector): number; // L2
function hammingDistance(a: BitVector, b: BitVector): number;
// Each function also takes HalfVector and Int8Vector where the engines do; both sides have one type.

// @zukhruf/vectors/sqlite  (plain SQLite and sqlite-vec read the same bytes)
function install(database: DatabaseSync): void; // vec_distance_cosine, vec_distance_L2
class SqliteVecLoadedError extends Error {}
function toSql(vector: Vector | Int8Vector | BitVector): Uint8Array;
function fromSql<
  T extends typeof Vector | typeof Int8Vector | typeof BitVector,
>(type: T, blob: Uint8Array): InstanceType<T>;

// @zukhruf/vectors/sqlserver
function toSql(vector: Vector | HalfVector): string; // JSON text with 9 or 5 significant digits
function sqlType(vector: Vector | HalfVector): string; // 'VECTOR(384)' or 'VECTOR(384, float16)'
function fromSql<T extends typeof Vector | typeof HalfVector>(
  type: T,
  text: string,
): InstanceType<T>;
```

`toSql` and `fromSql` take their names from [pgvector-node](https://github.com/pgvector/pgvector-node), the Postgres client with about one million downloads a week ([ADR 0006](./docs/adr/0006-each-engine-has-tosql-and-fromsql-after-pgvector.md)).

## What each call does underneath

| Call                            | What happens                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Vector.from(values)`           | Copies the values into a new `Float32Array`. A value that is not finite is a `RangeError`                                                                                                                                                                                                       |
| `UnitVector.normalize(v)`       | Divides each value by the length, in float64. A length of 0 is a `ZeroVectorError`                                                                                                                                                                                                              |
| `cosineDistance(a, b)`          | 1 − dot(a, b) / (norm(a) · norm(b)), in float64. Other dimensions are a `DimensionMismatchError`                                                                                                                                                                                                |
| `sqlite.toSql(v)`               | float32 values, little-endian; int8 values as bytes; bits packed least significant bit first, as sqlite-vec packs them                                                                                                                                                                          |
| `sqlite.install(db)`            | `db.function('vec_distance_cosine', …)` and `vec_distance_L2`, deterministic, with the results (to float32 precision), the errors and the `NULL` of sqlite-vec ([ported from sqlite-vec](./docs/ported-from-sqlite-vec.md)). A database that already has sqlite-vec is a `SqliteVecLoadedError` |
| `sqlserver.toSql(v)`            | `JSON.stringify` of each value with 9 significant digits (float32) or 5 (float16) ([ADR 0007](./docs/adr/0007-sql-server-gets-json-text-with-the-digits-that-keep-each-value.md))                                                                                                               |
| `sqlserver.fromSql(type, text)` | `JSON.parse` of the text that SQL Server gives, into the type                                                                                                                                                                                                                                   |

## Errors

| Error                              | When                                                                   | The caller's next step                                   |
| ---------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `DimensionMismatchError`           | Two vectors of one call have other dimensions. `expected` and `actual` | Use one model for both vectors                           |
| `ZeroVectorError` (a `RangeError`) | A vector with no length is normalized                                  | Skip the vector, or fail its record                      |
| `SqliteVecLoadedError`             | `install` on a database that loaded sqlite-vec                         | Use the functions of sqlite-vec, which are already there |

## SQL Server: what the probes found

On Azure SQL Database (General Purpose, 2026-11-18), with throwaway tables:

- `VECTOR(n)` (float32, at most 1,998 dimensions) and `VECTOR(n, float16)` (at most 3,996) work. `VECTOR_DISTANCE('cosine', …)` gives 1 − the cosine similarity.
- A DiskANN index is version 3. The old `TOP_N =` parameter fails with Msg 42274. An index made on an empty table starts in the state `KNN` (exact), and a background task builds its graph about 16 seconds after the rows come.
- `INSERT`, `UPDATE`, `DELETE`, `MERGE` and a cascade from a foreign key show in the next search. `TRUNCATE` works.
- The recall@10 of the approximate search against the exact search was 78/80 to 80/80, also for a source of 3% of the rows.
- SQL Server 2025 RTM in a container has no `VECTOR_SEARCH` and no DiskANN index, so a test can run only the exact search there.

## The same concepts in other systems

| This package                        | pgvector-node                                                | Drizzle ORM                                       | .NET                                                                            | sqlite-vec                       |
| ----------------------------------- | ------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| `Vector`, `HalfVector`, `BitVector` | `toSql(array)`, `SparseVector`                               | `vector({ dimensions })` column                   | `SqlVector<float>` (EF Core)                                                    | `vec_f32`, `vec_int8`, `vec_bit` |
| `cosineDistance(a, b)`              | `cosineDistance(column, vector)` for Knex, Kysely, Sequelize | `cosineDistance(column, vector)` inside `orderBy` | `TensorPrimitives.CosineSimilarity`; `EF.Functions.VectorDistance('cosine', …)` | `vec_distance_cosine(a, b)`      |
| `sqlite.install(db)`                | none                                                         | none                                              | none                                                                            | the extension itself             |
| the program's own SQL               | the query builder's query                                    | `db.select().orderBy(…)`                          | LINQ                                                                            | `vec0` and `MATCH`               |

## Why not an npm package

Checked on 2026-11-18:

| Package                                             | Why it does not do the job                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pgvector` 0.3.1 (MIT, no dependencies, 1 M a week) | Postgres only. It is the model for this package's names, and the package for Postgres (Search in Postgres)       |
| `sqlite-vec` 0.1.9                                  | It loads the extension (`getLoadablePath`, `load`) and gives no bytes and no functions for a database without it |
| `@mastra/core`, `@langchain/core`                   | One store interface that hides each engine; no SQL Server vectors                                                |
| `@memberjunction/ai-vectors-sqlserver`              | BUSL-1.1, and it works only inside MemberJunction                                                                |
| `typeorm`                                           | A `vector` column of an ORM                                                                                      |

## Who moves onto it

The package is designed for its domain. Each program below moves onto it and drops its own copy.

| Program                 | Its copy today                                                     | After                                          |
| ----------------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| `@deepagents/retrieval` | `vectorToBlob` in `stores/sqlite/sqlite.ts`                        | `sqlite.toSql`                                 |
| `@zukhruf/embeddings`   | `UnitVector` and `toBlob` in `src/vector.ts`, cosine in JavaScript | `UnitVector`, `sqlite.toSql`, `cosineDistance` |
| `@eltjs/embedding`      | `unitVector` in `src/embedding.ts` (#4118)                         | `UnitVector`, `sqlite.toSql`                   |
| Context Compiler        | through `@zukhruf/embeddings`                                      | the same                                       |
| datahub                 | none                                                               | `sqlserver.toSql`, `sqlType`                   |

The cache that embeds only new text is the subpath `/embedding-cache` ([ADR 0009](./docs/adr/0009-the-embedding-cache-is-a-middleware-of-the-ai-sdk-model-in-the-subpath-embedding-cache.md)); `vector-decisions` and `@zukhruf/embeddings` move onto it.

## Later

- Hamming in plain SQLite, which needs the `vec_bit` subtype of sqlite-vec.
- Native vectors over TDS, when tedious supports them (pull request #1841).

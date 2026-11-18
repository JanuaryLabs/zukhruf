# @zukhruf/vector-store

> Design on paper, for review: no code exists yet. Each decision waits for Ezz's ruling (2026-11-18).

A program that finds records by meaning keeps a vector for each record and asks a database for the records nearest to a vector. Each database does this in its own way: SQLite has no vector type and stores bytes, sqlite-vec has a virtual table, Postgres has the `vector` type of pgvector, and SQL Server has its own `VECTOR` type. This package gives one interface over the four. A program declares a collection once and keeps its code when it moves to another database.

The package has two layers. A `VectorCollection` stores the vectors that the caller gives. An `EmbeddingCollection` stores text, makes each vector with an AI SDK embedding model, and calls the model only for text that changed.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/vector-store ai
```

### Store vectors that you make

```ts
import { DatabaseSync } from 'node:sqlite';

import { CollectionDefinition } from '@zukhruf/vector-store';
import { SqliteVectorStore } from '@zukhruf/vector-store/sqlite';

const definition = new CollectionDefinition({
  key: 'text',
  data: {
    source: { type: 'text', indexed: true },
    publishedAt: { type: 'date', indexed: true },
    content: { type: 'text' },
  },
  vector: { dimensions: 384, distance: 'cosine' },
});

using database = new DatabaseSync('vectors.sqlite');
const store = new SqliteVectorStore({ database });
const chunks = store.collection('chunks', definition);
await chunks.ensure();

await chunks.upsert([
  {
    key: 'guide#0',
    data: { source: 'docs', publishedAt: new Date('2026-11-01'), content: '…' },
    vector: new Float32Array(384),
  },
]);

const hits = await chunks.search(queryVector, {
  top: 10,
  filter: { source: 'docs' },
});
// [{ key: 'guide#0', distance: 0.12, data: { source: 'docs', … } }]
```

### Move to SQL Server

Only the store changes. The definition, the records and the calls stay the same.

```ts
import mssql from 'mssql';

import { SqlServerVectorStore } from '@zukhruf/vector-store/sqlserver';

const pool = await new mssql.ConnectionPool(config).connect();
const store = new SqlServerVectorStore({
  session: {
    async query(sql, parameters) {
      const request = pool.request();
      for (const [name, value] of Object.entries(parameters)) {
        request.input(name, value);
      }
      return (await request.query(sql)).recordset;
    },
  },
});
const chunks = store.collection('chunks', definition);
```

The package imports no database driver. Each engine names the few methods that it calls ([ADR 0002](./docs/adr/0002-each-engine-is-a-subpath-and-takes-a-session-of-its-own.md)). `pg.Pool` and `pg.Client` already have the shape of the Postgres session.

### Store text, and embed only what changed

```ts
const documents = store.embeddingCollection('documents', definition, {
  model: local.embeddingModel('embeddinggemma'),
});
await documents.ensure();

await documents.upsert([
  {
    key: 'a',
    data: { source: 'news', publishedAt, content },
    text: 'Storm closes the port',
  },
]);
// One embedMany call for the records whose content key changed. An unchanged
// text with the same model makes no call.

const { embedding } = await embed({
  model: queryModel,
  value: 'ports closed by weather',
});
await documents.search(embedding, { top: 5, filter: { source: 'news' } });
```

The search takes a vector, not a text, because many models want a different prompt for a search text than for a document (see the README of `@eltjs/embedding`). The caller embeds the search text with its own model.

## API

```ts
// @zukhruf/vector-store
class CollectionDefinition<Key, Data, Dimensions> {
  constructor(options: {
    key: 'text' | 'integer';
    // `indexed: true` is allowed only on the scalar types; `json` is always a payload.
    data: Record<
      string,
      | {
          type: 'text' | 'integer' | 'real' | 'boolean' | 'date';
          indexed?: boolean;
        }
      | { type: 'json' }
    >;
    vector: { dimensions: number; distance: 'cosine' | 'dot' | 'euclidean' };
  });
}

// Each engine's store: SqliteVectorStore, SqliteVecVectorStore, PostgresVectorStore, SqlServerVectorStore.
interface VectorStore {
  collection<Key, Data>(
    name: string,
    definition: CollectionDefinition<Key, Data>,
  ): VectorCollection<Key, Data>;
  // Adds the content key column to the definition, so only this method makes such a table.
  embeddingCollection<Key, Data>(
    name: string,
    definition: CollectionDefinition<Key, Data>,
    options: { model: EmbeddingModel },
  ): EmbeddingCollection<Key, Data>;
}

interface VectorCollection<Key, Data> {
  ensure(): Promise<void>;
  drop(): Promise<void>;
  upsert(
    records: readonly {
      key: Key;
      data: Data;
      vector: Float32Array | readonly number[];
    }[],
  ): Promise<void>;
  search(
    vector: Float32Array | readonly number[],
    options: { top: number; filter?: Filter<Data> },
  ): Promise<readonly SearchHit<Key, Data>[]>;
  get(
    keys: readonly Key[],
    options?: { includeVectors?: boolean },
  ): Promise<ReadonlyMap<Key, StoredRecord<Key, Data>>>;
  delete(target: readonly Key[] | { filter: Filter<Data> }): Promise<void>;
  count(filter?: Filter<Data>): Promise<number>;
}

interface EmbeddingCollection<Key, Data> {
  ensure(): Promise<void>;
  drop(): Promise<void>;
  upsert(
    records: readonly { key: Key; data: Data; text: string }[],
    options?: { abortSignal?: AbortSignal },
  ): Promise<void>;
  search: VectorCollection<Key, Data>['search'];
  get: VectorCollection<Key, Data>['get'];
  delete: VectorCollection<Key, Data>['delete'];
  count: VectorCollection<Key, Data>['count'];
}

class UnitVector {
  static normalize(vector: Float32Array | readonly number[]): UnitVector;
}
class ContentKey {
  static of(model: EmbeddingModel, text: string): string; // sha256 of [provider, modelId, text]
}

// @zukhruf/vector-store/sqlite      new SqliteVectorStore({ database: DatabaseSync })
// @zukhruf/vector-store/sqlite-vec  new SqliteVecVectorStore({ database: DatabaseSync })
// @zukhruf/vector-store/postgres    new PostgresVectorStore({ session: PostgresSession })
// @zukhruf/vector-store/sqlserver   new SqlServerVectorStore({ session: SqlServerSession })
```

`Filter<Data>` names only the fields with `indexed: true`. A field without `indexed` is a payload: the store keeps it and gives it back, and the type system refuses it in a filter ([ADR 0005](./docs/adr/0005-a-filter-is-a-typed-object-over-indexed-fields.md)).

`top` is required, as in .NET's `SearchAsync`. `top: Infinity` gives every record that the filter keeps, which the relevance filter of `@zukhruf/relevance-filtering` reads.

## What each call does underneath

| Call                 | `/sqlite`                                                                                                            | `/sqlite-vec`                                                                                                           | `/postgres`                                                                            | `/sqlserver`                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ensure()`           | `CREATE TABLE IF NOT EXISTS` with a BLOB column and an index on each indexed field                                   | `CREATE VIRTUAL TABLE … USING vec0(…)`: indexed fields are metadata columns, the other fields are `+` auxiliary columns | `CREATE TABLE IF NOT EXISTS` with `vector(n)` and a B-tree index on each indexed field | `IF OBJECT_ID(…) IS NULL CREATE TABLE` with `VECTOR(n)`, a `BIGINT IDENTITY` clustered key and a unique key column                                       |
| a vector on the wire | float32 bytes of the unit vector, in the byte order of the platform                                                  | float32 bytes (`vec_f32`)                                                                                               | text `'[0.1,…]'`                                                                       | JSON text with 9 significant digits, then `CAST(@v AS VECTOR(n))` ([ADR 0009](./docs/adr/0009-sql-server-gets-vectors-as-json-text-with-nine-digits.md)) |
| `search`             | reads the rows that the filter keeps, compares each vector in JavaScript, keeps the `top` nearest                    | `WHERE embedding MATCH ? AND k = ? AND <filter>`                                                                        | `ORDER BY embedding <=> $1 LIMIT $2` (`<#>`, `<->` for dot and euclidean)              | `SELECT TOP (@k) … ORDER BY VECTOR_DISTANCE('cosine', embedding, CAST(@q AS VECTOR(n)))`                                                                 |
| `delete({ filter })` | `DELETE … WHERE <filter>`                                                                                            | the same                                                                                                                | the same                                                                               | the same                                                                                                                                                 |
| the definition       | `ensure()` writes it to the table `vector_store_collection`, under the same lock as the `CREATE` (`BEGIN IMMEDIATE`) | the same                                                                                                                | the same, under `pg_advisory_xact_lock`                                                | the same, under `sp_getapplock`                                                                                                                          |
| a changed definition | `DefinitionMismatchError`                                                                                            | `DefinitionMismatchError`                                                                                               | `DefinitionMismatchError`                                                              | `DefinitionMismatchError`                                                                                                                                |

Each search is exact: it compares the vector with each record that the filter keeps ([ADR 0006](./docs/adr/0006-search-is-exact-now-and-an-index-comes-later.md)).

## Distances

Each search gives `distance`, and a lower distance is nearer, on each engine ([ADR 0004](./docs/adr/0004-search-gives-the-distance-and-lower-is-nearer-on-each-engine.md)).

| `distance`    | Value                              | `/sqlite` | `/sqlite-vec`                  | `/postgres` | `/sqlserver`  |
| ------------- | ---------------------------------- | --------- | ------------------------------ | ----------- | ------------- |
| `'cosine'`    | 1 − cosine similarity, from 0 to 2 | yes       | yes                            | `<=>`       | `'cosine'`    |
| `'dot'`       | − dot product                      | yes       | no: `UnsupportedDistanceError` | `<#>`       | `'dot'`       |
| `'euclidean'` | L2 distance                        | yes       | yes (`l2`)                     | `<->`       | `'euclidean'` |

## Errors

| Error                      | When                                                                                     | The caller's next step                                             |
| -------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `DimensionMismatchError`   | A vector's length is not the dimensions of the definition. `expected` and `actual`       | Fix the model or the definition                                    |
| `DefinitionMismatchError`  | `ensure()` finds a stored collection of another definition. `differences` lists each one | Keep the old definition, or `drop()` and fill the collection again |
| `UnsupportedDistanceError` | The engine has no such distance                                                          | Choose another distance or engine                                  |
| `UnknownRecordError`       | `get` names a key that the collection does not store                                     | Check the key; a silent gap would move the error to a later line   |

A failure of the model in `EmbeddingCollection.upsert` and each failure of the database propagate as they are.

## The same concepts in other systems

| This package                      | .NET `Microsoft.Extensions.VectorData`                                                                                                     | Mastra `MastraVector`                           | LangChain.js `VectorStore`                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------- |
| `SqlServerVectorStore`            | `SqlServerVectorStore` (CommunityToolkit.VectorData.SqlServer)                                                                             | not found                                       | not found                                           |
| `collection(name, definition)`    | `GetCollection<TKey, TRecord>(name, definition)`                                                                                           | `createIndex({ indexName, dimension, metric })` | the table of the constructor                        |
| `CollectionDefinition`            | `VectorStoreCollectionDefinition`, `[VectorStoreKey]`, `[VectorStoreData(IsIndexed)]`, `[VectorStoreVector(Dimensions, DistanceFunction)]` | `dimension`, `metric`                           | none                                                |
| `ensure()`                        | `EnsureCollectionExistsAsync`                                                                                                              | `createIndex`                                   | none                                                |
| `drop()`                          | `EnsureCollectionDeletedAsync`                                                                                                             | `deleteIndex`                                   | none                                                |
| `upsert`                          | `UpsertAsync`                                                                                                                              | `upsert({ vectors, metadata, ids })`            | `addVectors`                                        |
| `EmbeddingCollection.upsert`      | `UpsertAsync` with an `IEmbeddingGenerator`                                                                                                | none                                            | `addDocuments`                                      |
| `search(vector, { top, filter })` | `SearchAsync(vector, top, { Filter })` with a LINQ filter                                                                                  | `query({ queryVector, topK, filter })`          | `similaritySearchVectorWithScore(query, k, filter)` |
| `delete`                          | `DeleteAsync`                                                                                                                              | `deleteVector`, `deleteVectors`                 | `delete`                                            |

## Why not an npm package

Checked on 2026-11-18 (registry, installs in an empty folder, the source of each):

| Package                                            | Version, downloads a week | Why it does not fit                                                                                                                                                              |
| -------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mastra/core` with `@mastra/pg`, `@mastra/libsql` | 1.85.0, 3.7 M             | No SQL Server vectors: `@mastra/mssql` 1.12.0 exports only storage classes. The SQLite adapter needs `@libsql/client`, not `node:sqlite` with sqlite-vec. 176 packages installed |
| `@langchain/core` with `@langchain/pgvector`       | 1.4.1, 8.7 M              | The store takes LangChain's `EmbeddingsInterface` and `Document`, not an AI SDK model. No SQL Server store in JavaScript                                                         |
| `@memberjunction/ai-vectors-sqlserver`             | 6.1.7, 1.3 k              | BUSL-1.1 license. It has no connection of its own and works only inside MemberJunction's data provider                                                                           |
| `@absolutejs/rag-*`, `@anvia/*`                    | 0.x                       | No SQL Server adapter                                                                                                                                                            |
| `typeorm`                                          | 1.1.3, 7 M                | An ORM: a `vector` column type, and raw `VECTOR_DISTANCE` for search                                                                                                             |

## Who uses what

| Consumer                    | Uses                                                                | Keeps                                             |
| --------------------------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| `@zukhruf/embeddings`       | `/sqlite`, `EmbeddingCollection`                                    | publish-date windows, `nearest`, `neighbourGraph` |
| `@deepagents/retrieval`     | `/sqlite-vec`, `EmbeddingCollection` with one record for each chunk | sources, expiry, the chunker                      |
| `@zukhruf/vector-decisions` | `ContentKey` (#4375)                                                | its vector cache                                  |
| `@eltjs/embedding`          | `UnitVector` and the float32 bytes of `/sqlite` (#4118)             | the rule of a computed dataset                    |
| datahub                     | `/sqlserver`                                                        | no consumer yet                                   |

## Later

- Approximate search with an index: DiskANN on Azure SQL, HNSW on pgvector. On 2026-11-18 a DiskANN index on Azure SQL allowed `INSERT`, `UPDATE`, `DELETE` and `MERGE` and built its graph in the background (see ADR 0006).
- float16 and binary vectors.
- Native vectors over TDS when tedious supports them (pull request #1841).
- A search of full text and vectors together.

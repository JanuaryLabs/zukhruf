# @zukhruf/embeddings

A program that compares texts by meaning needs a vector for each text, and the model call that makes the vector is slow. This package keeps the vectors of documents in a SQLite database. An upsert calls the model only for new or changed text. A search gives the nearest documents of a document, by exact cosine similarity, from the documents published near it. A query gives the similarity of a vector of another text, for example a search sentence, to each document, or to each document of a date range. This kind of package is also known as a vector store.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses `node:sqlite` and an embedding model of the [AI SDK](https://ai-sdk.dev). The package does not start a model or a server. Give it a model that is ready.

```sh
npm install @zukhruf/embeddings ai @ai-sdk/openai-compatible
```

```ts
import { DatabaseSync } from 'node:sqlite';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embed } from 'ai';

import { Collection } from '@zukhruf/embeddings';

const local = createOpenAICompatible({
  name: 'llama.cpp',
  baseURL: 'http://127.0.0.1:8080/v1',
});
using database = new DatabaseSync('embeddings.sqlite');
const collection = new Collection({
  database,
  model: local.embeddingModel('embeddinggemma'),
});

await collection.upsert([
  {
    id: 'a',
    text: 'Storm closes the port',
    publishedAt: new Date('2026-10-20'),
  },
  {
    id: 'b',
    text: 'Port shut as storm hits',
    publishedAt: new Date('2026-10-21'),
  },
  { id: 'c', text: 'Port opens again', publishedAt: new Date('2026-11-30') },
]);

collection.nearest('a', { k: 10, withinDays: 7 }); // [{ id: 'b', similarity: … }]
collection.similarity('a', 'c');

// Compare a text that is not a document with the documents of October.
const { embedding } = await embed({
  model: local.embeddingModel('embeddinggemma'),
  value: 'task: search result | query: ports closed by weather',
});
collection.query(embedding, {
  from: new Date('2026-10-01'),
  to: new Date('2026-10-31'),
}); // [{ id: 'a', similarity: … }, { id: 'b', similarity: … }]

collection.fetch(['a']); // Map { 'a' => Float32Array [ … ] }
collection.delete(['c']);
collection.count(); // 2
```

## Search a vector table of your own

Another program can write the vectors into its own table. A `VectorSearch` searches that table with the same rules as a collection. The table or view must have the columns `id` (text) and `vector`. Each `vector` must be a unit vector, as a BLOB of float32 values, little-endian, as `toSql` of `@zukhruf/vectors/sqlite` writes it ([ADR 0005](./docs/adr/0005-a-vector-search-reads-a-vector-table-of-unit-vectors.md)). Each call except a query without a date range also reads the column `published_at` (milliseconds since the Unix epoch). Thus a table of documents with no publish date supports a query without a date range ([ADR 0007](./docs/adr/0007-a-query-without-a-date-range-compares-every-document.md)).

```ts
import { DatabaseSync } from 'node:sqlite';

import { VectorSearch } from '@zukhruf/embeddings';

using database = new DatabaseSync('listings.sqlite');
const search = new VectorSearch({ database, table: 'listing_vectors' });

search.nearest('listing-42', { k: 10, withinDays: 30 });
```

To search a table with other column names, make a view that renames the columns, and give the name of the view.

## API

- `new Collection({ database, model })`. The caller opens and closes `database`. The collection makes its table `embedding_document` in it, and keeps the vectors that the model gave in the table `embedding_cache` of [`@zukhruf/embedding-cache`](../embedding-cache). `model` is an AI SDK embedding model object.
- `upsert(documents)` stores each document. It embeds each text through `embedMany` and the cache, so it calls the model only for a text that the model did not embed before. It stores the new publish date of each document.
- `nearest(id, { k, withinDays })` gives at most `k` neighbours of the document, with the highest similarity first. A neighbour has a publish date at most `withinDays` days before or after the publish date of the document. Equal similarities sort by id.
- `neighbourGraph({ from, to, k, withinDays })` gives an iterator of `[id, neighbours]` entries, one for each document published from `from` to `to`, in the order of the publish dates and then of the ids. The neighbours of each entry are equal to the result of `nearest(id, { k, withinDays })`. A document outside the range has no entry, but it can be a neighbour of a document in the range. The call reads and decodes each vector one time ([ADR 0004](./docs/adr/0004-a-neighbour-graph-decodes-each-vector-once.md)). Use it when you need the neighbours of many documents.
- `similarity(a, b)` gives the cosine similarity of two stored documents.
- `query(vector, range?)` gives the similarity of a vector of the caller to each document, as `{ id, similarity }` entries. With a date range `{ from, to }`, it gives only the documents published from `from` to `to`. The highest similarity is first, and equal similarities sort by id. The call makes the vector a unit vector first. The vector must come from the model of the stored vectors ([ADR 0006](./docs/adr/0006-query-fetch-delete-and-count-follow-the-vector-stores.md), [ADR 0007](./docs/adr/0007-a-query-without-a-date-range-compares-every-document.md)).
- `fetch(ids)` gives a `Map` from each id to a copy of its stored unit vector, as a `Float32Array`, in the order of the ids.
- `delete(ids)` removes the documents. An id that the collection does not store is not an error, so you can delete the same ids again.
- `count()` gives the number of stored documents.
- `new VectorSearch({ database, table })`. The caller opens and closes `database`. `table` is the name of a table or a view in it, with the columns `id` and `vector`, and `published_at` for each call except a query without a date range. The vector search only reads it. Each call reads the table again, so the table can change between two calls.
- `VectorSearch` gives `nearest`, `neighbourGraph`, `similarity` and `query`, with the same rules and results as these calls of a collection. A collection gives these calls to a `VectorSearch` over its table `embedding_document`.

## Errors

| Error                                          | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnknownDocumentError`                         | `nearest`, `similarity` or `fetch` got an id that the vector table does not contain. `fetch` gives no vector then.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DimensionMismatchError` of `@zukhruf/vectors` | A vector has a dimension that is not the dimension of the stored vectors. `expected` is the stored dimension and `actual` the dimension of the vector. In an upsert, the model gave the vector, and the upsert stores none of its documents. To change to a model with another dimension, upsert all documents in one call. In a query, the caller gave the vector. Give a vector of the model of the stored vectors.                                                                                                                                                                                                                                                                                                |
| `RangeError`                                   | A vector of length 0 (the `ZeroVectorError` of `@zukhruf/vectors`) or with a value that is not finite in float32. A collection makes each vector a unit vector with `UnitVector.normalize` of `@zukhruf/vectors`, which divides the float32 values by their length in float64, as pgvector does. In an upsert, the upsert stores none of its documents.                                                                                                                                                                                                                                                                                                                                                              |
| `TypeError` `A stored vector must be a BLOB.`  | `nearest`, `neighbourGraph` or `similarity` of a `VectorSearch` read a `vector` that is not a BLOB, for example the text of a vector table of another program (`src/vector.ts`, commit `7e6d2a63`). `query` reads first `length("vector")` of one row and takes it as the number of bytes, 4 for each float32 value. For a text, SQLite gives the number of characters, so `query` throws `DimensionMismatchError` before it reads a vector. It throws the `TypeError` only when that number is 4 times the dimension of the query vector, or when the one row is a BLOB and another row is not. No test covers the `TypeError` yet. Store each vector as the BLOB that `toSql` of `@zukhruf/vectors/sqlite` writes. |

## Limits

- One database holds one collection.
- The collection stores the vector of the text, not the text. The caller chooses the text, for example a title and the first sentences.
- A document has one vector. A long text gives one mean vector, and its details become a small part of it.
- A vector search requires unit vectors. It does not examine the length of a vector. Two vectors of a vector table with other dimensions are the `DimensionMismatchError` of `@zukhruf/vectors`, from its `dot`.
- The search reads each document in the window ([ADR 0001](./docs/adr/0001-search-compares-each-document-in-the-window.md)). A window of many thousand documents is slow. A neighbour graph decodes each vector once, but it still calculates a similarity for each pair of documents in a window.
- After a model change, upsert all documents again ([ADR 0002](./docs/adr/0002-the-hash-includes-the-model.md)).

## The same concepts in other systems

The calls of a collection take their names and rules from the vector stores ([ADR 0006](./docs/adr/0006-query-fetch-delete-and-count-follow-the-vector-stores.md)). The search reads each document with no index, as an exact search does ([ADR 0001](./docs/adr/0001-search-compares-each-document-in-the-window.md)).

| Concept                                               | Other systems                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query(vector, range?)`                               | `index.query(vector=...)` of Pinecone, `query_points(query=...)` of Qdrant, `collection.query(query_embeddings=...)` of Chroma. In each one the filter is optional (`filter`, `query_filter`, `where`), as the date range is here ([ADR 0007](./docs/adr/0007-a-query-without-a-date-range-compares-every-document.md)) |
| `fetch(ids)`                                          | `index.fetch(ids)` of Pinecone, `retrieve(ids, with_vectors=True)` of Qdrant, `get(ids, include=["embeddings"])` of Chroma. Pinecone and Chroma leave out an unknown id; here it is an `UnknownDocumentError`                                                                                                           |
| `delete(ids)`                                         | `index.delete(ids)` of Pinecone, `delete(points_selector=...)` of Qdrant, `collection.delete(ids)` of Chroma. Pinecone and Chroma also accept an unknown id                                                                                                                                                             |
| `count()`                                             | `describe_index_stats()` of Pinecone, `count()` of Qdrant, `collection.count()` of Chroma                                                                                                                                                                                                                               |
| An exact search with no index                         | The flat index `IndexFlatIP` of FAISS; a `vec0` table of sqlite-vec, which needs the extension on each connection                                                                                                                                                                                                       |
| An approximate index, which this package does not use | HNSW in sqlite-vec and pgvector                                                                                                                                                                                                                                                                                         |

## Recipes

1. [Search a vector table that another program writes](./docs/recipes/search-a-vector-table-that-another-program-writes.md)
2. [Test code that uses a collection with a mock model](./docs/recipes/test-code-that-uses-a-collection-with-a-mock-model.md)

## Decisions

- [ADR 0001: A search compares each document in the window, with no index](./docs/adr/0001-search-compares-each-document-in-the-window.md)
- [ADR 0002: The hash includes the model (replaced by `@zukhruf/embedding-cache`)](./docs/adr/0002-the-hash-includes-the-model.md)
- [ADR 0003: All vectors of a collection have one dimension](./docs/adr/0003-all-vectors-of-a-collection-have-one-dimension.md)
- [ADR 0004: A neighbour graph decodes each vector once](./docs/adr/0004-a-neighbour-graph-decodes-each-vector-once.md)
- [ADR 0005: A vector search reads a vector table of unit vectors](./docs/adr/0005-a-vector-search-reads-a-vector-table-of-unit-vectors.md)
- [ADR 0006: Query, fetch, delete and count follow the vector stores](./docs/adr/0006-query-fetch-delete-and-count-follow-the-vector-stores.md)
- [ADR 0007: A query without a date range compares every document](./docs/adr/0007-a-query-without-a-date-range-compares-every-document.md)
- [Code copied from @deepagents/retrieval](./docs/copied-from-deepagents-retrieval.md)

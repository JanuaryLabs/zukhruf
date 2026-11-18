# The scope and the name follow .NET's vector data

Status: proposed, for Ezz's review (2026-11-18).

Three places keep vectors in a database and search them, and each one knows only SQLite:

- `@deepagents/retrieval` (`packages/retrieval/src/lib/stores/sqlite`): a `vec0` table of sqlite-vec, one vector for each chunk, and the content hash of `stores/cid.ts`.
- `@zukhruf/embeddings`: a plain table with a BLOB of a unit vector, and an exact search in JavaScript. Its ledger `docs/copied-from-deepagents-retrieval.md` records it as a copy of the first.
- `@zukhruf/vector-decisions` (`src/reader/vector-cache.ts`): a vector cache under the same content key (backlog #4375).

`@eltjs/embedding` writes the same unit vector bytes (backlog #4118). Backlog #3134 waits for a third consumer of the document embedding store. On 2026-11-18 Ezz asked for "primitives for different stores": SQLite, sqlite-vec, Postgres with pgvector, and SQL Server, whatever the use. Node v26.13.0 has no vector module, and `node:sqlite` has no vector function.

## Considered Options

| System       | Where the concept lives                                                                                                                                                                                                | Engines                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Go           | No package in the standard library (`go list std`, Go 1.24). LangChainGo [`vectorstores.VectorStore`](https://github.com/tmc/langchaingo/blob/main/vectorstores/vectorstores.go): `AddDocuments`, `SimilaritySearch`   | pgvector, MariaDB, Dolt and hosted stores; no SQLite, no SQL Server                   |
| .NET         | [`Microsoft.Extensions.VectorData`](https://learn.microsoft.com/en-us/semantic-kernel/concepts/vector-store-connectors/): `VectorStore`, `VectorStoreCollection<TKey, TRecord>`, one connector package for each engine | `CommunityToolkit.VectorData.SqlServer`, `.PgVector`, `.SqliteVec`, and hosted stores |
| Mastra       | `MastraVector` in `@mastra/core`                                                                                                                                                                                       | pgvector, libSQL; no SQL Server vectors                                               |
| LangChain.js | `VectorStore` in `@langchain/core`                                                                                                                                                                                     | pgvector and others; no SQL Server                                                    |

Only .NET has one interface over the four engines of the request. Go has no standard package for it.

## Decision

- The package is `@zukhruf/vector-store`, after .NET's `VectorStore` and LangChainGo's `vectorstores`. It is one package with one subpath for each engine, as `@zukhruf/mutex` has `/postgres` and `/sqlserver` ([ADR 0002](./0002-each-engine-is-a-subpath-and-takes-a-session-of-its-own.md)).
- Its layer is base (`std:base`): it imports Node and npm packages only (`ai` for the types of an embedding model and for `embedMany`).
- Ezz chose its scope on 2026-11-18: the engine primitives and the document layer ("Primitives + document store").
  - Now: the definition, the four engines, the wire format of each engine, the unit vector, the distances, the exact search with a filter, and the embedding collection with the content key.
  - Later: approximate indexes (DiskANN, HNSW), float16 and binary vectors, native vectors over TDS, a search of full text and vectors together.
  - Never: hosted services, the splitting of text into chunks, pools and migrations, layers that copy LangChain or Mastra.

## Consequences

- At the migration, `@zukhruf/embeddings`, `@deepagents/retrieval`, `@zukhruf/vector-decisions` and `@eltjs/embedding` move onto the package, and backlog #3134, #4375 and #4118 close with their ledgers.
- `@eltjs/embedding` and `@deepagents/retrieval` are public on npm, so this package must be public too.

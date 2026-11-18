# `ensure` creates the collection, and a changed definition is an error

Status: proposed, for Ezz's review (2026-11-18).

A collection's table must exist before the first record. When the definition changes, the stored vectors and columns no longer fit it. The two consumers answer this in two ways today:

- `@deepagents/retrieval` replaces `vec_chunks` with an empty table on a new dimension, and deletes all sources in the same transaction (`@zukhruf/sqlite-drift` with `rows: 'replace'`), so the next ingest embeds again.
- `@zukhruf/embeddings` keeps one dimension for each collection ([ADR 0003](../../../embeddings/docs/adr/0003-all-vectors-of-a-collection-have-one-dimension.md)) and fails another with a `DimensionMismatchError`.

.NET has `EnsureCollectionExistsAsync` and `EnsureCollectionDeletedAsync`. Mastra has `createIndex` and `deleteIndex`.

## Decision

- `ensure()` creates the table and its indexes when they are missing, and writes the definition to the table `vector_store_collection` (name, definition). The engine holds a lock for both: `BEGIN IMMEDIATE` on SQLite, `pg_advisory_xact_lock` on Postgres, `sp_getapplock` on SQL Server, so two programs that call `ensure()` together create one table.
- When a stored definition differs, `ensure()` throws a `DefinitionMismatchError` with each difference. It changes nothing.
- `drop()` removes the table and its definition. The host chooses: `@deepagents/retrieval` drops and embeds again, and `@zukhruf/embeddings` lets the error stop the program.
- `ensure()` is a call, not part of the constructor, because it reaches the database.

## Consequences

- The policy of a changed definition moves to the host, where it is today in both places.
- The lock on SQL Server is the third copy of `withSqlServerSchemaLock` of deepagents (`@deepagents/context`, and its copy in `@deepagents/text2sql`). At the build, the lock moves to zukhruf as its own package.

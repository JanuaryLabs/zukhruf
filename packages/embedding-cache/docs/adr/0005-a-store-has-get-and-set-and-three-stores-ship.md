# A store has `get` and `set`, and three stores ship

Status: proposed, for Ezz's review (2026-11-19). Ezz chose the three stores ("Add SQL Server too").

.NET's `IDistributedCache` has `Get` and `Set` of bytes; LangChain's byte store has `mget` and `mset`. `vector-decisions` and `@zukhruf/embeddings` keep vectors in SQLite; datahub keeps its data in SQL Server.

## Decision

- `EmbeddingCacheStore` has `get(keys)`, which gives a map of the keys it holds, and `set(entries)`. Both are async. A store needs nothing more, so a host can write one over its own table.
- `MemoryEmbeddingCacheStore` keeps a `Map` in the process.
- `SqliteEmbeddingCacheStore({ database, table })` takes a `DatabaseSync` of `node:sqlite` and reads and writes `key TEXT PRIMARY KEY, vector BLOB`.
- `SqlServerEmbeddingCacheStore({ session, table })` takes a session with the one method it calls, `query(sql, parameters)`, as `@zukhruf/mutex`'s `SqlServerSession` does; the package imports no driver. It reads and writes `[key] CHAR(64) PRIMARY KEY, vector VARBINARY(MAX)`.
- Each SQL store creates its table when it is missing (`CREATE TABLE IF NOT EXISTS` on SQLite, `IF OBJECT_ID(…) IS NULL` on SQL Server), on its first call.

## Consequences

- No store drops entries by itself; a host that needs eviction deletes rows or writes its own store.
- The tests run the SQLite store in process and the SQL Server store against `@zukhruf/testing`'s SQL Server.

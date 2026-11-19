# A store has `get` and `set`, and three stores ship

Status: accepted by Ezz on 2026-11-19 ("Accept (Recommended)").

.NET's `IDistributedCache` has `Get` and `Set` of bytes; LangChain's byte store has `mget` and `mset`. `vector-decisions` and `@zukhruf/embeddings` keep vectors in SQLite; datahub keeps its data in SQL Server.

## Decision

- `EmbeddingCacheStore` has `get(keys)`, which gives a map of the keys it holds, and `set(entries)`. Both are async. A store needs nothing more, so a host can write one over its own table.
- `MemoryEmbeddingCacheStore` keeps a `Map` in the process.
- `SqliteEmbeddingCacheStore({ database, table })` takes a `DatabaseSync` of `node:sqlite` and reads and writes `key TEXT PRIMARY KEY, vector BLOB`.
- `SqlServerEmbeddingCacheStore({ session, table })` takes a session with the one method it calls, `query(sql, parameters)`, as `@zukhruf/mutex`'s `SqlServerSession` does; the package imports no driver. It reads and writes `[key] CHAR(64) PRIMARY KEY, vector VARBINARY(MAX)`.
- Each SQL store runs its read or write first and creates its table only when that statement finds none, then runs it once more. On SQLite only an error whose message starts with `no such table:` leads to `CREATE TABLE IF NOT EXISTS`. On SQL Server only error 208 (invalid object name) leads to `CREATE TABLE`; a create that fails with 2714 (the object exists: a concurrent store made it) counts as done. Any other error reaches the caller, so the SQL Server session must reject with the driver's error and its `number`. The store keeps no phase flag and no promise of a first call, and a table dropped later comes back. Ezz, 2026-11-19, on a check in each call or p-memoize: "either accept it or find a different way than p-memoize"; this is that way, after the EAFP rule (try the operation, handle its failure).
- Each store quotes its table name in the SQL (`"schema"."name"` on SQLite, `[schema].[name]` on SQL Server), and takes only letters, digits and underscores, with an optional schema before a dot.

## Consequences

- No store drops entries by itself; a host that needs eviction deletes rows or writes its own store.
- The tests run the SQLite store in process and the SQL Server store against `@zukhruf/testing`'s SQL Server.

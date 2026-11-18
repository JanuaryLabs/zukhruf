# Each engine has `toSql` and `fromSql`, after pgvector

Status: accepted by Ezz on 2026-11-18 ("Accept (Recommended)").

Each engine reads another SQL form: SQLite and sqlite-vec read bytes, and SQL Server reads JSON text, because tedious has no `VECTOR` type yet ([ADR 0007](./0007-sql-server-gets-json-text-with-the-digits-that-keep-each-value.md)). The bit order differs too: sqlite-vec packs the least significant bit first, and pgvector writes a bit string with the first bit first.

pgvector-node 0.3.1 names the two directions `toSql` and `fromSql` (`import pgvector from 'pgvector'`, checked on 2026-11-18), and its subpaths give one form for each client (`pgvector/pg`, `pgvector/kysely`, …).

## Decision

- Each engine subpath exports `toSql(vector)` and `fromSql(type, value)`. `fromSql` takes the type, because bytes do not say their element type.
- `/sqlite` serves plain SQLite and sqlite-vec, which read the same bytes: float32 little-endian, int8 as bytes, bits least significant first.
- `/sqlserver` also exports `sqlType(vector)`, the type for a `CAST`: `VECTOR(n)` or `VECTOR(n, float16)`.
- A subpath for an engine that has no element type refuses that type in TypeScript: `/sqlserver` has no `BitVector`.

## Consequences

- A host that knows pgvector-node knows the names of the package, and a later Postgres subpath can have the same names.
- `fromSql` of a BLOB whose length does not fit the type is a `RangeError`.

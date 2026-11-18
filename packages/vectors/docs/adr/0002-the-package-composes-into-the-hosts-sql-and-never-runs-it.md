# The package composes into the host's SQL, and never runs it

Status: accepted by Ezz on 2026-11-18 ("Accept (Recommended)").

Each engine has features that the others do not: sqlite-vec has partition keys and int8 and bit vectors, SQL Server has DiskANN, `VECTOR_SEARCH` with iterative filters, float16 and `JSON_VALUE`, and Postgres has HNSW, IVFFlat and sparse vectors. An interface over all engines can give only what all of them have. Ezz: "We should not have an abstraction that limits what each of those vector stores offers. That's why composition is very important."

## Considered Options

| Way                                                         | Who does it                                                                                                                                                                                                                                                                                                                                                     | What the host keeps                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| One store interface over the engines                        | .NET `Microsoft.Extensions.VectorData`, Mastra `MastraVector`, LangChain.js `VectorStore`, the first paper (f06a1fb8)                                                                                                                                                                                                                                           | What the interface gives: a filter language, `top`, and its index options |
| Values and SQL pieces that the host puts into its own query | [pgvector-node](https://github.com/pgvector/pgvector-node) (`toSql`, `fromSql`, and `cosineDistance` for Knex, Kysely, Sequelize), [Drizzle](https://orm.drizzle.team/docs/guides/vector-similarity-search) (`cosineDistance` inside `orderBy`, an `hnsw` index in the schema), EF Core (`EF.Functions.VectorDistance` inside LINQ), sqlite-vec (SQL functions) | All of its engine                                                         |

## Decision

- The package gives values (vector types and their SQL forms) and functions (math in memory, and SQL functions for plain SQLite). The host writes the SQL and runs it with its own driver.
- The package runs no query, opens no connection, and owns no table, so it needs no session of a driver.
- A feature of an engine that a host needs is the host's SQL, with the SQL form of the package in it. The README shows DiskANN and `vec0` as such SQL.

## Consequences

- No host loses a feature of its engine. A new feature of an engine needs no change of the package.
- A host that moves to another engine rewrites its SQL. The vector values and the math stay.
- The first paper's `VectorCollection`, filter language, `ensure()` and session interfaces are gone.

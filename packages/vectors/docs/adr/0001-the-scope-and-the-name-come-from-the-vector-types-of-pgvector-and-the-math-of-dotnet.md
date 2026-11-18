# The scope and the name come from the vector types of pgvector and the math of .NET

Status: proposed, for Ezz's review (2026-11-18).

Four programs keep vectors in SQLite, and each one writes its own vector code: `@deepagents/retrieval` (`vectorToBlob`), `@zukhruf/embeddings` (`UnitVector`, `toBlob`, a cosine in JavaScript), `@eltjs/embedding` (`unitVector`, backlog #4118 and #4044) and, through `@zukhruf/embeddings`, the Context Compiler. No program keeps vectors in SQL Server yet. Node v26.13.0 has no vector module, and `node:sqlite` has no vector function.

Ezz ruled on 2026-11-18:

- The package is a zukhruf package of its own ("Own zukhruf package").
- It is designed by composition: "We should not have an abstraction that limits what each of those vector stores offers" ([ADR 0002](./0002-the-package-composes-into-the-hosts-sql-and-never-runs-it.md)).
- Its name is `@zukhruf/vectors`.
- Postgres comes after SQLite and SQL Server: "we can decide after finishing SQLite and SQL server".
- The package is designed for its domain, and the programs move onto it: "we design for proper standard package, and the host it got forced into our design."

A first paper (commit f06a1fb8, `@zukhruf/vector-store`) had one collection interface over all engines, after .NET's `Microsoft.Extensions.VectorData`. The composition ruling replaced it.

## Considered Options

| System                                                                                                                                                                     | What it gives for vectors                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pgvector clients ([Python](https://github.com/pgvector/pgvector-python), [Go](https://github.com/pgvector/pgvector-go), [Node](https://github.com/pgvector/pgvector-node)) | Vector types (`Vector`, `HalfVector`, `SparseVector`) and their SQL form; each query builder composes them                                                                                                                         |
| .NET                                                                                                                                                                       | [`System.Numerics.Tensors.TensorPrimitives`](https://learn.microsoft.com/en-us/dotnet/api/system.numerics.tensors.tensorprimitives): `CosineSimilarity`, `Dot`, `Norm`. EF Core: `SqlVector<float>`, `EF.Functions.VectorDistance` |
| sqlite-vec                                                                                                                                                                 | SQL functions: `vec_f32`, `vec_int8`, `vec_bit`, `vec_distance_cosine`, `vec_distance_L2`, `vec_distance_hamming`, `vec_normalize`                                                                                                 |
| Go                                                                                                                                                                         | No package in the standard library (`go list std`, Go 1.24)                                                                                                                                                                        |

## Decision

- `@zukhruf/vectors` gives the vector types of each element type that an engine of the first release stores ([ADR 0003](./0003-each-element-type-of-the-engines-has-a-vector-type.md)), their math ([ADR 0004](./0004-distances-follow-the-engines-and-lower-is-nearer.md)), and the SQL form of each type in each engine ([ADR 0006](./0006-each-engine-has-tosql-and-fromsql-after-pgvector.md)).
- Subpaths: `@zukhruf/vectors` (types and math), `@zukhruf/vectors/sqlite` (plain SQLite and sqlite-vec), `@zukhruf/vectors/sqlserver`.
- Its layer is base (`std:base`). It has no dependencies.
- Now: `Vector`, `HalfVector`, `Int8Vector`, `BitVector`, `UnitVector`, the distances, `/sqlite`, `/sqlserver`.
- Later: Postgres and `SparseVector`; hamming in plain SQLite; native vectors over TDS.
- Never: tables, collections, filters, migrations, connections, text splitting, and the embedding cache ([ADR 0008](./0008-the-embedding-cache-decorates-the-model-and-lives-outside-this-package.md)).

## Consequences

- The four programs above drop their copies and use the package. Backlog #4118 and #4044 close.
- `@eltjs/embedding` and `@deepagents/retrieval` are public on npm, so this package is public.

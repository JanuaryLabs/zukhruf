# Distances follow the engines, and lower is nearer

Status: accepted by Ezz on 2026-11-18 ("Accept (Recommended)").

Each engine of the first release gives a distance:

| Engine           | Cosine                                                                                    | Euclidean         | Other                                  |
| ---------------- | ----------------------------------------------------------------------------------------- | ----------------- | -------------------------------------- |
| sqlite-vec 0.1.9 | `vec_distance_cosine`: orthogonal vectors give 1 (probed)                                 | `vec_distance_L2` | `vec_distance_hamming` for bits        |
| SQL Server       | `VECTOR_DISTANCE('cosine', …)`: orthogonal vectors give 1, one direction gives 0 (probed) | `'euclidean'`     | `'dot'`, the negative dot product      |
| pgvector (later) | `<=>`                                                                                     | `<->`             | `<#>` negative inner product, `<+>` L1 |

.NET `TensorPrimitives` gives `CosineSimilarity`, `Dot` and `Norm` in memory. `@zukhruf/embeddings` gives a similarity today, and `@deepagents/retrieval` gives a distance.

## Decision

- In memory, the package gives `dot`, `norm`, `cosineSimilarity`, `cosineDistance` (1 − `cosineSimilarity`), `euclideanDistance` and `hammingDistance`. Each computes in float64 and gives a number.
- Each distance is lower for nearer vectors, as in each engine, so a result in memory and a result in SQL sort the same way.
- Two vectors of other dimensions are a `DimensionMismatchError` with `expected` and `actual`.
- A cosine with a zero vector is `NaN` in memory. In SQL it is `NULL`, as in sqlite-vec.

## Consequences

- A host can check a SQL result against the math in memory, to the precision of float32.
- `@zukhruf/embeddings` keeps its `similarity` for its own callers as `cosineSimilarity`.

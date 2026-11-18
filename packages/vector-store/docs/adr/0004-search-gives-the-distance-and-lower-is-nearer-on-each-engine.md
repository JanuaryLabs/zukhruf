# Search gives the distance, and lower is nearer, on each engine

Status: proposed, for Ezz's review (2026-11-18).

The stores give different numbers for the same search:

| Tool                    | What a search gives                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pgvector                | A distance: [`<=>`](https://github.com/pgvector/pgvector) cosine distance, `<#>` "the negative inner product since Postgres only supports `ASC` order index scans", `<->` L2                      |
| SQL Server              | `VECTOR_DISTANCE('cosine' \| 'dot' \| 'euclidean', …)`. On Azure SQL on 2026-11-18, two orthogonal vectors gave 1 and two vectors of one direction gave 0, so cosine is 1 − the cosine similarity |
| sqlite-vec              | `distance`, lower first                                                                                                                                                                           |
| .NET VectorData         | A score whose meaning depends on the `DistanceFunction`: `CosineDistance` and `CosineSimilarity` are two names                                                                                    |
| `@zukhruf/embeddings`   | `similarity`, higher first                                                                                                                                                                        |
| `@deepagents/retrieval` | `distance` from the store, and `similaritySearch` adds `similarity = 1 − distance`                                                                                                                |

## Decision

- Each search gives `distance`, and a lower distance is nearer, on each engine. The three distances are `cosine` (1 − the cosine similarity), `dot` (the negative dot product, as pgvector and SQL Server give it) and `euclidean`.
- A result has no second field for the similarity. For `cosine`, the similarity is `1 − distance`.
- An engine without a distance refuses the definition with an `UnsupportedDistanceError` when the collection is made: sqlite-vec has no dot product.

## Consequences

- One order and one meaning on each engine: a host that moves to another engine gets the same numbers, to the float32 precision of the engine.
- `@zukhruf/embeddings` keeps its `similarity` for its callers, and computes it as `1 − distance`.

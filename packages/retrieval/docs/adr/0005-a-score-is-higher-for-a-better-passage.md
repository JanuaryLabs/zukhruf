# A score is higher for a better passage

Superseded in part on 2026-11-25 (#5583) for a score on every passage. `ScoredPassage.score` is optional: a retriever that gives an order only writes none, and its list is in its own order. A score, when there is one, is still higher for a better passage ([ADR 0016](./0016-a-scored-passage-may-have-no-score-and-a-list-is-in-the-retrievers-order.md)).

Status: accepted by Ezz on 2026-11-23 ("Approve, write the paper").

The engines split on the direction of a score. Distances are lower for a better match in Weaviate, Chroma, LanceDB, pgvector and sqlite-vec; FTS5 `bm25()` and pgvector's `<#>` are negative. Elasticsearch, OpenSearch, Qdrant and Vespa give a score that is higher for a better match ([Elasticsearch knn retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/knn-retriever), [Qdrant search](https://qdrant.tech/documentation/search/search/), [pgvector README](https://github.com/pgvector/pgvector/blob/master/README.md), [FTS5](https://www.sqlite.org/fts5.html)). The RAG frameworks give a similarity that is higher for a better match: LlamaIndex `NodeWithScore`, Haystack `Document.score`, Mastra `QueryResult.score`. .NET's `VectorSearchResult` score follows the `DistanceFunction`, so it can be a distance ([DistanceFunction](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.vectordata.distancefunction)).

## Decision

- `ScoredPassage.score` is higher for a better passage, for every retriever and every postprocessor.
- An embedding retriever gives the cosine similarity, `1 - cosine distance`. A keyword retriever gives the value of the engine's ranking function, negated where a lower value is a better match (FTS5 `bm25()`).
- A result list is sorted by score, best first.

## Considered Options

- **Give the engine's number (a distance or a negative `bm25()` value) as it is, as .NET does.** It lost: a fusion, a cutoff and MMR then read each engine's direction, and deepagents' `ContextStore` got two directions this way (#4884).

## Consequences

- `SimilarityCutoff` keeps the passages with `score >= threshold` for every retriever.
- The scores of two retrievers stay on different scales; only fusion compares them ([ADR 0007](./0007-reciprocal-rank-fusion-is-the-default-fusion-with-k-60-and-ranks-from-1.md)).

## Amendment 2026-11-23: the order of a list

Accepted by Ezz on 2026-11-23 ("Accept"). A higher score is still a better passage, and a retriever gives its list best first. A score-based postprocessor (`Rerank`, `SimilarityCutoff`, `Collapse`) keeps that order. Two postprocessors give another order on purpose, and each keeps every passage's score:

- `MaximalMarginalRelevance` gives the passages in the order it picks them, as LangChain and Haystack do (Elasticsearch keeps the input order) ([ADR 0008](./0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md)).
- `LongContextReorder` puts the best passages at the two ends of the list, which is its job.

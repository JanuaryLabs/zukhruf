# Reciprocal rank fusion is the default fusion, with k 60 and ranks from 1

Status: accepted by Ezz on 2026-11-23 ("Approve, write the paper").

Reciprocal rank fusion (RRF; Cormack, Clarke and Büttcher, SIGIR 2009) gives each passage the sum of `weight / (k + rank)` over the lists that hold it. The leaders agree on k 60 with ranks from 1:

- Elasticsearch `rrf`: `rank_constant` 60, `rank_window_size` 10, a `weight` of 1.0 for each retriever ([rrf retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/rrf-retriever)).
- LangChain `EnsembleRetriever`: `c` 60, ranks from 1, equal weights ([ensemble.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-classic/src/retrievers/ensemble.ts)).
- LlamaIndex `QueryFusionRetriever`: k 60, ranks from 0 ([fusion_retriever.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/retrievers/fusion_retriever.py)).
- Haystack: k 61, "60 was suggested by the original paper, plus 1 as python lists are 0-based" ([misc.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/utils/misc.py)). So Haystack's 61 is the same fusion as 60 with ranks from 1.
- OpenSearch, Vespa, Chroma, LanceDB and Alex Garcia's SQLite recipe use 60 ([score ranker](https://docs.opensearch.org/latest/search-plugins/search-pipelines/score-ranker-processor/), [Vespa phased ranking](https://docs.vespa.ai/en/ranking/phased-ranking.html), [Chroma hybrid](https://docs.trychroma.com/cloud/search-api/hybrid-search), [LanceDB reranking](https://docs.lancedb.com/reranking), `RRFReranker` K 60, [Garcia](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)).
- Qdrant is the outlier: its `rrf` k is "set to 2 by default" ([hybrid queries](https://qdrant.tech/documentation/concepts/hybrid-queries/)).

Two score fusions also exist: min-max scaling (Weaviate `relativeScoreFusion`, the hybrid default since 1.24, [Weaviate hybrid](https://docs.weaviate.io/weaviate/search/hybrid); LlamaIndex `relative_score`; OpenSearch `min_max`, [normalization processor](https://docs.opensearch.org/latest/search-plugins/search-pipelines/normalization-processor/)) and mean ± 3σ scaling (Qdrant `dbsf`, LlamaIndex `dist_based_score`, Haystack `distribution_based_rank_fusion`, [document_joiner.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/components/joiners/document_joiner.py)).

## Decision

- `FusionRetriever { retrievers, fusion, weights, rankWindowSize }` calls each retriever with `rankWindowSize` as its `topK`, fuses the lists on `Passage.id` and gives the best `topK`.
- `fusion` defaults to `reciprocalRankFusion({ k: 60 })`, with ranks from 1.
- `weights` default to 1 for each retriever.
- `rankWindowSize` defaults to the `topK` of the call. Elasticsearch's `rank_window_size` defaults to 10, the default `size` of a search, and must be greater than or equal to `size` ([rrf retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/rrf-retriever)).
- `relativeScoreFusion()` (min-max) and `distributionBasedScoreFusion()` (mean ± 3σ) are the other two fusions.

## Considered Options

- **Haystack's k 61 with ranks from 0.** It lost only on the form: it gives the same scores, and ranks from 1 match the paper, Elasticsearch and LangChain.
- **Qdrant's k 2.** It lost: no other leader uses it, and a small k gives the first ranks much more weight than the paper's 60.
- **A score fusion as the default, as Weaviate and OpenSearch have.** It lost: RRF needs no common scale, and most leaders default to it.

## Consequences

- `@zukhruf/mteb`'s `HybridSearch` (`fuseRrf`, `rsf`, `dbsf`) and datahub's staff search (#3426) are the other two places of fusion (strike 3, #5399, #5400). mteb keeps its MTEB port.

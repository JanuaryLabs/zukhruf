# A search is composed of retrievers that wrap retrievers and a list of postprocessors

Status: accepted by Ezz on 2026-11-23 ("Approve, write the paper").

The leaders compose a search in three ways. LangChain nests retrievers: `EnsembleRetriever`, `MultiQueryRetriever`, `HydeRetriever` and `ContextualCompressionRetriever { baseCompressor, baseRetriever }` ([contextual_compression.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-classic/src/retrievers/contextual_compression.ts), [multi_query.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-classic/src/retrievers/multi_query.ts), [HyDE](https://docs.langchain.com/oss/javascript/integrations/retrievers/hyde)). LlamaIndex wraps retrievers (`QueryFusionRetriever`) and runs an ordered `node_postprocessors` list of `BaseNodePostprocessor` ([postprocessor types](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/postprocessor/types.py)). Haystack builds a graph of components ([rankers](https://docs.haystack.deepset.ai/docs/rankers)).

## Decision

- A composite retriever takes retrievers and is a `Retriever`: `FusionRetriever`, `MultiQueryRetriever { retriever, model, queryCount = 4, fusion }` and `HydeRetriever { retriever, model }`. `model` is an AI SDK `LanguageModel`. The `fusion` of `MultiQueryRetriever` defaults to `reciprocalRankFusion()`, as the one of `FusionRetriever` does ([ADR 0007](./0007-reciprocal-rank-fusion-is-the-default-fusion-with-k-60-and-ranks-from-1.md)). `queryCount` is 4, as LlamaIndex's `num_queries` and Haystack's `n_expansions` (LangChain has 3).
- `interface Postprocessor { postprocess(passages, query, options?) }` changes a result list. `PostprocessingRetriever { retriever, postprocessors }` runs the postprocessors in order on the list of its retriever.
- The package ships these postprocessors:
  - `Rerank { model, topN }`: the AI SDK `rerank` with a `RerankingModel` (ai 7.0.179 exports `rerank`).
  - `SimilarityCutoff { threshold }`: LlamaIndex `SimilarityPostprocessor`.
  - `MaximalMarginalRelevance { lambda = 0.5, topK }`: Carbonell and Goldstein 1998; `lambda` 1 is pure relevance, as Elasticsearch `lambda` and Weaviate `balance` ([diversify retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/diversify-retriever), [Weaviate 1.39](https://weaviate.io/blog/weaviate-1-39-release)).
  - `Collapse { field = 'source', size = 1 }`: Elasticsearch `collapse`, Vespa `collapsesize` ([standard retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/standard-retriever), [Vespa query API](https://docs.vespa.ai/en/reference/api/query.html)).
  - `LongContextReorder`: LlamaIndex and LangChain `LongContextReorder`, Haystack `LostInTheMiddleRanker` ([LongContextReorder](https://reference.langchain.com/python/langchain-community/document_transformers/long_context_reorder/LongContextReorder)).
  - `ContextWindow { store, windowSize = 3 }`: Haystack `SentenceWindowRetriever(window_size=3)` ([sentence_window_retriever.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/components/retrievers/sentence_window_retriever.py)), LlamaIndex `PrevNextNodePostprocessor`. It reads the neighbours of each passage from a `PassageStore`.

## Considered Options

- **A graph of components, as Haystack.** It lost: a graph needs a runner and a schema of ports; nested retrievers and one list give the same searches with plain calls.
- **Only nested retrievers, as LangChain.** It lost: a chain of five post-steps becomes five nested objects; a list keeps their order readable.
- **Only a postprocessor list, as LlamaIndex.** It lost: fusion and query expansion call retrievers, so they are retrievers.

## Consequences

- `MaximalMarginalRelevance` reads `ScoredPassage.vector`, so its retriever runs with `includeVectors: true`. A passage without a vector is a `VectorMissingError`.
- Each engine ships a `PassageStore` with `get(ids)` and `neighbours({ source, seq, windowSize })`.

## Amendment 2026-11-23

Accepted by Ezz on 2026-11-23 ("They stand"). `PassageStore.neighbours({ source, seq, windowSize })` gives the passages of the source with `seq - windowSize <= seq <= seq + windowSize`, the passage itself among them, in the order of `seq`, as Haystack's `SentenceWindowRetriever` reads its window ([sentence_window_retriever.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/components/retrievers/sentence_window_retriever.py)). `get(ids)` leaves out an id that the store does not hold.

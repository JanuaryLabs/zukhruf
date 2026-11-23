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

## Amendment 2026-11-23, proposed

Accepted by Ezz on 2026-11-23: "First (as built)" for the place of the list of the user's own query, and "They stand" for the rest. The paper fixes that `MultiQueryRetriever`'s language model "writes 4 versions of the query" (README, "Combine searches"). The leaders disagree on the details below; each rule is the one of most of them, read in their source on 2026-11-23: Haystack `components/query/query_expander.py`, LlamaIndex `retrievers/fusion_retriever.py`, LangChain `retrievers/multi_query.ts` and `retrievers/hyde.ts`.

- **`queryCount` counts the versions that the model writes, not the query.** Haystack's `n_expansions` 4 (line 110) and LangChain's `queryCount` 3 (line 102) count the versions; LlamaIndex's `num_queries` 4 counts the query too and asks for `num_queries - 1` versions (lines 97-111).
- **The query is searched too, once.** Haystack adds the query unless a version is the same text in lower case (`include_original_query` True, lines 111 and 257-260); LlamaIndex searches the query and the versions (lines 277-279); LangChain searches only the versions (lines 189-190). So the default search fuses 5 lists.
- **The list of the query comes first.** Haystack appends the query after the versions (line 260); LlamaIndex puts it first (line 277). No majority: the first place is chosen so that a tie of fused scores goes to a passage that the user's own query found (ADR 0007, amendment 2026-11-23).
- **The prompt and the answer are Haystack's**: its `DEFAULT_PROMPT_TEMPLATE` (lines 22-52) with `n_expansions` and the query, and a JSON object `{"queries": [...]}`, read with the AI SDK's `Output.object`. The versions past `queryCount` are cut (lines 246-254). Haystack is the leader whose `n_expansions` is the paper's 4 and whose count rule the paper's "4 versions" matches; LangChain's prompt asks for lines between XML tags, and LlamaIndex's for one query on each line.
- **A failed model call or an answer that is not a list of strings rejects.** LlamaIndex and LangChain let the error of the model call through; Haystack logs it and searches only the query (lines 265-273). The AI SDK gives an answer that does not match the schema as `NoObjectGeneratedError`.
- **`HydeRetriever` sends the "websearch" prompt of LangChain's `HydeRetriever`** (`getPromptTemplateFromKey`, lines 130-133), the web-search prompt of Gao et al. (2022). LangChain sends the bare query when no template is given (lines 100-105). The retriever searches the answer of the model with the `topK`, `filter`, `includeVectors` and `abortSignal` of the call.
- **`queryCount` is a positive integer**, as Haystack refuses an `n_expansions` that is not positive (lines 126-127); a `RangeError` otherwise.

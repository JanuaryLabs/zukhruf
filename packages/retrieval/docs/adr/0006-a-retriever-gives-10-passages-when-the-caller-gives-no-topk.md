# A retriever gives 10 passages when the caller gives no topK

Superseded in part on 2026-11-25 (#5587, #5639) for the abort signal. The option is `signal`, the name of the DOM, `fetch`, Node and every other zukhruf package, with no `abortSignal` alias, and it is on every async port, not only on `RetrieveOptions` ([ADR 0017](./0017-every-async-port-takes-an-optional-abort-signal-and-a-composite-rejects-at-once-when-it-aborts.md)). The rest of the decision below stays true.

Status: accepted by Ezz on 2026-11-23 ("Approve, write the paper").

The leaders name and set the number of results in many ways: LlamaIndex `similarity_top_k` = 2 (`DEFAULT_SIMILARITY_TOP_K`, [constants.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/constants.py)), LangChain `k` = 4 ([vectorstores.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-core/src/vectorstores.ts)), Semantic Kernel `Top` = 5 (`DefaultTop`, [TextSearchOptions.cs](https://raw.githubusercontent.com/microsoft/semantic-kernel/main/dotnet/src/SemanticKernel.Abstractions/Data/TextSearch/TextSearchOptions.cs)), Haystack `top_k` = 10 (`bm25_retrieval` and `embedding_retrieval`, [document_store.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/document_stores/in_memory/document_store.py)), Mastra `topK` = 10 ([Mastra pg](https://mastra.ai/reference/vectors/pg)). The engines mostly give 10: Elasticsearch `size` ([search API](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-search)), Weaviate `QUERY_DEFAULTS_LIMIT`, Qdrant `limit`, Vespa `hits`, Chroma `n_results`, LanceDB `limit()` ([Weaviate env vars](https://docs.weaviate.io/weaviate/config-refs/env-vars), [Qdrant query points](https://api.qdrant.tech/api-reference/search/query-points), [Vespa query API](https://docs.vespa.ai/en/reference/api/query.html), [Chroma query](https://docs.trychroma.com/docs/querying-collections/query-and-get), [LanceDB vector search](https://docs.lancedb.com/search/vector-search)).

## Decision

- `RetrieveOptions.topK` is the most passages that a call gives. Its default is 10. Every retriever refuses a call topK that is not a whole number of 0 or more with a `RangeError`, through `callTopK` of `src/count.ts`, before any statement or model call, and the default 10 is written only there; each engine's own search takes the topK that `callTopK` gives (#5769, #5772; the composites in [ADR 0023](./0023-a-composite-that-fuses-reranks-or-diversifies-asks-its-retriever-for-a-rank-window-and-gives-the-topk-of-the-call.md)).
- The name is `topK`, as Mastra writes it in TypeScript and Haystack writes `top_k`.
- `includeVectors` (default `false`) adds the stored vector to each `ScoredPassage`, as .NET's `IncludeVectors` and Haystack's `return_embedding` do ([VectorSearchOptions](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.vectordata.vectorsearchoptions-1)).
- `abortSignal` stops the call, as the AI SDK names it.

## Considered Options

- **A small default (2, 4 or 5), as LlamaIndex, LangChain and Semantic Kernel have.** It lost: the engines and Haystack agree on 10, and a rerank or a fusion needs more passages from its retrievers than it keeps.
- **`limit`, as most engines name it.** It lost: `limit` is a SQL word in the SQL of the engine retrievers, and the RAG frameworks say top-k.

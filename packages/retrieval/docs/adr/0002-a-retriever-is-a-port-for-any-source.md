# A retriever is a port for any source

Superseded in part on 2026-11-26 (#5400) for the item of the port. `Retriever<in Q, P, out I extends RankedPassage<P> = RankedPassage<P>>` gives ranked passages, an order only, or scored passages, whose score is required ([ADR 0021](./0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md)).

Superseded in part on 2026-11-25 (#5584) for the passage of a live source. A host adapter gives `Passage<M>`, with no `source`, `seq`, `start` or `end`, and writes no `seq` 0; the port is `Retriever<in Q, P extends Passage>` ([ADR 0015](./0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md)).

Superseded in part on 2026-11-25 (#5582) for the return of the port. `retrieve` gives a `RetrievalResult`, `{ passages, failures }`, and `failures` is empty when nothing failed ([ADR 0014](./0014-a-retrieve-call-answers-with-the-retrievers-that-answered-and-names-those-that-were-unavailable.md)).

Superseded in part on 2026-11-25 (#5579, #5580) for the signature of the port. `Retriever<in Q extends QueryType = QueryType>` has `readonly retrieve: (query: Q, options?) => Promise<ScoredPassage[]>`: a query is a string or a `QueryBundle`, and a host adapter declares its own fields in its own bundle type ([ADR 0013](./0013-a-query-is-a-string-or-a-query-bundle-with-a-text-for-each-kind-of-search.md)). The rest of the decision below stays true.

Status: accepted by Ezz on 2026-11-23 ("Accept").

The engine retrievers of this package read the passage contract ([ADR 0001](./0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md)). A host can also have passages that no table holds: a web search or the API of a product. The leaders give both kinds one interface. Semantic Kernel has `ITextSearch` for web search engines, vector stores and other sources ([text search abstractions](https://learn.microsoft.com/en-us/semantic-kernel/concepts/text-search/text-search-abstractions)), with `VectorStoreTextSearch` over a vector store ([text search with vector stores](https://learn.microsoft.com/en-us/semantic-kernel/concepts/text-search/text-search-vector-stores)). LangChain's `BaseRetriever` is a `Runnable<string, Document[]>` that any class can implement ([retrievers/index.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-core/src/retrievers/index.ts)); the ruling of #5399 names its Arxiv and Wikipedia retrievers. LlamaIndex has `BaseRetriever.retrieve` ([base_retriever.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/base/base_retriever.py)).

## Decision

- `interface Retriever { retrieve(query: string, options?: RetrieveOptions): Promise<ScoredPassage[]> }` is the one port of the package.
- The engine retrievers are one family that implements it. The composite retrievers ([ADR 0008](./0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md)) take any `Retriever`.
- An adapter for a live source (a web search, an API) belongs to the host. It implements `Retriever` and gives `Passage` values.

## Considered Options

- **The port reads only the passage contract.** It lost: a fusion of a web search and an engine search, which Semantic Kernel and LangChain allow, would need a second interface.
- **The package ships live-source adapters.** It lost: Semantic Kernel ships its live sources (`BingTextSearch`, `GoogleTextSearch`) in a separate package, `Microsoft.SemanticKernel.Plugins.Web`, apart from the text-search abstraction ([text search](https://learn.microsoft.com/en-us/semantic-kernel/concepts/text-search/): `dotnet add package Microsoft.SemanticKernel.Plugins.Web`, `using Microsoft.SemanticKernel.Plugins.Web.Bing;`). A live source is an adapter of a host or of a plugin.

## Consequences

- A host adapter fills `source`, `seq`, `start` and `end` as it can; a web result has one passage, `seq` 0.
- Batch search is a second interface, `BatchRetriever`, that the embedding retrievers implement ([ADR 0003](./0003-an-embedding-retriever-runs-the-vector-search-in-the-sql-of-its-engine-one-query-or-a-batch.md)), so an adapter implements only `retrieve`.

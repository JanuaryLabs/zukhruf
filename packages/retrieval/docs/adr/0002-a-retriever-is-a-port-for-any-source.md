# A retriever is a port for any source

Status: Proposed 2026-11-23 for the owner's review (backlog #5399).

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

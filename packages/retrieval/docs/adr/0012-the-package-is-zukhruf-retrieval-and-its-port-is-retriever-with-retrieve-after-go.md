# The package is @zukhruf/retrieval, and its port is Retriever with retrieve, after Go

Status: Proposed 2026-11-23 for the owner's review (backlog #5399). Ezz left the home to the agent: "it doesn't really matter now. your call".

The workspace takes the scope and name of a new package from Go and .NET. Go has no retrieval package in the standard library or in `golang.org/x`. The leading Go libraries agree on **Retriever**: CloudWeGo Eino `components/retriever` with `Retriever.Retrieve(ctx, query, opts...)` and the options `TopK` and `ScoreThreshold` ([eino retriever](https://pkg.go.dev/github.com/cloudwego/eino/components/retriever)); Genkit `go/ai` `Retriever` with `Retrieve` ([genkit ai](https://pkg.go.dev/github.com/firebase/genkit/go/ai)); langchaingo `schema.Retriever` with `GetRelevantDocuments` ([langchaingo schema](https://pkg.go.dev/github.com/tmc/langchaingo/schema)). .NET says **Search**: `Microsoft.SemanticKernel.Data` `ITextSearch.SearchAsync` ([text search abstractions](https://learn.microsoft.com/en-us/semantic-kernel/concepts/text-search/text-search-abstractions)) and `Microsoft.Extensions.VectorData` `SearchAsync` ([vector search](https://learn.microsoft.com/en-us/dotnet/ai/vector-stores/vector-search)). No Microsoft NuGet package is named Retrieval (search of 2026-11-23).

Retrieval is the term of the textbook (Manning, Raghavan and Schütze, _Introduction to Information Retrieval_, Cambridge University Press 2008) and of RAG, where the "retriever" is a named part (Lewis et al. 2020, [arXiv:2005.11401](https://arxiv.org/abs/2005.11401)).

## Decision

- The package is `@zukhruf/retrieval`, in `packages/retrieval`.
- Its port is `Retriever` with `retrieve(query, options)`, as in Eino and Genkit.
- The unit is `Passage`, the information retrieval term for a part of a document that a search gives back. The frameworks split on this word (LlamaIndex `Node`, LangChain and Haystack `Document`, .NET `Record`).

## Considered Options

- **`@zukhruf/search`, after .NET.** It lost: "search" is also full-text search, which is one part of this package, and Go and the RAG literature say retrieval.
- **`@zukhruf/text-search`, after Semantic Kernel (the earlier paper).** It lost: it names one family of sources, and the port takes any source ([ADR 0002](./0002-a-retriever-is-a-port-for-any-source.md)).
- **`Document` as the unit.** It lost: elt and the hosts call the whole source row a document; a passage is one part of it.

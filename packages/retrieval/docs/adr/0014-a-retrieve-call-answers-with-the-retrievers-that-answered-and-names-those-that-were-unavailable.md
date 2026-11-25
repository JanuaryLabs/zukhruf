# A retrieve call answers with the retrievers that answered and names those that were unavailable

Status: Accepted 2026-11-25 (backlog #5582, #5588; paper #5638).

Decision-makers: Ezz. He ruled on 2026-11-24 that the package takes partial results (#5582), and on 2026-11-25 he approved the paper of #5638 with its open questions answered; for this decision: "the list field is 'passages'". The leader tables of the paper decided the rest.

`FusionRetriever` rejected the whole call when one child failed (`Promise.all`), so a fusion over a live source ([ADR 0002](./0002-a-retriever-is-a-port-for-any-source.md)) lost every answer when that source was down. The two leaders with partial results agree on the shape. Elasticsearch puts `_shards.failures` and `_clusters.details` on every response; `allow_partial_search_results` and `skip_unavailable` default to true. bleve puts `Status.Errors[indexName]` on every `SearchResult` from `MultiSearch`. Both key a failure by the child's name. The six leaders that reject (LangChain.js `EnsembleRetriever` and `RunnableMap`, LlamaIndex `QueryFusionRetriever`, Haystack `Pipeline`, Eino's router, Go `errgroup`) let every error through. On a bug, Go `errgroup.WithContext`, Python's `TaskGroup` and Haystack's `AsyncPipeline` cancel the siblings; LangChain.js and LlamaIndex leave them running (paper #5638, Q1, Q2, Q7).

Supersedes in part:

- [ADR 0002](./0002-a-retriever-is-a-port-for-any-source.md), for the return of the port: `retrieve` gives a `RetrievalResult`. Shipped.
- [ADR 0003](./0003-an-embedding-retriever-runs-the-vector-search-in-the-sql-of-its-engine-one-query-or-a-batch.md), for what `retrieveMany` gives: one `RetrievalResult` for each query. Shipped.
- [ADR 0007](./0007-reciprocal-rank-fusion-is-the-default-fusion-with-k-60-and-ranks-from-1.md), for the children and weights of `FusionRetriever`: a record by name, with weights by name. Its amendment's `RangeError` for weights that are not one for each list stays for `Fusion.fuse` only. Not shipped yet.
- [ADR 0008](./0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md), for what each composite passes up. Not shipped yet for `FusionRetriever` and `MultiQueryRetriever`.

## Decision

- `retrieve` gives `RetrievalResult<P> = { passages, failures }`. `failures` is a `ReadonlyMap` from a child's name to its `RetrieverUnavailableError`, and it is empty when nothing failed. Every retriever gives it, as every Elasticsearch response has `_shards` and every bleve result has `Status`. `retrieveMany` gives one `RetrievalResult` for each query, as Elasticsearch's `_msearch` gives one response for each.
- `FusionRetriever` takes `retrievers: { [name]: Retriever }` (Eino's `map[string]Retriever`, LangChain.js `RunnableMap`'s steps) and `weights: { [name]: number }`, 1 for each name that is absent. The record must have at least one name, and a name holds no `:`; otherwise a `RangeError`.
- A child that throws `RetrieverUnavailableError` is left out and named. A host adapter throws it, or a subclass of it, when its source cannot answer: HTTP 503 or 429, a timeout of its own, a refusal. A nested fusion's failures are named by path, `outer:inner`, as Elasticsearch writes `cluster:index`.
- When no child answered, the fusion throws `NoRetrieverAnsweredError`, which extends `RetrieverUnavailableError`, with `failures` and an `AggregateError` cause. So a fusion with no answer is an unavailable child of the fusion above it. An empty list would read as "nothing found".
- Any other error is a bug. It aborts the signal of every sibling, with the error as the reason, as `errgroup.WithContext` cancels with its cause, and the call rejects with it.
- `PostprocessingRetriever` and `HydeRetriever` pass the failures up unchanged. `MultiQueryRetriever` merges the failures of its versions by name, keeping the first, and fans out its versions with the same rule for bugs. It catches nothing, because its versions read one retriever.
- The list is `passages`, named by its unit, as Haystack names its output `{"documents": …}`. The envelope is `RetrievalResult`, after `<operation>Result` (bleve `SearchResult`, Semantic Kernel `KernelSearchResults`).

## Considered Options

- **A sibling port beside `Retriever`, as `BatchRetriever` is.** It lost. A decorator over a fusion would drop the failures, and both partial-result leaders put the status on every response.
- **Reject, as LangChain.js, LlamaIndex and Haystack do.** It lost: Ezz ruled for partial results on 2026-11-24.
- **Every child error is a failure, as Elasticsearch and bleve count them.** It lost: a bug would become a missing source (EAFP).
- **An empty result when every child failed, as bleve.** It lost on the tie of the two leaders: Elasticsearch fails the search, and "nothing searched" is not "nothing found".
- **A list of children with a weight beside each, as Elasticsearch's `rrf`.** It lost: most leaders name their children, and most keep the weights apart.
- **`hits` for the list, as Elasticsearch and bleve.** It lost: the glossary refuses "hit" for a scored passage, and Ezz chose `passages`.
- **`SourceError`, Meddit's name.** It lost: "source" is the key of a passage's row in this package. `RetrieverUnavailableError` and `NoRetrieverAnsweredError` are coined: no leader has a class for either. "Unavailable" is Elasticsearch's word (`skip_unavailable`), HTTP 503's and gRPC `UNAVAILABLE`'s.

## Consequences

- Every call site reads `.passages`. Every retriever, the hosts' adapters included, gives `failures: new Map()` when it has none.
- A host maps its own errors to `RetrieverUnavailableError` subclasses in its adapter. The package never maps a driver's error.
- The fan-out will be in `FusionRetriever` and `MultiQueryRetriever`: strike 2, to be listed in `docs/copied-code.md`, with a backlog item until a third consumer.
- Meddit's `FederatedRetriever` and `NoSourceAnsweredError` can be deleted (#5479).

## Confirmation

The probes of paper #5638 (`probes/run-fanout.out` on its sketch) show the passages of the child that answered and `web: RetrieverUnavailableError`, failures through a decorator, `literature:pubmed` and `literature:crossref`, `NoRetrieverAnsweredError` as a `RetrieverUnavailableError`, and a `TypeError` that rejects with the sibling's signal aborted for the reason `bug`.

Shipped so far (#5639, the types step): `RetrievalResult`, the two error classes (exported, not yet thrown by the package), `retrieve` and `retrieveMany` of every retriever with their results, `PostprocessingRetriever` and `HydeRetriever` passing the failures of their retriever up, and `FusionRetriever` and `MultiQueryRetriever` giving empty failures over `Promise.all`, as before. The 184 tests read `.passages`. Locally 143 pass with the behaviour they had and the 41 SQL Server tests skip, because the engine runs aarch64 and emulates SQL Server's linux/amd64; CI runs them, and a release does not wait for CI (root ADR 0007). The named children, the failures of a fusion, the fan-out and their tests (paper #5638, section 5) come in the next steps of #5639.

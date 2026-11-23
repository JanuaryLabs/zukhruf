# An embedding retriever refuses a query model whose identity differs from the stored vectors

Status: accepted by Ezz on 2026-11-23 ("Approve, write the paper").

A query vector and a passage vector compare only when one model made both. `@deepagents/retrieval` searched stale vectors after a switch to another model of the same dimension: it embedded 0 passages again and gave wrong results with no error (probe of 2026-11-22, deepagents #5377). A dimension check does not see this. One model can also give vectors of different dimensions, as the `dimensions` option of OpenAI's `text-embedding-3` models does. elt's Embedding rule stores the identity of each row as the provider, the model id and the dimensions, for example `openai/text-embedding-3-small (1536 dimensions)` (elt `packages/embedding/README.md`). The key of `@zukhruf/embedding-cache` holds the provider, the model id, the provider options and the dimensions (its ADR 0003).

## Decision

- The passage vectors of the contract keep the model identity of each vector: the provider, the model id and the dimensions of the AI SDK model that made it ([ADR 0001](./0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md), elt #5401).
- Before it searches, an embedding retriever reads the identity of the stored vectors. When the provider or the model id of its query model differs, the call fails with `ModelMismatchError`, which holds both identities, and sends no model call and no search. When the query vector has other dimensions than the stored vectors, the call fails with `ModelMismatchError` after the model call and sends no search.

## Considered Options

- **Check only the dimension.** It lost: two models of the same dimension pass, which is the #5377 failure.
- **Trust the host.** It lost: the failure is silent, and the results look valid.

## Consequences

- elt makes the model identity readable (#5401). A table without it cannot be searched by an embedding retriever.
- A host that changes the model embeds the passages again with elt before it searches.

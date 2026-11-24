# An embedding retriever refuses a query model whose identity differs from the stored vectors

Status: accepted by Ezz on 2026-11-23 ("Approve, write the paper").

A query vector and a passage vector compare only when one model made both. `@deepagents/retrieval` searched stale vectors after a switch to another model of the same dimension: it embedded 0 passages again and gave wrong results with no error (probe of 2026-11-22, deepagents #5377). A dimension check does not see this. One model can also give vectors of different dimensions, as the `dimensions` option of OpenAI's `text-embedding-3` models does. elt's Embedding rule stores the identity of each row as the provider, the model id and the dimensions, for example `openai/text-embedding-3-small (1536 dimensions)` (elt `packages/embedding/README.md`). The key of `@zukhruf/embedding-cache` holds the provider, the model id, the provider options and the dimensions (its ADR 0003).

## Decision

- The passage vectors of the contract keep the model identity of each vector: the provider, the model id and the dimensions of the AI SDK model that made it ([ADR 0001](./0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md), elt #5401).
- Before it searches, an embedding retriever reads the identity of the stored vectors. When the provider or the model id of its query model differs, the call fails with `ModelMismatchError`, which holds the provider and the model id of both, and sends no model call and no search. When the query vector has other dimensions than the stored vectors, the call fails with `DimensionMismatchError` of `@zukhruf/vectors`, which holds the `expected` and the `actual` dimensions, after the model call and sends no search.

## Considered Options

- **Check only the dimension.** It lost: two models of the same dimension pass, which is the #5377 failure.
- **Trust the host.** It lost: the failure is silent, and the results look valid.

## Consequences

- elt makes the model identity readable (#5401). A table without it cannot be searched by an embedding retriever.
- A host that changes the model embeds the passages again with elt before it searches.

## Amendment 2026-11-23

Accepted by Ezz on 2026-11-23: the model column and the identity rules ("They stand"), the error shape ("Two errors (Recommended)"). The `model` column of the passage vectors holds the identity as one text in the form that elt's Embedding rule writes, `<provider>/<modelId> (<dimensions> dimensions)`; a string model id of the AI SDK is `<provider>/<modelId>`, as elt names it. A call compares its query only with the vectors of its own identity, so a table in the middle of a refresh to another model gives correct results. When no stored identity has the provider and the model id of the query model, `ModelMismatchError.stored` is the first stored identity in the order of its text. The model has not made a vector yet, so `stored` and `query` are each `{ provider, modelId }`, with no dimensions, not the paper's `{ provider, modelId, dimensions }`. When the query vector has the dimensions of no stored identity of its model, `DimensionMismatchError.expected` is the dimensions of the first of them in the order of its text, and `actual` is the dimensions of the query vector; one error for each kind of mismatch keeps each type exact, and the package depends on `@zukhruf/vectors` already. An empty vector table gives no passages and makes no model call. A stored text that is not of this form fails the call with a `TypeError`.

## Amendment 2026-11-24: the identities on SQL Server

Accepted by Ezz on 2026-11-24 ("They stand"). `SqlServerEmbeddingRetriever` reads the stored identities with `SELECT DISTINCT model COLLATE Latin1_General_100_BIN2 … ORDER BY 1`, and its search compares `model` in the same binary collation. A case-insensitive default collation would merge `OpenAI/x` and `openai/x` into one identity and order `test/large` before `test/Mini`, so `ModelMismatchError.stored` would differ from SQLite and Postgres.

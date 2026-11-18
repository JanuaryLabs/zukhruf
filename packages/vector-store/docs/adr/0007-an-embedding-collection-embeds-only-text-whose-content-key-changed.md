# An embedding collection embeds only text whose content key changed

Status: proposed, for Ezz's review (2026-11-18).

A model call is the slow part. Three places skip it for a text that they embedded before:

| Place                                                                                                | Key                                   | When it compares                                          |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| `@deepagents/retrieval` `stores/cid.ts`                                                              | sha256 of the text                    | In the `WHERE` of its `ON CONFLICT` update                |
| `@zukhruf/embeddings` ([ADR 0002](../../../embeddings/docs/adr/0002-the-hash-includes-the-model.md)) | sha256 of `[provider, modelId, text]` | It reads the stored keys, then calls `embedMany` one time |
| `@zukhruf/vector-decisions` `src/reader/vector-cache.ts`                                             | sha256 of `[provider, modelId, text]` | The same (#4375)                                          |

The leaders do not skip: .NET embeds on each `UpsertAsync` through an `IEmbeddingGenerator`, LangChain.js on each `addDocuments`, and Mastra leaves the call to the caller. LangChainGo gives the caller a `WithDeduplicater` callback.

## Decision

- `store.embeddingCollection(name, definition, { model })` makes an embedding collection. It adds a content key column to the table, so no other way makes such a table.
- `upsert(records)` reads the stored content keys of the keys, calls `embedMany` one time for the texts whose content key changed, and writes their vectors. A record with the same content key gets its data updated and no call. `abortSignal` goes to `embedMany`.
- The content key is the sha256 of the JSON array `[model.provider, model.modelId, text]`, after `@zukhruf/embeddings`: a new model makes each vector again. `ContentKey.of(model, text)` gives it to the vector cache of `@zukhruf/vector-decisions`.
- The collection keeps the vector, not the text. A host that needs the text keeps it in a payload.
- `search` takes a vector. Many models want another prompt for a search text, so the caller embeds it with its own model.
- The package takes no clock: it does not wait by itself. `embedMany` keeps its own retries.

## Consequences

- `@deepagents/retrieval` gets the model in its key, so a model change embeds again; today it does not.
- A document of many chunks is many records. When a document loses chunks, the host deletes them with `delete({ filter: { document } })`.

# The hash includes the model

An upsert calls the model only for documents whose text changed. A hash of the text tells if the text changed. But the vector also depends on the model. A collection that a caller opens with a new model must not keep the vectors of the old model for the same text.

Thus the hash is the sha256 of the JSON array `[provider, modelId, text]`. When the provider, the model id or the text changes, the hash changes, and the upsert calls the model again.

The collection accepts a model object only, not a model id string. The AI SDK gives a string to the global default provider (`globalThis.AI_SDK_DEFAULT_PROVIDER`, or the AI Gateway). The collection cannot read which provider that is, so it cannot put the provider into the hash.

## Considered Options

- **A hash of the text only, as in deepagents.** A model change then keeps old vectors. Vectors of two models in one collection give similarities that have no meaning.
- **A model column in each row.** It tells the same as the hash, and needs one more comparison.
- **The model in the hash.** This option was selected.

## Consequences

- After a model change, each document that the caller upserts again gets a new vector.
- A document that the caller does not upsert again keeps the vector of the old model. Upsert all documents after a model change.
- When the new model has a different dimension, upsert all documents in one call. Otherwise the upsert fails with `DimensionMismatchError` (ADR 0003).

## Amendment (2026-11-19, #3134)

`@zukhruf/embedding-cache` replaced the hash. The collection wraps its model with `embeddingCacheMiddleware` and a `SqliteEmbeddingCacheStore` over the table `embedding_cache` of its own database, and an upsert embeds the text of each document through the wrapped model. The key of the cache is the sha256 of the provider, the model id, the provider options, the dimensions and the text (ADR 0003 of `@zukhruf/embedding-cache`), so the model is still part of it, and an unchanged text still calls no model. The table `embedding_document` has no hash column now. A table made before keeps its rows only until `apply` finds it stale: then it is made again without rows (ADR 0003), and the next upsert embeds each document once more. Because the cache keeps a vector after its document is deleted, an upsert after a delete of the same text calls no model.

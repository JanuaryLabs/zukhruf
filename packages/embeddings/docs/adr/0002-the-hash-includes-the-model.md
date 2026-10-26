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

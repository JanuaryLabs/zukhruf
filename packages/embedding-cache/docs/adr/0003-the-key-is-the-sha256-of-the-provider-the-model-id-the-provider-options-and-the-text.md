# The key is the sha256 of the provider, the model id, the provider options and the text

Status: accepted by Ezz on 2026-11-19 ("Accept (Recommended)").

`@zukhruf/embeddings` and `vector-decisions` key on the sha256 of `[provider, modelId, text]`, so a new model embeds again. LangChain keys on `namespace + sha256(text)`, where the namespace is usually the model name; .NET computes `GetCacheKey(ReadOnlySpan<object?> values)`.

Two cases need more than the text: a model wrapped twice with other prompts (EmbeddingGemma wants one prompt for documents and another for queries, README of `@eltjs/embedding`), and options that change the vector (the `dimensions` of OpenAI's `text-embedding-3` models).

## Decision

- The key is the sha256, in hex, of `JSON.stringify([model.provider, model.modelId, params.providerOptions ?? null, params.dimensions ?? null, text])`.
- Added while building, 2026-11-19: `ai` 7 passes `dimensions` to `doEmbed` beside `providerOptions`, not inside it, so the key holds it too. Without it, a call with other `dimensions` would get a vector of the wrong length.
- A wrapped model with its own `modelId` keeps its keys apart. Two calls with other provider options or other dimensions keep theirs apart.
- `JSON.stringify` keeps the key order of the options as the caller wrote them; two equal options in another key order give two keys, which costs a miss and never gives a wrong vector.

## Consequences

- A host that changes the model, its prompt wrapper or its options pays one call per text again, and the old entries stay until the store drops them.

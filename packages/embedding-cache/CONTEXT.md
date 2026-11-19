# Embedding cache

A cache in front of an AI SDK embedding model: a text that it embedded before costs no model call. The words below have one meaning each in its documents.

## Language

**Model**:
The AI SDK embedding model that the middleware wraps. Its provider and its model id name it.
_Avoid_: Embedder, generator, encoder

**Middleware**:
The object that `wrapEmbeddingModel` of the AI SDK takes. This package gives one: `embeddingCacheMiddleware`.
_Avoid_: Decorator, wrapper, plugin

**Key**:
The sha256 of the JSON array of the provider, the model id, the provider options of the call and the text. Another text, model, prompt wrapper or option gives another key.
_Avoid_: Hash, content key, cid

**Hit**:
A text whose key the store holds. A hit costs no model call.
_Avoid_: Cached text

**Miss**:
A text whose key the store does not hold. The misses of a call go to the model in one call.
_Avoid_: Uncached text

**Store**:
Where the cache keeps each key and its vector: memory, a SQLite table or a SQL Server table. A store has `get` and `set`.
_Avoid_: Backend, repository, cache (for the store alone)

**Vector**:
The numbers that the model gave for one text, kept exactly.
_Avoid_: Embedding (for the stored value), float32 vector

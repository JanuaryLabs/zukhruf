# The cache is its own package, after .NET's caching embedding generator

Status: accepted by Ezz on 2026-11-19.

Two places skip a model call for a text they embedded before, under the same key (backlog #3134, #4375): `@zukhruf/embeddings` (`Collection`, its ADR 0002) and `@zukhruf/vector-decisions` (`src/reader/vector-cache.ts`). `@deepagents/retrieval`'s `cid` decides whether a whole document changed before it is split; it is another job, and its embedder is not an AI SDK model. Node has no such cache, and npm has none for the AI SDK (README, "Why not an npm package").

.NET keeps this concept in `Microsoft.Extensions.AI` (`CachingEmbeddingGenerator`, `DistributedCachingEmbeddingGenerator`), apart from its vector math (`TensorPrimitives`) and its vector stores (`VectorData`). LangChain keeps it in `CacheBackedEmbeddings`, apart from its vector stores.

## Decision

- Ezz chose on 2026-11-19, first a subpath of `@zukhruf/vectors`, then its own package once the cache kept the model's numbers exactly and used no `Vector` ([ADR 0004](./0004-a-hit-gives-the-numbers-that-the-model-gave.md)): "It does seem like it's completely different" from the vectors.
- The package is `@zukhruf/embedding-cache` ("@zukhruf/embedding-cache (Recommended)"), in the base layer. Subpaths: the package root (the middleware, the store interface, the memory store), `/sqlite` and `/sqlserver`.
- Its function is `embeddingCacheMiddleware`, after the middlewares of the AI SDK (`defaultSettingsMiddleware`, `extractReasoningMiddleware`).

## Consequences

- `@zukhruf/vectors` keeps no dependency on `ai` (its ADR 0008).
- `vector-decisions` and `@zukhruf/embeddings` move onto the package; their copies go.

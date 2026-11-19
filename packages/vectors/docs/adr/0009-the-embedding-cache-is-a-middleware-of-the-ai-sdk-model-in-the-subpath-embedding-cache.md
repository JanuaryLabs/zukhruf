# The embedding cache is a middleware of the AI SDK model, in the subpath `/embedding-cache`

Status: proposed, for Ezz's review (2026-11-19). Ezz chose the subpath on 2026-11-19: "as a sub path of the new package". This supersedes ADR 0008.

A model call is the slow and paid part of an embedding. Two places skip it for a text they embedded before, under the same content key (backlog #3134, #4375):

- `@zukhruf/embeddings`: `Collection` hashes `[provider, modelId, text]` and calls `embedMany` only for documents whose hash changed (its ADR 0002).
- `@zukhruf/vector-decisions`: `src/reader/vector-cache.ts` keeps vectors in SQLite under the same key.

`@deepagents/retrieval`'s `cid` (the sha256 of a document's text) answers another question: whether a document changed, so the store can skip splitting and indexing it again. Its embedder is its own function type, not an AI SDK model. It stays.

## Considered Options

| Choice  | .NET `Microsoft.Extensions.AI`                                                                                                                 | LangChain.js `CacheBackedEmbeddings`                                                    | This package                                                                                                                                               |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape   | `CachingEmbeddingGenerator<TInput, TEmbedding>`, a decorator of the generator; `DistributedCachingEmbeddingGenerator` over `IDistributedCache` | a decorator of `Embeddings`, made by `fromBytesStore(underlying, store, { namespace })` | `embeddingCacheMiddleware({ store })` for `wrapEmbeddingModel` of the AI SDK, whose `wrapEmbed({ params, model })` can call `model.doEmbed` for the misses |
| Key     | `GetCacheKey(ReadOnlySpan<object?> values)`                                                                                                    | `namespace + sha256(text)`; the namespace is usually the model name                     | the sha256 of the JSON array `[provider, modelId, providerOptions, text]`                                                                                  |
| Store   | `IDistributedCache` (`Get`, `Set` of bytes)                                                                                                    | a byte store with `mget` and `mset`                                                     | `EmbeddingCacheStore` with `get(keys)` and `set(entries)` of `Vector`                                                                                      |
| Queries | cached                                                                                                                                         | not cached: "query caches can be evicted, document caches should be kept"               | cached; a host that does not want it wraps only its document model                                                                                         |

## Decision

- `@zukhruf/vectors/embedding-cache` exports `embeddingCacheMiddleware({ store })`, the type `EmbeddingCacheStore`, and `MemoryEmbeddingCacheStore`. `@zukhruf/vectors/sqlite` exports `SqliteEmbeddingCacheStore({ database, table })`, which keeps each vector as the bytes of `toSql`. The name of the function follows the middlewares of the AI SDK (`defaultSettingsMiddleware`, `extractReasoningMiddleware`).
- The key is the sha256 of `[model.provider, model.modelId, params.providerOptions ?? null, text]`. The model id keeps a document model and a query model apart, because they wrap one model with other prompts (README of `@eltjs/embedding`). The provider options keep apart, for example, two `dimensions` of one OpenAI model.
- A call reads the keys of its texts from the store, calls `model.doEmbed` one time with the misses only (each text once, with the same `abortSignal`, `headers` and `providerOptions`), writes the new vectors, and gives the vectors in the order of the texts. A call whose texts all hit calls no model.
- A hit and a miss give the same numbers: the middleware rounds a new vector to float32 before it gives it back and keeps it as a `Vector`. Embedding models give float32 vectors, and .NET's embeddings are float32 too.
- The usage of a call counts the tokens of the miss call only, so a full hit reports 0 tokens.
- An error of the model, of `store.get` or of `store.set` reaches the caller as it is. A failed model call writes nothing.
- `ai` and `@ai-sdk/provider` are optional peer dependencies, needed by this subpath only, as `@zukhruf/mutex` keeps `@zukhruf/docker` for one subpath. The other subpaths still need nothing.

## Consequences

- `vector-decisions` replaces its vector cache with the middleware and `SqliteEmbeddingCacheStore` (#4375 closes).
- `@zukhruf/embeddings` wraps its model and stops comparing its own hash; dropping the hash column of its table is its own migration (#3134 closes).
- A host that keeps vectors in SQL Server writes a store of two methods over its own table; a SQL Server store waits for a consumer.

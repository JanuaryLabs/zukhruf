# The cache is a middleware that calls the model for the misses only

Status: proposed, for Ezz's review (2026-11-19). Ezz chose that every call is cached ("Cache every call (Recommended)").

The AI SDK wraps a model with `wrapEmbeddingModel({ model, middleware })`. A middleware's `wrapEmbed({ doEmbed, params, model })` can answer `params.values` without the model, and can call `model.doEmbed` with other values (`EmbeddingModelV4Middleware` in `@ai-sdk/provider`, checked on 2026-11-19). .NET decorates the generator; LangChain decorates `Embeddings`. LangChain caches documents only, because "query caches can be evicted, document caches should be kept"; the AI SDK has one `doEmbed` for documents and queries.

## Decision

- `embeddingCacheMiddleware({ store })` gives a middleware whose `wrapEmbed` reads the keys of `params.values` with one `store.get`, calls `model.doEmbed` one time with the misses only (each text once), writes the new vectors with one `store.set`, and gives the vectors in the order of `params.values`.
- The miss call keeps the call's `abortSignal`, `headers` and `providerOptions`. A call whose texts all hit calls no model.
- Every call is cached. A host that does not want its queries cached wraps only its document model.
- `usage` counts the tokens of the miss call only; a full hit reports 0 tokens. `response`, `providerMetadata` and `warnings` come from the miss call; a full hit has none.
- An error of the model or of the store reaches the caller as it is. A failed model call writes nothing.

## Consequences

- Each `embed` and `embedMany` call through the wrapped model uses the cache, with no change at the call site.
- The AI SDK splits a large `embedMany` into calls of `maxEmbeddingsPerCall`; the middleware sees each of them.

# The embedding cache decorates the model, and lives outside this package

Status: accepted by Ezz on 2026-11-18 ("Accept (Recommended)").

Three places call the model only for text that they did not embed before, under a content key: `@deepagents/retrieval` (`stores/cid.ts`, the sha256 of the text), `@zukhruf/embeddings` (the sha256 of `[provider, modelId, text]`, its ADR 0002) and `@zukhruf/vector-decisions` (`src/reader/vector-cache.ts`, the same key, backlog #4375). Backlog #3134 waits to extract it. The cache uses no vector math and no SQL form: it maps a text to the vector that a model made.

## Considered Options

| System       | Where the cache is                                                                                                                                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| .NET         | [`Microsoft.Extensions.AI`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.ai.cachingembeddinggenerator-2): `CachingEmbeddingGenerator<TInput, TEmbedding>` with `GetCacheKey`, and `DistributedCachingEmbeddingGenerator`. Both decorate the embedding generator; neither is in `VectorData` or `TensorPrimitives` |
| AI SDK 7     | `wrapEmbeddingModel({ model, middleware })`, where `wrapEmbed({ doEmbed, params, model })` can answer `params.values` from a cache and call `model.doEmbed` for the others (`EmbeddingModelV4Middleware`, checked on 2026-11-18)                                                                                                       |
| This package | It has no model and no storage                                                                                                                                                                                                                                                                                                         |

## Decision

- The embedding cache is not in `@zukhruf/vectors`. It is a decorator of the AI SDK embedding model, after .NET's caching embedding generator, in its own package on its own paper.
- A program that embeds wraps its model one time. Each `embed` and `embedMany` call through the wrapped model then uses the cache.

## Consequences

- `@zukhruf/vectors` keeps no dependency on `ai`.
- Backlog #3134 and #4375 move to the paper of the cache package.

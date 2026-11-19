# @zukhruf/embedding-cache

> Ezz accepted each ADR on 2026-11-19. Built and tested, not yet on npm.

A model call is the slow and paid part of an embedding. This package wraps an AI SDK embedding model so that each `embed` and `embedMany` call through it calls the model only for text that it did not embed before. A hit gives back exactly the numbers that the model gave the first time.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/embedding-cache ai
```

```ts
import { embedMany, wrapEmbeddingModel } from 'ai';

import { embeddingCacheMiddleware } from '@zukhruf/embedding-cache';
import { SqliteEmbeddingCacheStore } from '@zukhruf/embedding-cache/sqlite';

const model = wrapEmbeddingModel({
  model: openai.embedding('text-embedding-3-small'),
  middleware: embeddingCacheMiddleware({
    store: new SqliteEmbeddingCacheStore({
      database,
      table: 'embedding_cache',
    }),
  }),
});

const { embeddings } = await embedMany({ model, values: texts });
// Only the texts that the store does not hold reach OpenAI.
```

A model with other prompts for documents and for queries is two wrapped models with two model ids; their keys never meet ([ADR 0003](./docs/adr/0003-the-key-is-the-sha256-of-the-provider-the-model-id-the-provider-options-and-the-text.md)).

### Keep the cache in SQL Server

```ts
import { SqlServerEmbeddingCacheStore } from '@zukhruf/embedding-cache/sqlserver';

const store = new SqlServerEmbeddingCacheStore({
  table: 'dbo.embedding_cache',
  session: {
    async query(sql, parameters) {
      const request = pool.request();
      for (const [name, value] of Object.entries(parameters))
        request.input(name, value);
      return (await request.query(sql)).recordset;
    },
  },
});
```

## API

```ts
// @zukhruf/embedding-cache
function embeddingCacheMiddleware(options: {
  store: EmbeddingCacheStore;
}): EmbeddingModelMiddleware;

interface EmbeddingCacheStore {
  get(keys: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>>; // only the keys it holds
  set(entries: ReadonlyMap<string, readonly number[]>): Promise<void>;
}
class MemoryEmbeddingCacheStore implements EmbeddingCacheStore {}

// @zukhruf/embedding-cache/sqlite
class SqliteEmbeddingCacheStore implements EmbeddingCacheStore {
  constructor(options: { database: DatabaseSync; table: string });
}

// @zukhruf/embedding-cache/sqlserver
class SqlServerEmbeddingCacheStore implements EmbeddingCacheStore {
  constructor(options: { session: SqlServerSession; table: string });
}
```

## What a call does underneath

| Step   | What happens                                                                                                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key    | sha256 of the JSON array `[model.provider, model.modelId, params.providerOptions ?? null, params.dimensions ?? null, text]`, for each text                                             |
| Read   | one `store.get` with the keys of the call                                                                                                                                              |
| Embed  | one `model.doEmbed` with the misses only, each text once, with the `abortSignal`, `headers`, `providerOptions` and `dimensions` of the call. A call whose texts all hit calls no model |
| Write  | one `store.set` with the new vectors, as the model gave them                                                                                                                           |
| Answer | the vectors in the order of the texts; `usage` counts the tokens of the miss call only, so a full hit reports 0                                                                        |

| Store                          | Where a vector lives                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MemoryEmbeddingCacheStore`    | a `Map` in the process                                                                                                                                                                                                  |
| `SqliteEmbeddingCacheStore`    | `key TEXT PRIMARY KEY, vector BLOB`: the float64 values, little-endian                                                                                                                                                  |
| `SqlServerEmbeddingCacheStore` | `[key] CHAR(64) PRIMARY KEY, vector VARBINARY(MAX)`: the same bytes. Not the `VECTOR` type, which keeps float32 or float16 and would round ([ADR 0004](./docs/adr/0004-a-hit-gives-the-numbers-that-the-model-gave.md)) |

## Errors

An error of the model, of `store.get` or of `store.set` reaches the caller as it is. A failed model call writes nothing.

## The same concepts in other systems

| This package               | .NET `Microsoft.Extensions.AI`                                                          | LangChain.js                                                             |
| -------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `embeddingCacheMiddleware` | `CachingEmbeddingGenerator<TInput, TEmbedding>`, `DistributedCachingEmbeddingGenerator` | `CacheBackedEmbeddings.fromBytesStore(underlying, store, { namespace })` |
| the key                    | `GetCacheKey(ReadOnlySpan<object?> values)`                                             | `namespace + sha256(text)`                                               |
| `EmbeddingCacheStore`      | `IDistributedCache`                                                                     | a byte store with `mget` and `mset`                                      |
| every call is cached       | every call is cached                                                                    | documents only; `embedQuery` is not cached                               |

## Why not an npm package

Checked on 2026-11-19: npm has no embedding cache for the AI SDK (searches "ai sdk embedding cache middleware", "embedding cache wrapEmbeddingModel", "cache embeddings content hash"). LangChain's `CacheBackedEmbeddings` decorates LangChain's own `Embeddings`, not an AI SDK model.

## Who moves onto it

| Program                     | Its copy today                                                        | After                                                                                                    |
| --------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@zukhruf/vector-decisions` | `src/reader/vector-cache.ts` (#4375)                                  | the middleware and `SqliteEmbeddingCacheStore`                                                           |
| `@zukhruf/embeddings`       | `Collection` compares the hash of `[provider, modelId, text]` (#3134) | wraps its model; dropping the hash column of its table is its own migration                              |
| `@deepagents/retrieval`     | `cid`, the sha256 of a document                                       | stays: it decides whether a document changed before it is split, and its embedder is not an AI SDK model |

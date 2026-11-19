import { hash } from 'node:crypto';

import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  EmbeddingModelV4Middleware,
} from '@ai-sdk/provider';

/**
 * Where the cache keeps each key and its vector. A host can write one over
 * its own table: the middleware needs nothing more.
 */
export interface EmbeddingCacheStore {
  /** Gives the vector of each key that the store holds; a key it does not hold is absent. */
  get(keys: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>>;
  /** Keeps each vector under its key. */
  set(entries: ReadonlyMap<string, readonly number[]>): Promise<void>;
}

/**
 * A middleware for `wrapEmbeddingModel` of the AI SDK. Each call reads the
 * keys of its texts with one `store.get`, calls the model one time with the
 * misses only, each text once, and writes their vectors with one `store.set`.
 * A call whose texts all hit calls no model.
 */
export function embeddingCacheMiddleware({
  store,
}: {
  store: EmbeddingCacheStore;
}): EmbeddingModelV4Middleware {
  return {
    specificationVersion: 'v4',
    async wrapEmbed({ params, model }) {
      const keys = params.values.map((text) => cacheKey(model, params, text));
      const hits = await store.get(keys);
      const misses = new Map(
        keys.flatMap((key, index) =>
          hits.has(key) ? [] : [[key, params.values[index]!] as const],
        ),
      );
      const inOrder = (vectors: ReadonlyMap<string, readonly number[]>) =>
        keys.map((key) => [...vectors.get(key)!]);

      if (misses.size === 0)
        return {
          embeddings: inOrder(hits),
          usage: { tokens: 0 },
          warnings: [],
        };

      const result = await model.doEmbed({
        ...params,
        values: [...misses.values()],
      });
      const missKeys = [...misses.keys()];
      if (result.embeddings.length !== missKeys.length)
        throw new Error(
          `The model gave ${result.embeddings.length} vectors for ${missKeys.length} texts.`,
        );
      // The check above gives each vector of the model one key of a miss.
      const fresh = new Map(
        result.embeddings.map((vector, index) => [missKeys[index]!, vector]),
      );
      await store.set(fresh);

      return { ...result, embeddings: inOrder(new Map([...hits, ...fresh])) };
    },
  };
}

function cacheKey(
  model: EmbeddingModelV4,
  params: EmbeddingModelV4CallOptions,
  text: string,
): string {
  return hash(
    'sha256',
    JSON.stringify([
      model.provider,
      model.modelId,
      params.providerOptions ?? null,
      params.dimensions ?? null,
      text,
    ]),
  );
}

/** Keeps each vector in a `Map` of the process. */
export class MemoryEmbeddingCacheStore implements EmbeddingCacheStore {
  readonly #entries = new Map<string, readonly number[]>();

  async get(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, readonly number[]>> {
    return new Map(
      keys.flatMap((key) => {
        const vector = this.#entries.get(key);
        return vector === undefined ? [] : [[key, vector] as const];
      }),
    );
  }

  async set(entries: ReadonlyMap<string, readonly number[]>): Promise<void> {
    for (const [key, vector] of entries)
      if (!this.#entries.has(key)) this.#entries.set(key, [...vector]);
  }
}

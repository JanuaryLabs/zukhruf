import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { PreparedRow } from '../../create-dataloaders.ts';
import { zipStrictMismatch } from '../../dependencies/python.ts';
import type {
  BatchedInput,
  Embeddings,
  PromptType,
} from '../../types/encoder-io.ts';
import {
  type ModelMeta,
  mergePrecisionIntoExperimentKwargs,
  serializeExperimentKwargsToName,
} from '../model-meta.ts';
import type { EncodeOptions, EncoderProtocol } from '../models-protocols.ts';
import { selectLoaderRows } from '../search-wrappers.ts';
import type {
  CacheBackend,
  CacheBackendProtocol,
} from './cache-backend-protocol.ts';
import { NumpyCache } from './cache-backends/numpy-cache.ts';

// mteb/models/cache_wrappers/cache_wrapper.py, for text.

const EXPERIMENTS_FOLDER_NAME = 'experiments';

// MTEB passes no batch size to the dataloader of the misses, so it batches
// them by the default of create_dataloader.
const MISSES_BATCH_SIZE = 32;

// An encoder that keeps the embedding of each text in a folder, and embeds
// only the texts that the folder does not hold. The folder of a task is
// <cachePath>/<task name>[/experiments/<experiment name>][/<prompt type>].
// The name of the model is not in the path: give each model its own folder.
export class CachedEmbeddingWrapper implements EncoderProtocol {
  readonly cachePath: string;
  readonly cacheBackend: CacheBackend;
  readonly cacheDict = new Map<string, CacheBackendProtocol>();
  readonly #model: EncoderProtocol;

  constructor(
    model: EncoderProtocol,
    cachePath: string,
    cacheBackend: CacheBackend = (directory) => new NumpyCache(directory),
  ) {
    this.#model = model;
    this.cachePath = cachePath;
    mkdirSync(this.cachePath, { recursive: true });
    this.cacheBackend = cacheBackend;
  }

  get mtebModelMeta(): ModelMeta {
    return this.#model.mtebModelMeta;
  }

  async encode(
    inputs: readonly BatchedInput[],
    options: EncodeOptions,
  ): Promise<Embeddings> {
    const cache = this.#getOrCreateCache(
      options.taskMetadata.name,
      options.promptType ?? null,
      options,
    );
    const allItems = loaderDataset(inputs);
    // cached_vectors and newly_encoded of MTEB, in one map.
    const vectors = new Map<number, Float32Array>();
    const uncachedItems: PreparedRow[] = [];
    const uncachedIndices: number[] = [];
    for (const [index, item] of allItems.entries()) {
      const vector = cache.getVector(item);
      if (vector !== null) vectors.set(index, vector);
      else {
        uncachedItems.push(item);
        uncachedIndices.push(index);
      }
    }
    if (uncachedItems.length > 0) {
      // MTEB 2.26.28 (mteb/models/cache_wrappers/cache_wrapper.py:121-137)
      // gives the misses to create_dataloader again. The rows are prepared
      // already, so a document gets its title twice ("T T one") and a query
      // its instruction twice, under the key of the text that was prepared
      // once. Here the model gets the prepared rows, as without the cache.
      const newVectors = await this.#model.encode(
        selectLoaderRows(allItems, uncachedIndices, MISSES_BATCH_SIZE),
        options,
      );
      cache.add(uncachedItems, newVectors);
      cache.save();
      for (const [position, vector] of newVectors.entries()) {
        const index = uncachedIndices[position];
        if (index === undefined) break;
        vectors.set(index, vector);
      }
      const mismatch = zipStrictMismatch([
        newVectors.length,
        uncachedIndices.length,
      ]);
      if (mismatch !== null) throw new Error(mismatch);
    }
    return allItems.map((_, index) => {
      const vector = vectors.get(index);
      if (vector === undefined) throw new Error(`KeyError: ${index}`);
      return vector;
    });
  }

  // The settings that change the embeddings: the experiment arguments of the
  // model and the precision of the call.
  #experimentName(options: EncodeOptions): string | null {
    return serializeExperimentKwargsToName(
      mergePrecisionIntoExperimentKwargs(
        this.mtebModelMeta.experimentKwargs,
        options,
      ),
    );
  }

  #getOrCreateCache(
    taskName: string,
    promptType: PromptType | null,
    options: EncodeOptions,
  ): CacheBackendProtocol {
    const experimentName = this.#experimentName(options);
    const cacheKey = JSON.stringify([taskName, promptType, experimentName]);
    const existing = this.cacheDict.get(cacheKey);
    if (existing !== undefined) return existing;
    const cache = this.cacheBackend(
      join(
        this.cachePath,
        taskName,
        ...(experimentName === null
          ? []
          : [EXPERIMENTS_FOLDER_NAME, experimentName]),
        ...(promptType === null ? [] : [promptType]),
      ),
    );
    cache.load();
    this.cacheDict.set(cacheKey, cache);
    return cache;
  }

  close(): void {
    for (const cache of this.cacheDict.values()) cache.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  similarity(embeddings1: Embeddings, embeddings2: Embeddings): Float32Array[] {
    return this.#model.similarity(embeddings1, embeddings2);
  }

  similarityPairwise(
    embeddings1: Embeddings,
    embeddings2: Embeddings,
  ): Float32Array {
    return this.#model.similarityPairwise(embeddings1, embeddings2);
  }
}

// inputs.dataset: the rows of the batches, each column of a batch back in
// its rows.
function loaderDataset(inputs: readonly BatchedInput[]): PreparedRow[] {
  return inputs.flatMap((batch) =>
    batch.text.map((text, index) => ({
      ...Object.fromEntries(
        Object.entries(batch).map(([key, values]) => [key, values[index]]),
      ),
      text,
    })),
  );
}

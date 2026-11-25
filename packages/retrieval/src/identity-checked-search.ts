import { type EmbeddingModel, embed, embedMany } from 'ai';

import { mean } from '@zukhruf/statistics';
import { DimensionMismatchError } from '@zukhruf/vectors';

import { type ModelIdentity, modelName } from './model-identity.ts';
import { ModelMismatchError } from './model-mismatch-error.ts';
import type { StoredPassage } from './passage.ts';
import { type QueryType, embeddingsOf } from './query-bundle.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import type { ScoredPassage } from './scored-passage.ts';

/** What the engine gives: the query model, its read of the stored identities, and its search. */
type Engine<P extends StoredPassage> = {
  readonly model: EmbeddingModel;
  /** The identities of the stored vectors, in the byte order of their text. */
  readonly storedIdentities: () =>
    readonly ModelIdentity[] | Promise<readonly ModelIdentity[]>;
  /** One search for every query vector, among the vectors of the identity. */
  readonly search: (
    vectors: readonly (readonly number[])[],
    identity: ModelIdentity,
    options: RetrieveOptions<P>,
  ) => ScoredPassage<P>[][] | Promise<ScoredPassage<P>[][]>;
};

/**
 * The steps that an embedding retriever of each engine takes around its own
 * search (ADR 0010): no stored vectors give one empty list for each query and
 * no model call; a query model of another provider or model id fails with
 * ModelMismatchError before the model call; a query vector whose dimensions
 * no stored identity of that model has fails with DimensionMismatchError
 * after it, and so do texts of one query whose vectors have different
 * dimensions. The engine reads the stored identities and runs the search.
 * Each query is embedded as its `customEmbeddings`, or as its `query` when
 * it has none, and several texts search with the mean of their vectors, as
 * LlamaIndex's vector retriever does (ADR 0013).
 */
export class IdentityCheckedSearch<P extends StoredPassage> {
  readonly #engine: Engine<P>;

  constructor(engine: Engine<P>) {
    this.#engine = engine;
  }

  async retrieve(
    query: QueryType,
    options: RetrieveOptions<P>,
  ): Promise<ScoredPassage<P>[]> {
    const [text, ...more] = embeddingsOf(query);
    const [passages] = await this.#retrieve(1, options, async (abortSignal) => {
      const signal = abortSignal === undefined ? {} : { abortSignal };
      if (more.length === 0) {
        const { embedding } = await embed({
          model: this.#engine.model,
          value: text,
          ...signal,
        });
        return [embedding];
      }
      const { embeddings } = await embedMany({
        model: this.#engine.model,
        values: [text, ...more],
        ...signal,
      });
      return [meanVector(embeddings)];
    });
    return passages ?? [];
  }

  async retrieveMany(
    queries: readonly QueryType[],
    options: RetrieveOptions<P>,
  ): Promise<ScoredPassage<P>[][]> {
    if (queries.length === 0) return [];
    const texts = queries.map(embeddingsOf);
    return this.#retrieve(queries.length, options, async (abortSignal) => {
      const { embeddings } = await embedMany({
        model: this.#engine.model,
        values: texts.flat(),
        ...(abortSignal === undefined ? {} : { abortSignal }),
      });
      const vectors = embeddings.values();
      return texts.map(({ length }) =>
        meanVector(vectors.take(length).toArray()),
      );
    });
  }

  async #retrieve(
    count: number,
    options: RetrieveOptions<P>,
    embedQueries: (abortSignal?: AbortSignal) => Promise<readonly number[][]>,
  ): Promise<ScoredPassage<P>[][]> {
    options.abortSignal?.throwIfAborted();
    const query = modelName(this.#engine.model);
    const stored = await this.#engine.storedIdentities();
    const [first] = stored;
    if (first === undefined) return Array.from({ length: count }, () => []);
    const sameModel = stored.filter(
      ({ provider, modelId }) =>
        provider === query.provider && modelId === query.modelId,
    );
    const [nearest] = sameModel;
    if (nearest === undefined) {
      throw new ModelMismatchError(
        { provider: first.provider, modelId: first.modelId },
        query,
      );
    }

    const vectors = await embedQueries(options.abortSignal);
    options.abortSignal?.throwIfAborted();
    const dimensions = vectors[0]?.length ?? 0;
    const identity = sameModel.find(
      (candidate) => candidate.dimensions === dimensions,
    );
    if (identity === undefined) {
      throw new DimensionMismatchError(nearest.dimensions, dimensions);
    }
    return this.#engine.search(vectors, identity, options);
  }
}

/**
 * The mean of vectors of one length, component by component, as LlamaIndex's
 * `mean_agg` takes `np.array(embeddings).mean(axis=0)`, which also refuses
 * vectors of different lengths. A model that gives them is broken, so the
 * mean fails with DimensionMismatchError, the first vector's length as
 * `expected` (ADR 0010).
 */
function meanVector(vectors: readonly (readonly number[])[]): number[] {
  const [first = []] = vectors;
  const other = vectors.find(({ length }) => length !== first.length);
  if (other !== undefined) {
    throw new DimensionMismatchError(first.length, other.length);
  }
  return first.map((_, index) =>
    mean(vectors.map((vector) => vector[index] ?? 0)),
  );
}

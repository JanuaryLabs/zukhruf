import { type EmbeddingModel, embed, embedMany } from 'ai';

import { mean } from '@zukhruf/statistics';
import { DimensionMismatchError } from '@zukhruf/vectors';

import {
  type CheckedRetrieveOptions,
  asksForNoPassages,
  callTopK,
} from './count.ts';
import { type ModelIdentity, modelName } from './model-identity.ts';
import { ModelMismatchError } from './model-mismatch-error.ts';
import type { StoredPassage } from './passage.ts';
import { type QueryType, embeddingsOf } from './query-bundle.ts';
import type { RetrieveOptions } from './retrieve-options.ts';
import { ScoreThreshold } from './score-threshold.ts';
import type { ScoredPassage } from './scored-passage.ts';

/** What the engine gives: the query model, its read of the stored identities, and its search. */
type Engine<P extends StoredPassage> = {
  readonly model: EmbeddingModel;
  /** The identities of the stored vectors, in the byte order of their text. */
  readonly storedIdentities: (
    signal: AbortSignal | undefined,
  ) => readonly ModelIdentity[] | Promise<readonly ModelIdentity[]>;
  /** One search for every query vector, among the vectors of the identity. */
  readonly search: (
    vectors: readonly (readonly number[])[],
    identity: ModelIdentity,
    options: CheckedRetrieveOptions<P>,
  ) => ScoredPassage<P>[][] | Promise<ScoredPassage<P>[][]>;
  /** The least score that a passage of a list keeps: every passage when undefined (ADR 0019). */
  readonly scoreThreshold: number | undefined;
};

/**
 * The steps that an embedding retriever of each engine takes around its own
 * search (ADR 0010): no stored vectors give one empty list for each query and
 * no model call; a query model of another provider or model id fails with
 * ModelMismatchError before the model call; a topK of 0 gives one empty
 * list for each query after that check, with no model call and no search;
 * a query vector whose dimensions no stored identity of that model has fails
 * with DimensionMismatchError after it, and so do texts of one query whose
 * vectors have different dimensions. The engine reads the stored identities
 * and runs the search; with a `scoreThreshold`, each list then keeps the
 * passages whose score is at least it, the score that the caller gets (ADR
 * 0019). Each query is embedded as its `customEmbeddings`, or as its `query`
 * when it has none, and several texts search with the mean of their vectors,
 * as LlamaIndex's vector retriever does (ADR 0013). A text of no word to
 * embed is a `RangeError` (`embeddingsOf`) before the stored identities are
 * read or the model is called.
 */
export class IdentityCheckedSearch<P extends StoredPassage> {
  readonly #engine: Engine<P>;
  readonly #threshold: ScoreThreshold;

  constructor(engine: Engine<P>) {
    this.#threshold = ScoreThreshold.of(engine.scoreThreshold);
    this.#engine = engine;
  }

  async retrieve(
    query: QueryType,
    options: RetrieveOptions<P>,
  ): Promise<ScoredPassage<P>[]> {
    const checked = { ...options, topK: callTopK(options.topK) };
    const [text, ...more] = embeddingsOf(query);
    const [passages] = await this.#retrieve(1, checked, async (signal) => {
      if (more.length === 0) {
        const { embedding } = await embed({
          model: this.#engine.model,
          value: text,
          ...aiSignal(signal),
        });
        return [embedding];
      }
      const { embeddings } = await embedMany({
        model: this.#engine.model,
        values: [text, ...more],
        ...aiSignal(signal),
      });
      return [meanVector(embeddings)];
    });
    return passages ?? [];
  }

  async retrieveMany(
    queries: readonly QueryType[],
    options: RetrieveOptions<P>,
  ): Promise<ScoredPassage<P>[][]> {
    const checked = { ...options, topK: callTopK(options.topK) };
    if (queries.length === 0) return [];
    const texts = queries.map(embeddingsOf);
    return this.#retrieve(queries.length, checked, async (signal) => {
      const { embeddings } = await embedMany({
        model: this.#engine.model,
        values: texts.flat(),
        ...aiSignal(signal),
      });
      const vectors = embeddings.values();
      return texts.map(({ length }) =>
        meanVector(vectors.take(length).toArray()),
      );
    });
  }

  async #retrieve(
    count: number,
    options: CheckedRetrieveOptions<P>,
    embedQueries: (
      signal: AbortSignal | undefined,
    ) => Promise<readonly number[][]>,
  ): Promise<ScoredPassage<P>[][]> {
    const { signal } = options;
    signal?.throwIfAborted();
    const query = modelName(this.#engine.model);
    const stored = await this.#engine.storedIdentities(signal);
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
    // A topK of 0 gives no passages, so the paid model call and the search
    // would reach no caller; the cheap read of the stored identities still
    // refuses a model of the wrong provider (ADR 0023).
    if (asksForNoPassages(options.topK))
      return Array.from({ length: count }, () => []);

    const vectors = await embedQueries(signal);
    signal?.throwIfAborted();
    const dimensions = vectors[0]?.length ?? 0;
    const identity = sameModel.find(
      (candidate) => candidate.dimensions === dimensions,
    );
    if (identity === undefined) {
      throw new DimensionMismatchError(nearest.dimensions, dimensions);
    }
    const lists = await this.#engine.search(vectors, identity, options);
    return lists.map((passages) => this.#threshold.keep(passages));
  }
}

/** The AI SDK names the signal `abortSignal`. */
const aiSignal = (
  signal: AbortSignal | undefined,
): { readonly abortSignal?: AbortSignal } =>
  signal === undefined ? {} : { abortSignal: signal };

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

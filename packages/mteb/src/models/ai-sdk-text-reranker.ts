import { type RerankingModel, rerank } from 'ai';

import type { BatchedInput } from '../types/encoder-io.ts';
import type { ModelMeta } from './model-meta.ts';
import type {
  CrossEncoderProtocol,
  PredictOptions,
} from './models-protocols.ts';

// The part that MTEB's cross-encoders over text models share, with an AI SDK
// reranking model in place of a model in memory or an HTTP client: each pair
// goes to the model in a call of its own, and the score comes back as
// float32. A subclass gives the query and the document of each pair.
export abstract class AiSdkTextReranker implements CrossEncoderProtocol {
  readonly mtebModelMeta: ModelMeta;
  readonly #model: Exclude<RerankingModel, string>;
  readonly #maxRetries: number;

  constructor(options: {
    // A model object. A model id string goes through the global default
    // provider, so the cross-encoder could not name its provider.
    readonly model: Exclude<RerankingModel, string>;
    readonly modelMeta: ModelMeta;
    // The retries of a failed call. MTEB makes 3 attempts.
    readonly maxRetries?: number;
  }) {
    this.#model = options.model;
    this.mtebModelMeta = options.modelMeta;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  // The query and the document that the model scores for each pair.
  protected abstract pairs(
    inputs1: readonly BatchedInput[],
    inputs2: readonly BatchedInput[],
    options: PredictOptions,
  ): [query: string, document: string][];

  // The calls go one after the other. A server that gets calls at the same
  // time can score them in one batch, and a batch changes the scores.
  async predict(
    inputs1: readonly BatchedInput[],
    inputs2: readonly BatchedInput[],
    options: PredictOptions,
  ): Promise<Float32Array> {
    const pairs = this.pairs(inputs1, inputs2, options);
    const scores = new Float32Array(pairs.length);
    for (const [index, [query, document]] of pairs.entries())
      scores[index] = await this.#score(query, document);
    return scores;
  }

  async #score(query: string, document: string): Promise<number> {
    const { ranking } = await rerank({
      model: this.#model,
      documents: [document],
      query,
      maxRetries: this.#maxRetries,
    });
    const [first] = ranking;
    if (ranking.length !== 1 || first === undefined)
      throw new Error(
        `Incomplete ranking from server: expected 1 score, got ${ranking.length}.`,
      );
    return first.score;
  }
}

// The pairs of the items at the same index, for lists that a subclass has
// checked to be of equal length.
export function pairUp(
  queries: readonly string[],
  documents: readonly string[],
): [query: string, document: string][] {
  return queries.flatMap((query, index) => {
    const document = documents[index];
    return document === undefined ? [] : [[query, document]];
  });
}

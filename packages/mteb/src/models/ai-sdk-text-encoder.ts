import { type EmbeddingModel, embedMany } from 'ai';

import type { BatchedInput, Embeddings } from '../types/encoder-io.ts';
import { AbsEncoder } from './abs-encoder.ts';
import type { ModelMeta } from './model-meta.ts';
import type { EncodeOptions } from './models-protocols.ts';

// The part that MTEB's encoders over text models share, with an AI SDK
// embedding model in place of a SentenceTransformer or an HTTP client: the
// texts go to the model in batches, the embeddings come back as float32, and
// the tokens that the provider reports add up. A subclass gives the text of
// each input, with its prompt or template.
export abstract class AiSdkTextEncoder extends AbsEncoder {
  readonly mtebModelMeta: ModelMeta;
  readonly #model: Exclude<EmbeddingModel, string>;
  readonly #maxRetries: number;
  #tokens = 0;

  constructor(options: {
    // A model object. A model id string goes through the global default
    // provider, so the encoder could not name its provider.
    readonly model: Exclude<EmbeddingModel, string>;
    readonly modelMeta: ModelMeta;
    // The retries of a failed call. MTEB makes 3 attempts.
    readonly maxRetries?: number;
  }) {
    super();
    this.#model = options.model;
    this.mtebModelMeta = options.modelMeta;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  // The tokens that the provider reported for all calls so far.
  get tokens(): number {
    return this.#tokens;
  }

  // The text that the model embeds for each input of the batches.
  protected abstract texts(
    inputs: readonly BatchedInput[],
    options: EncodeOptions,
  ): string[];

  async encode(
    inputs: readonly BatchedInput[],
    options: EncodeOptions,
  ): Promise<Embeddings> {
    const texts = this.texts(inputs, options);
    const batchSize = options.batchSize ?? 32;
    const embeddings: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += batchSize)
      embeddings.push(
        ...(await this.#embed(texts.slice(start, start + batchSize))),
      );
    return embeddings;
  }

  async #embed(texts: readonly string[]): Promise<Float32Array[]> {
    const result = await embedMany({
      model: this.#model,
      values: [...texts],
      maxRetries: this.#maxRetries,
    });
    if (result.embeddings.length !== texts.length)
      throw new Error(
        `Incomplete embeddings from server: expected ${texts.length} embeddings, got ${result.embeddings.length}.`,
      );
    this.#tokens += result.usage.tokens;
    return result.embeddings.map((embedding) => Float32Array.from(embedding));
  }
}

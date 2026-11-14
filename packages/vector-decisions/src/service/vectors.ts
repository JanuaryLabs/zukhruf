import { type EmbeddingModel, embedMany } from 'ai';

import { ContractError } from './contract-error.ts';
import type { State } from './decision.ts';

const MAX_TEXT = 32_768;
// The norm at which Venn takes a vector for zero.
const NORM_EPSILON = 1e-12;

// A text that the reader embeds, or a vector that a request gives.
export type Source =
  { readonly text: string } | { readonly vector: Float32Array };

// The vectors of a state, by where they come from.
export type StateVectors =
  | { readonly from: 'text'; readonly vector: Float32Array }
  | { readonly from: 'vector'; readonly vector: Float32Array }
  | { readonly from: 'texts'; readonly rows: readonly Float32Array[] };

// The vectors of the values of a request: Venn's DecisionService.vector
// (venn/server.py:281) checks each value, and the reader embeds the texts.
export class Vectors {
  readonly #reader: EmbeddingModel;
  readonly #width: number;

  constructor(reader: EmbeddingModel, width: number) {
    this.#reader = reader;
    this.#width = width;
  }

  async state(state: State): Promise<StateVectors> {
    if (typeof state === 'string' || 'text' in state) {
      const text = typeof state === 'string' ? state : state.text;
      const [vector = new Float32Array()] = await this.resolve([
        this.source(text),
      ]);
      return { from: 'text', vector };
    }
    if ('texts' in state)
      return {
        from: 'texts',
        rows: await this.resolve(state.texts.map((text) => this.source(text))),
      };
    return { from: 'vector', vector: this.#given(state.vector) };
  }

  // A text that the reader embeds, as Venn's embed checks it
  // (venn/server.py:147), or a given vector.
  source(value: string | readonly number[]): Source {
    if (typeof value !== 'string') return { vector: this.#given(value) };
    // Python's len counts code points, and a code point above U+FFFF is two
    // code units of JavaScript.
    if (
      value === '' ||
      (value.length > MAX_TEXT && [...value].length > MAX_TEXT)
    )
      throw new ContractError(
        'invalid_text',
        `Text must contain 1..${MAX_TEXT} characters`,
      );
    return { text: value };
  }

  // The vector of each source, in order. The reader embeds all texts in one
  // call.
  async resolve(sources: readonly Source[]): Promise<Float32Array[]> {
    const texts = sources.flatMap((source) =>
      'text' in source ? [source.text] : [],
    );
    const { embeddings } = await embedMany({
      model: this.#reader,
      values: texts,
    });
    const embedded = embeddings.values();
    return sources.map((source) =>
      'vector' in source
        ? source.vector
        : Float32Array.from(embedded.next().value ?? []),
    );
  }

  // A vector of float32 values, as Venn's vector checks it
  // (venn/server.py:323-328).
  #given(values: readonly number[]): Float32Array {
    const vector = Float32Array.from(values);
    if (vector.length !== this.#width || !vector.every(Number.isFinite))
      throw new ContractError(
        'invalid_vector',
        `Expected finite ${this.#width}-dimensional vectors`,
      );
    if (Math.hypot(...vector) <= NORM_EPSILON)
      throw new ContractError(
        'zero_vector',
        'Zero vectors are not valid embeddings',
      );
    return vector;
  }
}

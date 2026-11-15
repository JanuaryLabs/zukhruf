import { type EmbeddingModel, embedMany } from 'ai';

import { ContractError } from './contract-error.ts';
import type { IndexState, IndexValue, State } from './decision.ts';

const MAX_TEXT = 32_768;
// The most rows of a plural state.
const MAX_ROWS = 512;
// The norm at which Venn takes a vector for zero.
const NORM_EPSILON = 1e-12;

// A text that the reader embeds, or a vector that a request gives.
export type Source =
  { readonly text: string } | { readonly vector: Float32Array };

// The vectors of a state, by where they come from: one vector, a row for
// each item of a plural state, or the rows of an index with their ids.
export type StateVectors =
  | { readonly from: 'text' | 'vector'; readonly vector: Float32Array }
  | {
      readonly from: 'texts' | 'vectors';
      readonly rows: readonly Float32Array[];
    }
  | {
      readonly from: 'index';
      readonly rows: readonly Float32Array[];
      readonly ids: readonly IndexValue[];
    };

type Texts = { readonly texts: readonly string[] };

// The vectors of the values of a request: Venn's DecisionService.vector
// (venn/server.py:281) checks each value, and the reader embeds the texts.
export class Vectors {
  readonly #reader: EmbeddingModel;
  readonly #width: number;

  constructor(reader: EmbeddingModel, width: number) {
    this.#reader = reader;
    this.#width = width;
  }

  async state(state: Exclude<State, IndexState>): Promise<StateVectors> {
    if (typeof state === 'string') return this.#text(state);
    if (state.texts !== undefined)
      return { from: 'texts', rows: await this.#texts(state) };
    if (state.text !== undefined) return this.#text(state.text);
    if (state.vector !== undefined)
      return { from: 'vector', vector: this.#given(state.vector) };
    return { from: 'vectors', rows: this.rows(state.vectors, MAX_ROWS) };
  }

  async #text(text: string): Promise<StateVectors> {
    const [vector = new Float32Array()] = await this.resolve([
      this.source(text),
    ]);
    return { from: 'text', vector };
  }

  // The rows of a state of texts, as Venn's decide and vector check it
  // (venn/server.py:942-945, 296-303). Venn counts the texts first, unless
  // the state also has a text.
  async #texts(state: Extract<State, Texts>): Promise<Float32Array[]> {
    const { texts } = state;
    if (!('text' in state) && (texts.length < 1 || texts.length > MAX_ROWS))
      throw new ContractError('state_texts', `Provide 1..${MAX_ROWS} texts`);
    if (['text', 'vector', 'vectors'].some((kind) => kind in state))
      throw new ContractError('state_shape', 'Provide one kind of state');
    return this.resolve(texts.map((text) => this.source(text)));
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

  #given(values: readonly number[]): Float32Array {
    const [vector = new Float32Array()] = this.rows([values], MAX_ROWS);
    return vector;
  }

  // Rows of float32 values, at most `maxRows`, as Venn's vector checks a
  // vector or a matrix (venn/server.py:318-328): Venn takes an empty matrix
  // for a vector of no values. The rows are float32 only after the count:
  // registerIndex takes up to 1,000,000 rows, and a count over it would
  // otherwise be refused after gigabytes of copies.
  rows(
    values: readonly (readonly number[])[],
    maxRows: number,
  ): Float32Array[] {
    if (
      values.length === 0 ||
      !values.every(
        (row) =>
          row.length === this.#width &&
          row.every((value) => Number.isFinite(Math.fround(value))),
      )
    )
      throw new ContractError(
        'invalid_vector',
        `Expected finite ${this.#width}-dimensional vectors`,
      );
    if (values.length > maxRows)
      throw new ContractError(
        'state_limit',
        `At most ${maxRows} state vectors`,
      );
    const rows = values.map((row) => Float32Array.from(row));
    if (rows.some((row) => Math.hypot(...row) <= NORM_EPSILON))
      throw new ContractError(
        'zero_vector',
        'Zero vectors are not valid embeddings',
      );
    return rows;
  }
}

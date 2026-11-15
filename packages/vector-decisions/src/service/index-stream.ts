import type { PreparedQuestion } from '../head/prepared-question.ts';
import { Choice } from './choice.ts';
import { ContractError } from './contract-error.ts';
import type { IndexBatch, IndexValue } from './decision.ts';

// The limits of a stream of Venn (venn/server.py:883-885, 1068-1069).
const MAX_ROW_CAP = 1_000_000;
const MAX_BATCH_SIZE = 65_536;

// A Choice question about each of the first rowCap rows, in batches of
// batchSize rows: Venn's PreparedQuestion.stream, and the answer of each row
// with its id (venn/server.py:901-910, venn/index/apply.py:54-66). The
// default rowCap is the count of the rows.
export class IndexStream {
  readonly #threshold: number | undefined;
  readonly #temperature: number;
  readonly #rows: readonly Float32Array[];
  readonly #ids: readonly IndexValue[];
  readonly #batchSize: number;

  constructor(
    threshold: number | undefined,
    temperature: number,
    rows: readonly Float32Array[],
    ids: readonly IndexValue[],
    rowCap = rows.length,
    batchSize = MAX_BATCH_SIZE,
  ) {
    if (
      !IndexStream.#whole(rowCap, 0, MAX_ROW_CAP) ||
      !IndexStream.#whole(batchSize, 1, MAX_BATCH_SIZE)
    )
      throw new ContractError('stream_limit', 'Invalid row cap or batch size');
    this.#threshold = threshold;
    this.#temperature = temperature;
    this.#rows = rows.slice(0, rowCap);
    this.#ids = ids;
    this.#batchSize = batchSize;
  }

  // Each batch is answered when the caller reads it, as Venn's generator
  // answers it.
  *batches(
    prepared: PreparedQuestion,
    labels: readonly string[],
  ): Generator<IndexBatch, void, undefined> {
    for (let offset = 0; offset < this.#rows.length; offset += this.#batchSize)
      yield {
        offset,
        rows: this.#rows
          .slice(offset, offset + this.#batchSize)
          .map((row, index) => ({
            ...new Choice(this.#threshold, this.#temperature, row).answer(
              prepared,
              labels,
            ),
            id: this.#ids[offset + index] ?? offset + index,
          })),
      };
  }

  // A whole number from `low` to `high`, as Venn checks an int in a range.
  static #whole(value: number, low: number, high: number): boolean {
    return Number.isInteger(value) && value >= low && value <= high;
  }
}

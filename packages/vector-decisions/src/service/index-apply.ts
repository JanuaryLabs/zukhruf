import type { PreparedQuestion } from '../head/prepared-question.ts';
import { Choice } from './choice.ts';
import { ContractError } from './contract-error.ts';
import type { IndexApplyAnswer } from './decision.ts';
import type { QuestionKind } from './question-kind.ts';

// The limits of a stream of Venn, and the most rows that decide answers.
const MAX_ROW_CAP = 1_000_000;
const MAX_BATCH_SIZE = 65_536;
const MAX_ROWS = 512;

// A Choice question about each row of a plural state: the answer of a Choice
// for each of the first rowCap rows, with the index of the row as its id,
// and the count of the batches of batchSize rows that Venn's
// PreparedQuestion.stream computes (venn/server.py:1061-1079,
// venn/index/apply.py:54-66).
export class IndexApply implements QuestionKind {
  readonly #rows: readonly Choice[];
  readonly #batchSize: number;

  constructor(
    threshold: number | undefined,
    temperature: number,
    rows: readonly Float32Array[],
    rowCap: number | undefined,
    batchSize = MAX_BATCH_SIZE,
  ) {
    if (
      (rowCap !== undefined && !IndexApply.#whole(rowCap, 0, MAX_ROW_CAP)) ||
      !IndexApply.#whole(batchSize, 1, MAX_BATCH_SIZE)
    )
      throw new ContractError('stream_limit', 'Invalid row cap or batch size');
    if (rowCap !== undefined && rowCap > MAX_ROWS)
      throw new ContractError(
        'stream_required',
        `Decide answers at most ${MAX_ROWS} rows`,
        413,
      );
    this.#rows = rows
      .slice(0, rowCap)
      .map((row) => new Choice(threshold, temperature, row));
    this.#batchSize = batchSize;
  }

  answer(
    prepared: PreparedQuestion,
    labels: readonly string[],
  ): IndexApplyAnswer {
    const rows = this.#rows.map((choice, id) => ({
      ...choice.answer(prepared, labels),
      id,
    }));
    return { rows, batches: Math.ceil(rows.length / this.#batchSize) };
  }

  // A whole number from `low` to `high`, as Venn checks an int in a range.
  static #whole(value: number, low: number, high: number): boolean {
    return Number.isInteger(value) && value >= low && value <= high;
  }
}

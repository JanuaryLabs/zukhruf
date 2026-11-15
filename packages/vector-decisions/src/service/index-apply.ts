import type { PreparedQuestion } from '../head/prepared-question.ts';
import { ContractError } from './contract-error.ts';
import type { IndexApplyAnswer, IndexValue } from './decision.ts';
import { IndexStream } from './index-stream.ts';
import type { QuestionKind } from './question-kind.ts';

// The most rows that decide answers.
const MAX_ROWS = 512;

// A Choice question about each row of a plural state or an index: the rows
// of its stream, and the count of the batches (venn/server.py:1061-1079).
// The row cap is the count of the rows by default, so decide refuses an
// index of more than 512 rows without one (venn/server.py:1066, 1070).
export class IndexApply implements QuestionKind {
  readonly #stream: IndexStream;

  constructor(
    threshold: number | undefined,
    temperature: number,
    rows: readonly Float32Array[],
    ids: readonly IndexValue[],
    rowCap = rows.length,
    batchSize?: number,
  ) {
    this.#stream = new IndexStream(
      threshold,
      temperature,
      rows,
      ids,
      rowCap,
      batchSize,
    );
    if (rowCap > MAX_ROWS)
      throw new ContractError(
        'stream_required',
        `Decide answers at most ${MAX_ROWS} rows`,
        413,
      );
  }

  answer(
    prepared: PreparedQuestion,
    labels: readonly string[],
  ): IndexApplyAnswer {
    const batches = [...this.#stream.batches(prepared, labels)];
    return {
      rows: batches.flatMap((batch) => batch.rows),
      batches: batches.length,
    };
  }
}

import { createHash } from 'node:crypto';

import ssumpw from '@stdlib/blas-ext-base-ssumpw';

import { ContractError } from './contract-error.ts';
import type { IndexValue } from './decision.ts';

// The rows of an index, as unit float32 vectors, and the id of each row.
// Venn also keeps a FAISS IndexFlatIP of the rows (venn/server.py:438), which
// nothing of the library reads: decide and stream_index read the vectors.
export type Index = {
  readonly vectors: readonly Float32Array[];
  readonly ids: readonly IndexValue[];
};

// An index with an outcome for each row, which NearestReference reads.
export type LabelledIndex = Index & {
  readonly outcomes: readonly IndexValue[];
};

// The indexes that registerIndex registered, by their handle, as Venn's
// DecisionService.indexes holds them (venn/server.py:427-443, 459-463).
export class Indexes {
  readonly #indexes = new Map<string, Index | LabelledIndex>();

  // `rows` are float32 rows that Vectors checked. The handle is Venn's: the
  // SHA-256 of the bytes of the unit rows and of Python's
  // json.dumps([ids, outcomes]), so the same index gets the same handle.
  register(
    rows: readonly Float32Array[],
    ids: readonly IndexValue[],
    outcomes: readonly IndexValue[] | undefined,
  ): string {
    // Python's str() of a whole number is its digits, so 1 and "1" are one
    // id (venn/server.py:433). A fraction is refused: a number of
    // JavaScript cannot be Python's float 1.0, so its str() and its JSON
    // could not be Venn's. That rule is mine.
    if (
      ids.length !== rows.length ||
      new Set(ids.map(String)).size !== ids.length ||
      !Indexes.#areValid(ids)
    )
      throw new ContractError(
        'invalid_index',
        'Distinct IDs must match index rows',
      );
    if (
      outcomes !== undefined &&
      (outcomes.length !== ids.length || !Indexes.#areValid(outcomes))
    )
      throw new ContractError('invalid_index', 'Outcomes must match rows');
    const vectors = rows.map((row) => Indexes.#unit(row));
    const digest = createHash('sha256');
    for (const vector of vectors)
      digest.update(
        new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
      );
    digest.update(
      `[${Indexes.#pythonList(ids)}, ${outcomes === undefined ? 'null' : Indexes.#pythonList(outcomes)}]`,
    );
    const handle = digest.digest('hex');
    this.#indexes.set(
      handle,
      outcomes === undefined
        ? { vectors, ids: [...ids] }
        : { vectors, ids: [...ids], outcomes: [...outcomes] },
    );
    return handle;
  }

  index(handle: string): Index | LabelledIndex {
    const index = this.#indexes.get(handle);
    if (index === undefined)
      throw new ContractError(
        'index_handle',
        'Missing or stale index handle',
        404,
      );
    return index;
  }

  static #areValid(values: readonly IndexValue[]): boolean {
    return values.every(
      (value) => typeof value === 'string' || Number.isSafeInteger(value),
    );
  }

  // The row divided by its norm in float32, as Venn divides the rows by
  // np.linalg.norm(values, axis=1) (venn/server.py:437): the squares are
  // float32, and NumPy adds each row up with its float32 pairwise sum
  // (numpy/_core/src/umath/loops_utils.h.src, pairwise_sum), which ssumpw
  // of stdlib is. A probe of 2026-11-15 gave NumPy 2.5.4's unit rows bit for
  // bit for 6,000 of 6,000 rows (ADR 0007).
  static #unit(row: Float32Array): Float32Array {
    const squares = Float32Array.from(row, (value) => value * value);
    const norm = Math.fround(Math.sqrt(ssumpw(squares.length, squares, 1)));
    return Float32Array.from(row, (value) => value / norm);
  }

  // A list of Python's json.dumps (venn/server.py:439): ", " between items,
  // the digits of a whole number, and ensure_ascii, which writes each UTF-16
  // code unit outside printable ASCII (Lib/json/encoder.py, ESCAPE_ASCII) as
  // \uXXXX, so a character above U+FFFF is two escapes, of its surrogates: a
  // regular expression without the u flag reads code units. JSON.stringify
  // already escapes the controls below U+0020 as Python does.
  static #pythonList(values: readonly IndexValue[]): string {
    return `[${values
      .map((value) =>
        typeof value === 'number'
          ? String(value)
          : JSON.stringify(value).replaceAll(
              /[^ -~]/g,
              (unit) =>
                `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`,
            ),
      )
      .join(', ')}]`;
  }
}

import type { Comparator } from '../comparator.ts';
import type { LeafValue } from '../leaf-pair.ts';
import { JsonEquality } from './json-equality.ts';

// Two leaves agree as Python's == says: a bool is an int (True == 1 == 1.0),
// and otherwise as JSON equality says. SOB's caller gives it (evaluate.py:571).
export class PythonEquality implements Comparator {
  readonly #json = new JsonEquality();

  agrees(stated: LeafValue, expected: LeafValue): boolean {
    return this.#json.agrees(
      PythonEquality.#asInt(stated),
      PythonEquality.#asInt(expected),
    );
  }

  static #asInt(value: LeafValue): LeafValue {
    if (typeof value === 'boolean') return value ? 1n : 0n;
    return value;
  }
}
